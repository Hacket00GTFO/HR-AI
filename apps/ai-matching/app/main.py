"""ai-matching service — FastAPI entrypoint.

/v1 endpoints are protected by service_auth (X-Service-Token or X-User-*).
/health and /ready are public for orchestrators.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from prometheus_fastapi_instrumentator import Instrumentator

from .telemetry import setup_json_logging, setup_tracing

from . import store
from .auth import service_auth
from .config import get_settings
from .db import close_pools, db_alive, open_pools
from .events import consume_forever, publish_eval_run_completed, publish_score_computed
from .llm.factory import get_provider, get_redis, validate_provider_policy
from .pipeline import scoring
from .pipeline.cv_parse import parse_cv
from .pipeline.rank import rank_candidates, rank_idempotency_key
from .schemas import (
    CVParseRequest, CandidateProfile, EvalRunRequest, EvalRunResponse,
    ExplainResponse, JobAccepted, JobStatus,
    RankRequest, RankResponse, ScoreRequest, ScoreResponse, SkillEntry,
)
from .skills import get_taxonomy

logging.basicConfig(level=get_settings().log_level)
logger = logging.getLogger(__name__)

_stop_consumers: asyncio.Event | None = None
_consumer_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _stop_consumers, _consumer_task
    # Fail closed before opening any pools: production must never serve
    # through a public LLM provider.
    validate_provider_policy()
    await open_pools()
    await get_taxonomy()  # warm the skills table/seed once
    _stop_consumers = asyncio.Event()
    _consumer_task = asyncio.create_task(consume_forever(_stop_consumers))
    yield
    _stop_consumers.set()
    _consumer_task.cancel()
    try:
        await _consumer_task
    except (asyncio.CancelledError, Exception):
        pass
    await close_pools()


app = FastAPI(title='StraforAI ai-matching', version='1.0.0', lifespan=lifespan)
v1 = Depends(service_auth)
settings = get_settings()

# Initialize tracing and JSON logging before the app starts.
setup_tracing(service_name="ai-matching")
setup_json_logging(service_name="ai-matching")

# Prometheus metrics — protected by METRICS_TOKEN if set.
_instrumentator = Instrumentator(
    excluded_handlers=["/health", "/ready", "/metrics"],
    should_group_status_codes=True,
    should_ignore_untemplated=True,
)
_instrumentator.instrument(app)


@app.get('/metrics')
async def metrics(request: Request):
    token = os.environ.get("METRICS_TOKEN")
    if token:
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer ") or auth[7:] != token:
            raise HTTPException(status_code=401, detail="Unauthorized")
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST,
    )


def _correlation_id(request: Request) -> str | None:
    return request.headers.get('x-correlation-id')


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------

@app.get('/health')
async def health():
    return {'status': 'ok'}


@app.get('/ready')
async def ready():
    db_ok = await db_alive()
    redis_ok = False
    redis_client = get_redis()
    if redis_client is not None:
        try:
            redis_ok = bool(await redis_client.ping())
        except Exception:
            redis_ok = False
    provider = get_provider().state()
    body = {'db': db_ok, 'redis': redis_ok, 'provider': provider}
    ok = db_ok  # service can score without redis/broker; db is the hard dep
    if not ok:
        raise HTTPException(status_code=503, detail=body)
    return {'status': 'ready', **body}


# ---------------------------------------------------------------------------
# CV parsing
# ---------------------------------------------------------------------------

@app.post('/v1/cv/parse', dependencies=[v1], response_model=CandidateProfile)
async def cv_parse(body: CVParseRequest, request: Request):
    text = body.text
    if text is None and body.document_id is not None:
        if not settings.documents_url:
            raise HTTPException(502, 'DOCUMENTS_URL not configured — cannot fetch document')
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f'{settings.documents_url}/documents/{body.document_id}')
                resp.raise_for_status()
                data = resp.json()
                text = data.get('text') or data.get('content') or ''
        except Exception as exc:
            raise HTTPException(502, f'document fetch failed: {exc}') from exc
    if not text or not text.strip():
        raise HTTPException(422, 'Provide non-empty "text" or a resolvable "document_id"')
    provider = get_provider()
    result = await parse_cv(text, provider, correlation_id=_correlation_id(request))
    return result


# ---------------------------------------------------------------------------
# scoring
# ---------------------------------------------------------------------------

@app.post('/v1/score', dependencies=[v1], response_model=ScoreResponse)
async def score(body: ScoreRequest, request: Request):
    candidate, vacancy = body.candidate, body.vacancy
    cid = candidate.get('id', candidate.get('candidate_id'))
    vid = vacancy.get('id', vacancy.get('vacancy_id'))

    # Idempotency: a persisted row for the same versions is served fresh.
    if cid is not None and vid is not None:
        try:
            cached = await store.get_match_score(int(cid), int(vid), settings.model_version, settings.prompt_version)
            if cached is not None:
                return ScoreResponse(
                    candidate_id=cid, vacancy_id=vid, score=cached['score'],
                    subscores=cached['subscores'], explanation=cached['explanation'],
                    red_flags=(cached['explanation'] or {}).get('red_flags', []),
                    source=cached['source'], model_version=cached['model_version'],
                    prompt_version=cached['prompt_version'],
                    embedding_version=cached['embedding_version'], cached=True,
                )
        except Exception as exc:
            logger.warning('match_scores read failed (scoring anyway): %s', exc)

    provider = get_provider()
    taxonomy = await get_taxonomy()

    from .pipeline.rank import score_pair
    try:
        result = await score_pair(candidate, vacancy, taxonomy, provider, settings,
                                  correlation_id=_correlation_id(request))
    except Exception as exc:
        logger.warning('score_pair failed, falling back to pure rules: %s', exc)
        cand_skills, _ = await taxonomy.normalize_many(scoring.candidate_skills_raw(candidate))
        vac_skills, _ = await taxonomy.normalize_many(scoring.vacancy_skills_raw(vacancy))
        result = scoring.compute_match(
            candidate, vacancy,
            cand_skills=set(cand_skills), vac_skills=set(vac_skills),
            weights=settings.feature_weights,
        )
        result['candidate_id'] = cid
        result['vacancy_id'] = vid
        result['source'] = 'rule_based'

    if cid is not None and vid is not None:
        try:
            await store.upsert_match_score(
                int(cid), int(vid), result['score'], result['subscores'], result['explanation'],
                model_version=settings.model_version,
                prompt_version=settings.prompt_version,
                embedding_version=settings.embedding_version,
                source=result.get('source', 'rule_based'),
            )
        except Exception as exc:
            logger.warning('match_scores write failed: %s', exc)
        await publish_score_computed(cid, vid, result['score'], result.get('source', 'rule_based'),
                                     _correlation_id(request))

    return ScoreResponse(
        candidate_id=cid, vacancy_id=vid, score=result['score'],
        subscores=result['subscores'], explanation=result['explanation'],
        red_flags=result.get('red_flags', []),
        source=result.get('source', 'rule_based'),
        model_version=settings.model_version,
        prompt_version=settings.prompt_version,
        embedding_version=settings.embedding_version,
        budget_exceeded=getattr(provider, 'budget_exceeded', False),
    )


# ---------------------------------------------------------------------------
# ranking
# ---------------------------------------------------------------------------

@app.post('/v1/vacancies/{vacancy_id}/rank', dependencies=[v1],
          response_model=RankResponse | JobAccepted)
async def rank(vacancy_id: int, body: RankRequest, request: Request):
    vacancy = dict(body.vacancy)
    vacancy.setdefault('id', vacancy_id)
    candidates = body.candidates or []

    want_async = bool(body.async_) or len(candidates) > settings.async_rank_threshold
    if want_async:
        idem = rank_idempotency_key(vacancy, candidates, settings)
        try:
            job = await store.create_job('rank_batch', idem, {
                'vacancy_id': vacancy_id, 'candidate_count': len(candidates),
            })
        except Exception as exc:
            raise HTTPException(503, f'job store unavailable: {exc}') from exc
        try:
            from .worker import celery_app
            celery_app.send_task('ai_matching.rank_batch',
                                 args=[job['job_id'], vacancy, candidates, body.top_k])
        except Exception as exc:
            await store.update_job(job['job_id'], status='failed', error=f'enqueue failed: {exc}')
            raise HTTPException(503, f'job enqueue failed: {exc}') from exc
        return JobAccepted(job_id=job['job_id'])

    provider = get_provider()
    taxonomy = await get_taxonomy()
    result = await rank_candidates(
        vacancy, candidates, taxonomy, provider, settings,
        top_k=body.top_k, correlation_id=_correlation_id(request),
    )
    if body.min_score is not None:
        kept = [r for r in result['results'] if r['score'] >= body.min_score]
        result['below_min_score'] = [
            {'candidate_id': r['candidate_id'], 'score': r['score'], 'reason': 'below_min_score'}
            for r in result['results'] if r['score'] < body.min_score
        ]
        result['results'] = kept
        result['evaluated'] = len(kept)
    return RankResponse(**result)


@app.get('/v1/jobs/{job_id}', dependencies=[v1], response_model=JobStatus)
async def job_status(job_id: str):
    try:
        job = await store.get_job(job_id)
    except Exception as exc:
        raise HTTPException(503, f'job store unavailable: {exc}') from exc
    if job is None:
        raise HTTPException(404, 'job not found')
    return JobStatus(**job)


# ---------------------------------------------------------------------------
# explainability + taxonomy
# ---------------------------------------------------------------------------

@app.get('/v1/scores/{candidate_id}/{vacancy_id}/explain', dependencies=[v1],
         response_model=ExplainResponse)
async def explain(candidate_id: int, vacancy_id: int):
    try:
        row = await store.get_match_score(candidate_id, vacancy_id,
                                          settings.model_version, settings.prompt_version)
    except Exception as exc:
        raise HTTPException(503, f'score store unavailable: {exc}') from exc
    if row is None:
        raise HTTPException(404, 'no score persisted for this pair/version')
    return ExplainResponse(
        candidate_id=candidate_id, vacancy_id=vacancy_id, score=row['score'],
        subscores=row['subscores'], explanation=row['explanation'],
        source=row['source'], model_version=row['model_version'],
        created_at=row['created_at'],
    )


# ---------------------------------------------------------------------------
# evaluation harness
# ---------------------------------------------------------------------------

@app.post('/v1/eval/run', dependencies=[v1], response_model=EvalRunResponse)
async def eval_run(body: EvalRunRequest, request: Request):
    """Run one evaluation scorer over a bounded synthetic dataset.

    Admin/CI convenience endpoint — the full harness lives in the
    `evaluation` package (`python -m evaluation.runner` runs all baselines
    and renders docs/eval/latest.md). Requires the package to be present in
    the image; returns 501 otherwise.
    """
    try:
        from evaluation.baselines import get_scorer
        from evaluation.dataset import generate
        from evaluation.runner import run_dataset
    except ImportError:
        raise HTTPException(501, 'evaluation package not installed in this image')
    try:
        scorer = get_scorer(body.scorer)
    except KeyError as exc:
        raise HTTPException(400, exc.args[0])
    ds = generate(seed=body.seed, n_queries=body.n_vacancies, name='api-eval')
    result = await run_dataset(ds, scorer)

    persisted = False
    if body.persist:
        try:
            await store.upsert_eval_dataset(
                f"{ds['name']}:{ds['version']}",
                {'seed': ds['seed'], 'n_pairs': len(ds['pairs']), 'version': ds['version']})
            await store.insert_eval_result(
                f"{result['scorer']}@{result['dataset']}:{result['dataset_version']}", result)
            persisted = True
        except Exception as exc:
            logger.warning('eval persist failed: %s', exc)
    await publish_eval_run_completed(result, persisted, _correlation_id(request))

    return EvalRunResponse(
        scorer=result['scorer'], dataset=result['dataset'],
        dataset_version=result['dataset_version'],
        model_version=result['model_version'], prompt_version=result['prompt_version'],
        n_queries=result['n_queries'], n_pairs=result['n_pairs'],
        metrics=result['metrics'], persisted=persisted,
    )


@app.get('/v1/skills/canonical', dependencies=[v1], response_model=list[SkillEntry])
async def skills_canonical(q: str = Query(default=''), limit: int = Query(default=10, le=50)):
    taxonomy = await get_taxonomy()
    entries = taxonomy.search(q, limit) if q else [taxonomy.get(n) for n in taxonomy.names()[:limit]]
    return [
        SkillEntry(name=e['name'], aliases=e.get('aliases') or [],
                   esco_uri=e.get('esco_uri'), category=e.get('category', 'general'))
        for e in entries if e
    ]
