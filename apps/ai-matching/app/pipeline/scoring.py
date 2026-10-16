"""Corrected scoring math — replaces AI_model/CandidateMatcher.js.

Fixes vs the old heuristic:
- skills: |canonical ∩ required| / |required| — bounded [0,1], canonical ids
  only, no substring matching ('r' ≠ 'ruby', 'java' ≠ 'javascript').
- experience: entry-level maps to 0y and does NOT auto-pass; missing
  candidate years → feature skipped, never NaN.
- education: ordinal level comparison (candidate level vs required level),
  not string-includes against the requirements blob.
- text: BM25-lite with tf saturation + unique-term normalization — repeated
  keywords can't inflate, long vacancy text isn't penalized 16x.
- final score: weighted sum over computable features, weights renormalized,
  clamped [0,1], NaN impossible.
"""
from __future__ import annotations

import math
import re
from datetime import date, datetime
from typing import Any

# ---------------------------------------------------------------------------
# experience
# ---------------------------------------------------------------------------

EXPERIENCE_LEVEL_YEARS = {
    'entry': 0, 'entry level': 0, 'entry-level': 0, 'intern': 0, 'internship': 0,
    'junior': 1, 'jr': 1, 'associate': 1,
    'mid': 3, 'mid level': 3, 'mid-level': 3, 'intermediate': 3, 'semi senior': 3,
    'semi-senior': 3,
    'senior': 5, 'senior level': 5, 'sr': 5, 'sr.': 5,
    'lead': 7, 'staff': 7, 'principal': 8, 'executive': 8, 'director': 8,
    'manager': 7, 'head': 8,
}

_YEARS_RE = re.compile(r'(\d{1,2})\s*(?:\+?\s*)(?:years?|yrs?)\b', re.IGNORECASE)
_NUM_RE = re.compile(r'^\s*(\d{1,2}(?:\.\d+)?)\s*$')


def parse_years(value: Any) -> float | None:
    """'5', 5, '5 years', 'Senior Level' → float years, or None when unknown.
    Never NaN."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) and value >= 0 else None
    text = str(value).strip()
    if not text:
        return None
    m = _NUM_RE.match(text)
    if m:
        return float(m.group(1))
    m = _YEARS_RE.search(text)
    if m:
        return float(m.group(1))
    level = EXPERIENCE_LEVEL_YEARS.get(text.lower())
    return float(level) if level is not None else None


def required_years(vacancy: dict) -> float | None:
    """Vacancy requirement in years: explicit numeric fields first, then the
    experience_level string."""
    for key in ('min_experience_years', 'required_experience_years', 'experience_years'):
        if vacancy.get(key) is not None:
            yrs = parse_years(vacancy[key])
            if yrs is not None:
                return yrs
    return parse_years(vacancy.get('experience_level') or vacancy.get('experience'))


def experience_score(candidate_years: float | None, required: float | None) -> float | None:
    """1.0 when candidate meets requirement; linear decay 1 - gap/3 below it.
    Returns None when the requirement is unknown (feature skipped)."""
    if required is None:
        return None
    if candidate_years is None:
        return 0.0  # vacancy asks for experience we can't evidence
    if candidate_years >= required:
        return 1.0
    gap = required - candidate_years
    return max(0.0, 1.0 - gap / 3.0)


# ---------------------------------------------------------------------------
# education
# ---------------------------------------------------------------------------

EDUCATION_LEVELS = {'none': 0, 'high_school': 1, 'bachelor': 2, 'master': 3, 'phd': 4}

_EDU_PATTERNS = [
    (4, re.compile(r'\b(ph\.?\s?d|doctorate|doctoral|phd)\b', re.IGNORECASE)),
    (3, re.compile(r'\b(masters?|msc|m\.sc|mba|m\.b\.a|maestr[ií]a|graduate degree)\b', re.IGNORECASE)),
    (2, re.compile(r'\b(bachelors?|bsc|b\.sc|b\.a\.?|undergraduate|licenciatura|degree|university|college|ingenier[ií]a|engineer)\b', re.IGNORECASE)),
    (1, re.compile(r'\b(high\s*school|secondary school|bachillerato|diploma|technical school)\b', re.IGNORECASE)),
]


def education_ordinal(value: Any) -> int | None:
    """Free-text education → ordinal level, or None when unknown."""
    if value is None:
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        v = int(value)
        return v if 0 <= v <= 4 else None
    text = str(value).strip()
    if not text:
        return None
    norm = text.lower().replace(' ', '_').replace('-', '_')
    if norm in EDUCATION_LEVELS:
        return EDUCATION_LEVELS[norm]
    for level, pattern in _EDU_PATTERNS:
        if pattern.search(text):
            return level
    return None


def vacancy_education_requirement(vacancy: dict) -> int | None:
    """Explicit education field wins; otherwise scan requirements text for the
    FIRST level keyword (that is the stated minimum)."""
    for key in ('education_required', 'required_education', 'education_level', 'education'):
        lvl = education_ordinal(vacancy.get(key))
        if lvl is not None:
            return lvl
    reqs = vacancy.get('requirements')
    if isinstance(reqs, str) and reqs.strip():
        for level, pattern in _EDU_PATTERNS:
            if pattern.search(reqs):
                return level
    return None


def education_score(candidate_level: int | None, required_level: int | None) -> float | None:
    """Ordinal comparison: meets-or-exceeds → 1.0; each missing level costs
    ~0.34. Returns None when the vacancy states no requirement."""
    if required_level is None:
        return None
    if candidate_level is None:
        return 0.0
    if candidate_level >= required_level:
        return 1.0
    return max(0.0, 1.0 - 0.34 * (required_level - candidate_level))


# ---------------------------------------------------------------------------
# text (BM25-lite)
# ---------------------------------------------------------------------------

STOPWORDS = {
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from',
    'has', 'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
    'to', 'was', 'were', 'will', 'with', 'we', 'you', 'your', 'our', 'their',
    'they', 'this', 'these', 'those', 'who', 'whom', 'which', 'what', 'when',
    'where', 'how', 'if', 'not', 'no', 'but', 'can', 'could', 'should', 'would',
    'do', 'does', 'did', 'about', 'into', 'over', 'under', 'between', 'through',
    'during', 'per', 'via', 'etc', 'such', 'than', 'then', 'there', 'here',
    'all', 'any', 'both', 'each', 'more', 'most', 'other', 'some', 'own', 'same',
    'work', 'working', 'team', 'role', 'job', 'position', 'candidate', 'must',
    'ability', 'strong', 'good', 'new', 'years', 'year', 'experience', 'skills',
}

_TOKEN_RE = re.compile(r'[a-z0-9+#.]{2,}')

_BM25_K1 = 1.2


def tokenize(text: str | None) -> list[str]:
    if not text:
        return []
    return [t for t in _TOKEN_RE.findall(text.lower()) if t not in STOPWORDS]


def bm25_lite(query_text: str | None, doc_text: str | None) -> float | None:
    """Query = vacancy text, doc = candidate text.

    Sum of tf-saturated contributions over UNIQUE query terms, normalized by
    sqrt(|q_terms|) and clamped to [0,1]:
      - keyword stuffing can't inflate (f/(f+k) saturates per term),
      - well-described vacancies aren't linearly penalized (sqrt dilution),
      - broad coverage still reaches ~1.0.
    """
    q_terms = set(tokenize(query_text))
    if not q_terms:
        return None
    d_tokens = tokenize(doc_text)
    if not d_tokens:
        return 0.0
    tf: dict[str, int] = {}
    for t in d_tokens:
        tf[t] = tf.get(t, 0) + 1
    matched = sum(tf[t] / (tf[t] + _BM25_K1) for t in q_terms if t in tf)
    return min(1.0, matched / math.sqrt(len(q_terms)))


# ---------------------------------------------------------------------------
# skills (canonical ids only)
# ---------------------------------------------------------------------------

def skills_score(candidate_canonical: set[str], required_canonical: set[str]) -> tuple[float, list[str], list[str]]:
    """|intersection| / |required|, capped at 1.0. Vacancy with no required
    skills → 0.0 per spec. Returns (score, matched, missing)."""
    if not required_canonical:
        return 0.0, [], []
    matched = candidate_canonical & required_canonical
    missing = required_canonical - candidate_canonical
    return min(1.0, len(matched) / len(required_canonical)), sorted(matched), sorted(missing)


# ---------------------------------------------------------------------------
# combine
# ---------------------------------------------------------------------------

def combine(features: dict[str, float | None], weights: dict[str, float]) -> float:
    """Weighted mean over computable features; weights renormalized. Result
    always finite in [0,1] — NaN is structurally impossible."""
    total_w = 0.0
    acc = 0.0
    for name, value in features.items():
        if value is None or not math.isfinite(value):
            continue
        w = weights.get(name, 0.0)
        if w <= 0:
            continue
        acc += w * min(1.0, max(0.0, value))
        total_w += w
    if total_w <= 0:
        return 0.0
    return min(1.0, max(0.0, acc / total_w))


def match_level(score: float) -> str:
    if score >= 0.8:
        return 'Excellent Match'
    if score >= 0.6:
        return 'Good Match'
    if score >= 0.4:
        return 'Moderate Match'
    return 'Low Match'


def recommendation(score: float) -> str:
    if score >= 0.8:
        return 'Strongly recommended for this position'
    if score >= 0.6:
        return 'Shows good potential for this role'
    if score >= 0.4:
        return 'May need additional screening'
    return 'May not be the best fit for this position'


# ---------------------------------------------------------------------------
# payload normalization + full match
# ---------------------------------------------------------------------------

def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(v).strip() for v in value if str(v).strip()]
    return [s.strip() for s in re.split(r'[,;|\n]', str(value)) if s.strip()]


def candidate_skills_raw(candidate: dict) -> list[str]:
    for key in ('skills_canonical', 'skills', 'skills_raw'):
        v = candidate.get(key)
        if v:
            return _as_list(v)
    return []


def vacancy_skills_raw(vacancy: dict) -> list[str]:
    for key in ('skills_required', 'required_skills', 'skills'):
        v = vacancy.get(key)
        if v:
            return _as_list(v)
    return []


def candidate_text(candidate: dict) -> str:
    parts = [
        candidate.get('summary'), candidate.get('description'),
        candidate.get('current_position'), candidate.get('headline'),
        candidate.get('profile'),
    ]
    return ' '.join(p for p in parts if isinstance(p, str) and p.strip())


def vacancy_text(vacancy: dict) -> str:
    parts = [
        vacancy.get('title'), vacancy.get('description'),
        vacancy.get('requirements'), vacancy.get('responsibilities'),
    ]
    return ' '.join(p for p in parts if isinstance(p, str) and p.strip())


def cosine(a: list[float] | None, b: list[float] | None) -> float | None:
    if not a or not b or len(a) != len(b):
        return None
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return None
    return max(0.0, min(1.0, dot / (na * nb)))


def compute_match(
    candidate: dict,
    vacancy: dict,
    *,
    cand_skills: set[str],
    vac_skills: set[str],
    weights: dict[str, float],
    cand_vec: list[float] | None = None,
    vac_vec: list[float] | None = None,
) -> dict:
    """Full feature pipeline → score + subscores + explanation. Pure."""
    s_score, matched, missing = skills_score(cand_skills, vac_skills)
    e_score = experience_score(parse_years(candidate.get('experience') or candidate.get('experience_years')),
                               required_years(vacancy))
    ed_score = education_score(education_ordinal(candidate.get('education') or candidate.get('education_level')),
                               vacancy_education_requirement(vacancy))
    t_score = bm25_lite(vacancy_text(vacancy), candidate_text(candidate))
    v_score = cosine(cand_vec, vac_vec)

    features = {
        'skills': s_score,
        'experience': e_score,
        'education': ed_score,
        'text': t_score,
        'vector': v_score,
    }
    score = combine(features, weights)

    red_flags: list[str] = []
    if missing:
        red_flags.append(f"missing required skills: {', '.join(missing[:8])}")
    if e_score is not None and e_score < 0.5:
        red_flags.append('experience below requirement')
    if ed_score is not None and ed_score < 0.5:
        red_flags.append('education below requirement')

    explanation = {
        'match_level': match_level(score),
        'recommendation': recommendation(score),
        'matched_skills': matched,
        'missing_skills': missing,
        'summary': (
            f"{match_level(score)} ({round(score * 100)}%): "
            f"{len(matched)}/{len(vac_skills)} required skills matched. "
            f"{recommendation(score)}."
        ),
    }
    return {
        'score': score,
        'subscores': {k: round(v, 4) if v is not None else None for k, v in features.items()},
        'explanation': explanation,
        'red_flags': red_flags,
    }


def today() -> date:
    return datetime.utcnow().date()
