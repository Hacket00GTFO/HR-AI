"""CV parsing pipeline stage.

text → sanitize → LLM structured output (CandidateProfile) → skills normalized
against canonical_skills. Provider down/budget-out → deterministic heuristic
parse (same schema), source='rule_based'.
"""
from __future__ import annotations

import logging
from typing import Any

from ..config import get_settings
from ..llm.base import ProviderUnavailable, _is_mock
from ..pii import strip_pii
from ..skills import get_taxonomy
from .heuristics import parse_cv_text
from .sanitize import sanitize_document

logger = logging.getLogger(__name__)

PROFILE_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'experience_years': {'type': 'number'},
        'education_level': {
            'type': 'string',
            'enum': ['none', 'high_school', 'bachelor', 'master', 'phd'],
        },
        'skills_raw': {'type': 'array', 'items': {'type': 'string'}},
        'languages': {'type': 'array', 'items': {'type': 'string'}},
        'certifications': {'type': 'array', 'items': {'type': 'string'}},
        'seniority': {'type': 'string'},
    },
    'required': ['experience_years', 'education_level', 'skills_raw'],
    'additionalProperties': False,
}

_PROMPT = (
    'Extract a structured candidate profile from the resume text below. '
    'Return ONLY the JSON object. Skills must be short canonical technology/skill names.\n'
    '<<<CV\n{cv}\nCV>>>'
)

_EDU_ENUM = {'none', 'high_school', 'bachelor', 'master', 'phd'}


async def parse_cv(text: str, provider, *, correlation_id: str | None = None) -> dict:
    settings = get_settings()
    sanitized = sanitize_document(text)

    profile: dict | None = None
    source = 'rule_based'
    try:
        result = await provider.complete_structured(
            _PROMPT.format(cv=sanitized.text[:12000]),
            PROFILE_SCHEMA,
            task='cv_parse',
            timeout=settings.llm_parse_timeout,
            correlation_id=correlation_id,
        )
        profile = _coerce_profile(result)
        source = 'llm' if not _is_mock(provider) else 'rule_based'
    except ProviderUnavailable as exc:
        logger.info('cv_parse degrading to heuristic parse: %s', exc)

    if profile is None:
        profile = parse_cv_text(sanitized.text)
        source = 'rule_based'

    taxonomy = await get_taxonomy()
    canonical, unresolved = await taxonomy.normalize_many(
        profile.get('skills_raw') or [],
        provider=None if _is_mock(provider) else provider,
    )

    return {
        'experience_years': profile.get('experience_years', 0),
        'education_level': profile.get('education_level', 'none'),
        'skills_raw': profile.get('skills_raw') or [],
        'skills_canonical': canonical,
        'skills_unresolved': unresolved,
        'languages': profile.get('languages') or [],
        'certifications': profile.get('certifications') or [],
        'seniority': profile.get('seniority'),
        'flags': sanitized.flags,
        'injection_suspected': sanitized.injection_suspected,
        'source': source,
        'prompt_version': settings.prompt_version,
    }


def _coerce_profile(raw: dict) -> dict:
    out = dict(raw or {})
    edu = str(out.get('education_level') or 'none').lower().replace(' ', '_')
    out['education_level'] = edu if edu in _EDU_ENUM else 'none'
    try:
        years = float(out.get('experience_years') or 0)
    except (TypeError, ValueError):
        years = 0
    out['experience_years'] = max(0, years)
    for key in ('skills_raw', 'languages', 'certifications'):
        v = out.get(key)
        out[key] = [str(x) for x in v] if isinstance(v, (list, tuple)) else []
    # Defensive: providers only ever see sanitized text, but strip anything
    # PII-shaped that came back anyway.
    return strip_pii(out)
