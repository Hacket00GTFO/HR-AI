"""Baseline scorers — all wired to the SAME eval runner.

Scorer contract: an object with `name` and
    async score_query(vacancy: dict, items: list[dict]) -> dict[int, float]
mapping pair-id → score in [0,1] (0.0 for hard-filtered/unscored pairs).

Scorers:
- legacy_heuristic : faithful re-implementation of the OLD
  apps/api/AI_model/CandidateMatcher.js (git 99c0516) — buggy substring
  skills matching, entry-level auto-pass, constant-0.5 education,
  naive keyword-overlap text. Kept verbatim-buggy on purpose: the harness
  exists to demonstrate beating it.
- bm25_filters     : hard filters + BM25-lite text retrieval only.
- hybrid_no_llm    : the real pipeline minus rerank — score_pair over every
  pair (canonical skills + experience + education + text + mock embeddings).
- full_pipeline    : rank_candidates — hard filters → BM25+vector retrieval
  → full scoring → LLM rerank (a deterministic no-op under MockProvider).
"""
from __future__ import annotations

import math
from typing import Any

from app.config import get_settings
from app.llm.mock import MockProvider
from app.pipeline import scoring
from app.pipeline.rank import hard_filter_reasons, rank_candidates, score_pair
from app.skills import SkillsTaxonomy

# ---------------------------------------------------------------------------
# legacy_heuristic — verbatim port of CandidateMatcher.js @ 99c0516
# ---------------------------------------------------------------------------

_LEGACY_EXP_LEVELS = {'Entry Level': 0, 'Mid Level': 3, 'Senior Level': 5, 'Executive': 8}
_LEGACY_COMMON = {'and', 'or', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'}


def _legacy_parse_skills(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, (list, tuple)):
        return [str(s).strip().lower() for s in value if str(s).strip()]
    return [s.strip() for s in str(value).lower().split(',')]


def _legacy_skills_match(candidate_skills: list[str], vacancy_skills: list[str]) -> float:
    if not candidate_skills or not vacancy_skills:
        return 0.0
    matching = sum(
        1 for skill in candidate_skills
        if any(vs in skill or skill in vs for vs in vacancy_skills)
    )
    return matching / max(len(vacancy_skills), 1)


def _legacy_experience_match(candidate_exp: float | None, required_exp: Any) -> float:
    if candidate_exp is None or not math.isfinite(candidate_exp):
        return 0.0
    required_years = _LEGACY_EXP_LEVELS.get(str(required_exp), 0)
    if candidate_exp >= required_years:
        return 1.0
    return max(0.0, candidate_exp / required_years)


def _legacy_education_match(candidate_edu: Any, required_edu: Any) -> float:
    if not candidate_edu or not required_edu:
        return 0.0
    if str(required_edu).lower() in str(candidate_edu).lower():
        return 1.0
    return 0.5


def _legacy_keywords(text: str) -> list[str]:
    import re
    return [w for w in re.split(r'\W+', (text or '').lower())
            if len(w) > 2 and w not in _LEGACY_COMMON]


def _legacy_description_match(candidate_desc: str, vacancy_desc: str) -> float:
    if not candidate_desc or not vacancy_desc:
        return 0.0
    vac_kw = _legacy_keywords(vacancy_desc)
    cand_kw = _legacy_keywords(candidate_desc)
    matching = sum(1 for w in cand_kw if w in vac_kw)
    return matching / max(len(vac_kw), 1)


def legacy_score(candidate: dict, vacancy: dict) -> float:
    """match_candidate() — bug-for-bug port, including unbounded subscores."""
    try:
        cand_exp = candidate.get('experience')
        try:
            cand_exp = int(str(cand_exp).strip()) if cand_exp is not None else None
        except (TypeError, ValueError):
            cand_exp = None  # parseInt → NaN → isNaN → 0
        skills = _legacy_skills_match(
            _legacy_parse_skills(candidate.get('skills')),
            _legacy_parse_skills(vacancy.get('skills') or vacancy.get('skills_required')))
        experience = _legacy_experience_match(
            cand_exp, vacancy.get('experience') or vacancy.get('experience_level'))
        education = _legacy_education_match(
            candidate.get('education'), vacancy.get('education'))
        feedback = _legacy_description_match(
            candidate.get('description') or candidate.get('summary') or '',
            vacancy.get('description') or '')
        score = 0.35 * skills + 0.25 * experience + 0.20 * education + 0.20 * feedback
        return min(max(score, 0.0), 1.0)
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# scorer objects
# ---------------------------------------------------------------------------

class LegacyHeuristicScorer:
    name = 'legacy_heuristic'
    description = 'CandidateMatcher.js @99c0516 — buggy substring/experience/education heuristic'

    async def score_query(self, vacancy: dict, items: list[dict]) -> dict[int, float]:
        return {p['id']: legacy_score(p['candidate'], vacancy) for p in items}


class Bm25FiltersScorer:
    """Hard filters, then BM25-lite over candidate text+skills only."""
    name = 'bm25_filters'
    description = 'hard filters + BM25 text retrieval (no structure, no embeddings)'

    async def score_query(self, vacancy: dict, items: list[dict]) -> dict[int, float]:
        v_text = scoring.vacancy_text(vacancy)
        out = {}
        for p in items:
            c = p['candidate']
            if hard_filter_reasons(vacancy, c):
                out[p['id']] = 0.0
                continue
            doc = ' '.join([scoring.candidate_text(c), ' '.join(scoring.candidate_skills_raw(c))])
            out[p['id']] = scoring.bm25_lite(v_text, doc) or 0.0
        return out


class _PipelineBase:
    provider: MockProvider | None = None
    _taxonomy: SkillsTaxonomy | None = None

    @classmethod
    def taxonomy(cls) -> SkillsTaxonomy:
        """Seed-file taxonomy — keeps the eval hermetic (no DB wait)."""
        if cls._taxonomy is None:
            cls._taxonomy = SkillsTaxonomy.from_seed()
        return cls._taxonomy

    @classmethod
    def llm(cls) -> MockProvider:
        if cls.provider is None:
            cls.provider = MockProvider()
        return cls.provider


class HybridNoLlmScorer(_PipelineBase):
    """score_pair over every pair — all features, no retrieval cut, no rerank."""
    name = 'hybrid_no_llm'
    description = 'score_pair: canonical skills + experience + education + text + embeddings'

    async def score_query(self, vacancy: dict, items: list[dict]) -> dict[int, float]:
        out = {}
        for p in items:
            result = await score_pair(p['candidate'], vacancy, self.taxonomy(),
                                      self.llm(), get_settings())
            out[p['id']] = result['score']
        return out


class FullPipelineScorer(_PipelineBase):
    """rank_candidates — the production path end-to-end under MockProvider."""
    name = 'full_pipeline'
    description = 'hard filters → retrieval → scoring → LLM rerank (mock no-op)'

    async def score_query(self, vacancy: dict, items: list[dict]) -> dict[int, float]:
        candidates = [p['candidate'] for p in items]
        result = await rank_candidates(
            vacancy, candidates, self.taxonomy(), self.llm(), get_settings())
        by_cid = {r['candidate_id']: r['score'] for r in result['results']}
        return {p['id']: by_cid.get(p['candidate'].get('id'), 0.0) for p in items}


SCORERS = {
    s.name: s for s in (
        LegacyHeuristicScorer, Bm25FiltersScorer, HybridNoLlmScorer, FullPipelineScorer,
    )
}
SCORER_ORDER = ['legacy_heuristic', 'bm25_filters', 'hybrid_no_llm', 'full_pipeline']


def get_scorer(name: str):
    if name not in SCORERS:
        raise KeyError(f'unknown scorer {name!r} — choose from {sorted(SCORERS)}')
    return SCORERS[name]()
