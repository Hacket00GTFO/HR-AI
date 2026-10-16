"""Celery worker: `celery -A app.worker worker`.

Broker = RABBITMQ_URL, result backend = REDIS_URL. Tasks run the async
pipeline on a per-task event loop with a per-task DB pool (the app's global
pool is bound to the FastAPI loop and must not be reused here).
"""
from __future__ import annotations

import asyncio
import logging

from celery import Celery
from opentelemetry.instrumentation.celery import CeleryInstrumentor
from psycopg_pool import AsyncConnectionPool

from .config import get_settings
from .db import _current_pool
from .llm.factory import validate_provider_policy
from .telemetry import setup_json_logging, setup_tracing

logger = logging.getLogger(__name__)

settings = get_settings()

# Fail closed at worker boot: production must never run tasks through a
# public LLM provider (validated again lazily by the provider factory).
validate_provider_policy()

# Initialize tracing for the Celery worker
setup_tracing(service_name="ai-matching-worker")
setup_json_logging(service_name="ai-matching-worker")

celery_app = Celery(
    'ai_matching',
    broker=settings.rabbitmq_url or 'memory://',
    backend=settings.redis_url,
)
celery_app.conf.update(
    task_default_queue='ai_matching',
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_track_started=True,
)

CeleryInstrumentor().instrument()


def _run(coro):
    """Execute an async pipeline function on a fresh loop+pool."""

    async def runner():
        pool = AsyncConnectionPool(settings.database_url, min_size=1, max_size=4, open=False,
                                   timeout=5, kwargs={'connect_timeout': 3})
        try:
            await pool.open()
        except Exception as exc:
            logger.warning('worker db pool open failed: %s', exc)
        token = _current_pool.set(pool)
        try:
            return await coro
        finally:
            _current_pool.reset(token)
            try:
                await pool.close()
            except Exception:
                pass

    return asyncio.run(runner())


@celery_app.task(name='ai_matching.parse_cv', bind=True, max_retries=2)
def parse_cv_task(self, text: str) -> dict:
    from .llm.factory import get_provider
    from .pipeline.cv_parse import parse_cv

    try:
        return _run(parse_cv(text, get_provider()))
    except Exception as exc:  # pragma: no cover
        raise self.retry(exc=exc, countdown=5)


@celery_app.task(name='ai_matching.index_entity', bind=True, max_retries=2)
def index_entity_task(self, entity: str, owner_id: int | None, payload: dict) -> dict:
    """(Re)compute the stored embedding for a candidate/vacancy projection."""
    from .llm.factory import get_provider
    from .pipeline import scoring
    from . import store, events

    async def impl():
        provider = get_provider()
        if entity == 'vacancy':
            text = scoring.vacancy_text(payload)
            table = 'vacancy_embeddings'
        else:
            text = scoring.candidate_text(payload) or str(payload.get('resumeText') or '')
            table = 'candidate_embeddings'
        if not text.strip():
            return {'indexed': False, 'reason': 'empty document'}
        vec = await provider.embed([text])
        if owner_id is not None:
            await store.put_embedding(table, int(owner_id), settings.embedding_version, vec[0], store.doc_hash(text))
            await events.publish_embedding_updated(entity, int(owner_id))
        return {'indexed': owner_id is not None}

    try:
        return _run(impl())
    except Exception as exc:  # pragma: no cover
        raise self.retry(exc=exc, countdown=10)


@celery_app.task(name='ai_matching.rank_batch', bind=True, max_retries=2)
def rank_batch_task(self, job_id: str, vacancy: dict, candidates: list[dict], top_k: int | None = None) -> dict:
    from .llm.factory import get_provider
    from .pipeline.rank import rank_candidates
    from .skills import get_taxonomy
    from . import store

    async def impl():
        await store.update_job(job_id, status='running')
        taxonomy = await get_taxonomy()
        result = await rank_candidates(vacancy, candidates, taxonomy, get_provider(), settings, top_k=top_k)
        await store.update_job(job_id, status='done', result=result)
        return result

    try:
        return _run(impl())
    except Exception as exc:
        try:
            _run(store.update_job(job_id, status='failed', error=str(exc)))
        except Exception:
            pass
        raise self.retry(exc=exc, countdown=10)
