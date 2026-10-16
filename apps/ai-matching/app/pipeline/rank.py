"""Candidate↔vacancy matching: hard filters → retrieval → score → optional
LLM rerank on top-K. Degrades cleanly to pure rule_based.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any

from ..config import get_settings
from ..llm.base import ProviderUnavailable, _is_mock
from ..pii import strip_pii
from ..scoring_fields import project_for_scoring, project_vacancy_for_scoring
from .. import store
from . import scoring

logger = logging.getLogger(__name__)

RERANK_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'adjustments': {
            'type': 'object',
            'description': 'candidate_id -> per-criterion score overrides in [0,1]',
            'additionalProperties': {
                'type': 'object',
                'additionalProperties': {'type': 'number'},
            },
        },
        'justification': {'type': 'string'},
        'confidence': {'type': 'number'},
    },
    'required': ['adjustments'],
    'additionalProperties': False,
}

_MAX_RERANK_DELTA = 0.25  # LLM may nudge a criterion score by at most ±0.25


# ---------------------------------------------------------------------------
# hard filters (all optional — a missing field means "skip this filter")
# ---------------------------------------------------------------------------

def _norm_loc(v: Any) -> str:
    return str(v or '').strip().lower()


def hard_filter_reasons(vacancy: dict, candidate: dict) -> list[str]:
    reasons: list[str] = []

    # Remote / location compatibility
    remote_ok = bool(vacancy.get('remote_option') or vacancy.get('remote'))
    c_pref = _norm_loc(candidate.get('remote_preference') or candidate.get('work_mode'))
    if not remote_ok and c_pref in ('remote', 'remote_only', 'remote-only'):
        reasons.append('requires remote work but vacancy is on-site')
    v_loc = _norm_loc(vacancy.get('location'))
    c_loc = _norm_loc(candidate.get('location'))
    if not remote_ok and v_loc and c_loc:
        v_city = v_loc.split(',')[0].strip()
        c_city = c_loc.split(',')[0].strip()
        if v_city and c_city and v_city not in c_loc and c_city not in v_loc:
            reasons.append(f'location mismatch ({c_loc} vs {v_loc})')

    # Salary overlap — both sides must be present to filter.
    c_salary = candidate.get('expected_salary') or candidate.get('salary_expectation')
    v_max = vacancy.get('salary_max')
    if v_max is None:
        sr = vacancy.get('salary_range') or {}
        v_max = sr.get('max') if isinstance(sr, dict) else None
    try:
        c_salary_f = float(c_salary) if c_salary is not None else None
        v_max_f = float(v_max) if v_max is not None else None
    except (TypeError, ValueError):
        c_salary_f = v_max_f = None
    if c_salary_f is not None and v_max_f is not None and c_salary_f > v_max_f * 1.15:
        reasons.append('salary expectation above vacancy range')

    # Application deadline — if the vacancy is closed, nobody ranks.
    deadline = vacancy.get('application_deadline') or vacancy.get('deadline')
    if deadline:
        try:
            d = datetime.fromisoformat(str(deadline).replace('Z', '+00:00'))
            now = datetime.now(timezone.utc if d.tzinfo else None)
            if d < now:
                reasons.append('vacancy application deadline has passed')
        except ValueError:
            pass

    return reasons


# ---------------------------------------------------------------------------
# embeddings (best effort — provider/db absence just skips the feature)
# ---------------------------------------------------------------------------

def _fallback_text(projected: dict) -> str:
    """Serialize a whitelisted projection for embedding when no dedicated
    profile/vacancy text fields exist. Empty projection → '' (skip embed)."""
    if not projected:
        return ''
    return json.dumps(strip_pii(projected), default=str)[:4000]


async def _embedding_for(table: str, owner_id: int | None, text: str, provider, settings) -> list[float] | None:
    dhash = store.doc_hash(text)
    if owner_id is not None:
        try:
            vec, old_hash = await store.get_embedding_with_hash(table, owner_id, settings.embedding_version)
            if vec is not None and old_hash == dhash:
                return vec
        except Exception as exc:
            logger.debug('embedding lookup failed: %s', exc)
    try:
        [vec] = await provider.embed([text])
    except ProviderUnavailable:
        return None
    if owner_id is not None:
        try:
            await store.put_embedding(table, owner_id, settings.embedding_version, vec, dhash)
        except Exception as exc:
            logger.debug('embedding store failed: %s', exc)
    return vec


# ---------------------------------------------------------------------------
# score one pair (shared by /v1/score and rank)
# ---------------------------------------------------------------------------

async def score_pair(candidate: dict, vacancy: dict, taxonomy, provider, settings, *,
                     correlation_id: str | None = None) -> dict:
    cand_canonical, _ = await taxonomy.normalize_many(
        scoring.candidate_skills_raw(candidate), provider=None if _is_mock(provider) else provider
    )
    vac_canonical, _ = await taxonomy.normalize_many(
        scoring.vacancy_skills_raw(vacancy), provider=None if _is_mock(provider) else provider
    )

    cand_vec = vac_vec = None
    try:
        c_text = scoring.candidate_text(candidate) or _fallback_text(project_for_scoring(candidate))
        if c_text:
            cand_vec = await _embedding_for(
                'candidate_embeddings', _int_or_none(candidate.get('id') or candidate.get('candidate_id')),
                c_text, provider, settings)
        v_text_embed = scoring.vacancy_text(vacancy) or _fallback_text(project_vacancy_for_scoring(vacancy))
        if v_text_embed:
            vac_vec = await _embedding_for(
                'vacancy_embeddings', _int_or_none(vacancy.get('id') or vacancy.get('vacancy_id')),
                v_text_embed, provider, settings)
    except ProviderUnavailable:
        pass

    result = scoring.compute_match(
        candidate, vacancy,
        cand_skills=set(cand_canonical), vac_skills=set(vac_canonical),
        weights=settings.feature_weights,
        cand_vec=cand_vec, vac_vec=vac_vec,
    )
    result['candidate_id'] = candidate.get('id', candidate.get('candidate_id'))
    result['vacancy_id'] = vacancy.get('id', vacancy.get('vacancy_id'))
    result['source'] = 'hybrid' if (cand_vec and vac_vec) else 'rule_based'
    return result


def _int_or_none(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# rank
# ---------------------------------------------------------------------------

async def rank_candidates(
    vacancy: dict,
    candidates: list[dict],
    taxonomy,
    provider,
    settings,
    *,
    top_k: int | None = None,
    correlation_id: str | None = None,
) -> dict:
    top_k = min(top_k or settings.top_k_rerank, settings.top_k_rerank)
    weights = settings.feature_weights

    # Visibility into what happened to every candidate/feature.
    not_evaluated: list[dict] = []
    degradations: list[dict] = []

    # 1. hard filters
    survivors: list[dict] = []
    excluded: list[dict] = []
    for c in candidates:
        reasons = hard_filter_reasons(vacancy, c)
        if reasons:
            excluded.append({'candidate_id': c.get('id', c.get('candidate_id')), 'reasons': reasons})
        else:
            survivors.append(c)

    # 2. normalize skills once per side
    vac_canonical, _ = await taxonomy.normalize_many(
        scoring.vacancy_skills_raw(vacancy), provider=None if _is_mock(provider) else provider
    )
    vac_vec = None
    v_text_embed = scoring.vacancy_text(vacancy) or _fallback_text(project_vacancy_for_scoring(vacancy))
    if v_text_embed:
        try:
            vac_vec = await _embedding_for(
                'vacancy_embeddings', _int_or_none(vacancy.get('id') or vacancy.get('vacancy_id')),
                v_text_embed, provider, settings)
        except ProviderUnavailable:
            vac_vec = None
        if vac_vec is None:
            degradations.append({'feature': 'vector', 'reason': 'vacancy_embedding_provider_unavailable'})

    v_text = scoring.vacancy_text(vacancy)

    # 3. retrieval pre-score (text BM25 + vector cosine) → top-K
    vector_degraded = False
    prelim: list[tuple[float, dict, list[float] | None]] = []
    for c in survivors:
        c_vec = None
        c_text = scoring.candidate_text(c) or _fallback_text(project_for_scoring(c))
        if c_text:
            try:
                c_vec = await _embedding_for(
                    'candidate_embeddings', _int_or_none(c.get('id') or c.get('candidate_id')),
                    c_text, provider, settings)
            except ProviderUnavailable:
                c_vec = None
            if c_vec is None and not vector_degraded:
                degradations.append({'feature': 'vector', 'reason': 'candidate_embedding_provider_unavailable'})
                vector_degraded = True
        t = scoring.bm25_lite(v_text, scoring.candidate_text(c)) or 0.0
        v = scoring.cosine(c_vec, vac_vec) or 0.0
        prelim.append((0.6 * t + 0.4 * v, c, c_vec))
    prelim.sort(key=lambda x: x[0], reverse=True)
    shortlisted = prelim[:top_k]
    for _, c, _ in prelim[top_k:]:
        not_evaluated.append({
            'candidate_id': c.get('id', c.get('candidate_id')),
            'reason': 'below_top_k',
        })

    # 4. full scoring on the shortlist — one bad candidate must not fail the
    # batch; failures are reported in not_evaluated.
    scored: list[dict] = []
    scored_candidates: list[dict] = []  # aligned with `scored`
    for _, c, c_vec in shortlisted:
        try:
            cand_canonical, _ = await taxonomy.normalize_many(
                scoring.candidate_skills_raw(c), provider=None if _is_mock(provider) else provider
            )
            m = scoring.compute_match(
                c, vacancy,
                cand_skills=set(cand_canonical), vac_skills=set(vac_canonical),
                weights=weights, cand_vec=c_vec, vac_vec=vac_vec,
            )
        except Exception as exc:
            logger.warning('scoring failed for candidate %s: %s',
                           c.get('id', c.get('candidate_id')), exc)
            not_evaluated.append({
                'candidate_id': c.get('id', c.get('candidate_id')),
                'reason': 'scoring_error',
                'detail': str(exc)[:200],
            })
            continue
        m['candidate_id'] = c.get('id', c.get('candidate_id'))
        scored.append(m)
        scored_candidates.append(c)

    # 5. optional LLM rerank on top-K (real providers only — mock is a no-op)
    source = 'hybrid' if vac_vec is not None else 'rule_based'
    if not _is_mock(provider) and scored:
        try:
            payload = [
                {
                    'candidate_id': s['candidate_id'],
                    'subscores': s['subscores'],
                    'profile': strip_pii(_compact_profile(project_for_scoring(c))),
                }
                for s, c in zip(scored, scored_candidates)
            ]
            prompt = (
                'Rerank these candidates for the vacancy. Adjust per-criterion scores only '
                'when the profile evidence justifies it (max ±0.25). Return the schema.\n'
                f'VACANCY: {json.dumps(strip_pii(vacancy), default=str)[:3000]}\n'
                f'CANDIDATES: {json.dumps(payload, default=str)[:8000]}'
            )
            rerank = await provider.complete_structured(
                prompt, RERANK_SCHEMA, task='rerank',
                timeout=settings.llm_rerank_timeout, correlation_id=correlation_id)
            adjustments = rerank.get('adjustments') or {}
            applied = False
            for s in scored:
                adj = adjustments.get(str(s['candidate_id'])) or adjustments.get(s['candidate_id'])
                if not isinstance(adj, dict):
                    continue
                for crit, val in adj.items():
                    if crit in s['subscores'] and isinstance(val, (int, float)):
                        base = s['subscores'][crit] or 0.0
                        s['subscores'][crit] = round(min(1.0, max(0.0, base + max(-_MAX_RERANK_DELTA, min(_MAX_RERANK_DELTA, val - base)))), 4)
                        applied = True
                # recompute weighted score from adjusted subscores
                s['score'] = scoring.combine(s['subscores'], weights)
                s['explanation']['llm_justification'] = rerank.get('justification')
            if applied:
                source = 'llm_rerank'
        except ProviderUnavailable as exc:
            logger.info('rerank degraded: %s', exc)
            degradations.append({'feature': 'llm_rerank', 'reason': str(exc) or 'provider_unavailable'})
        except Exception as exc:
            logger.warning('rerank failed: %s', exc)
            degradations.append({'feature': 'llm_rerank', 'reason': f'error: {exc}'[:200]})

    scored.sort(key=lambda s: s['score'], reverse=True)
    results = []
    for i, s in enumerate(scored):
        results.append({
            'rank': i + 1,
            'candidate_id': s['candidate_id'],
            'score': s['score'],
            'subscores': s['subscores'],
            'match_level': s['explanation']['match_level'],
            'explanation': s['explanation'],
            'red_flags': s['red_flags'],
        })

    return {
        'vacancy_id': vacancy.get('id', vacancy.get('vacancy_id')),
        'results': results,
        'excluded': excluded,
        'not_evaluated': not_evaluated,
        'below_min_score': [],
        'degradations': degradations,
        'counts': {
            'received': len(candidates),
            'hard_filtered': len(excluded),
            'scored': len(results),
            'not_evaluated': len(not_evaluated),
        },
        'evaluated': len(results),
        'source': source,
        'model_version': settings.model_version,
        'prompt_version': settings.prompt_version,
        'embedding_version': settings.embedding_version,
        'budget_exceeded': getattr(provider, 'budget_exceeded', False),
    }


def _compact_profile(c: dict) -> dict:
    keys = ('id', 'candidate_id', 'skills', 'experience', 'experience_years',
            'education', 'location', 'current_position', 'summary', 'headline',
            'remote_preference', 'expected_salary')
    return {k: c[k] for k in keys if k in c}


def rank_idempotency_key(vacancy: dict, candidates: list[dict], settings) -> str:
    h = hashlib.sha256()
    h.update(json.dumps(vacancy, sort_keys=True, default=str).encode())
    for c in sorted(candidates, key=lambda x: str(x.get('id', x.get('candidate_id')))):
        h.update(json.dumps(c, sort_keys=True, default=str).encode())
    h.update(settings.model_version.encode())
    h.update(settings.prompt_version.encode())
    return h.hexdigest()
