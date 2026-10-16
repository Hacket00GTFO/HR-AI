"""Runtime scoring-field whitelist — the single source of truth for which
candidate/vacancy keys may influence a match score.

The pipeline serializes *projections* of these fields (never raw dicts)
when it needs a text fallback for embeddings or a compact profile for LLM
rerank. Callers still apply pii.strip_pii on top — the whitelist is the
first line of defense, PII stripping the second.

Mirrored by evaluation/fairness.py for static inspection of the pipeline.
"""
from __future__ import annotations

# Candidate fields the scorer is allowed to use (source of truth — keep in
# sync with evaluation/fairness.py's expectations).
CANDIDATE_SCORING_FIELDS = {
    'id', 'candidate_id',
    'skills', 'skills_raw', 'skills_canonical',
    'experience', 'experience_years',
    'education', 'education_level',
    'summary', 'description', 'current_position', 'headline', 'profile',
    'location', 'remote_preference', 'work_mode',
    'expected_salary', 'salary_expectation',
}

# Vacancy mirror — fields the scorer/hard filters may read from a vacancy.
VACANCY_SCORING_FIELDS = {
    'id', 'vacancy_id',
    'title', 'description', 'requirements', 'responsibilities',
    'skills', 'skills_required', 'required_skills',
    'experience_level', 'experience',
    'min_experience_years', 'required_experience_years', 'experience_years',
    'education', 'education_level', 'education_required', 'required_education',
    'location', 'remote_option', 'remote',
    'salary_max', 'salary_min', 'salary_range',
    'application_deadline', 'deadline',
}


def project_for_scoring(candidate: dict) -> dict:
    """Return only whitelisted candidate keys — everything else is dropped.
    Apply strip_pii on the result before it reaches an LLM or embedding."""
    return {k: v for k, v in candidate.items() if k in CANDIDATE_SCORING_FIELDS}


def project_vacancy_for_scoring(vacancy: dict) -> dict:
    """Vacancy counterpart of project_for_scoring."""
    return {k: v for k, v in vacancy.items() if k in VACANCY_SCORING_FIELDS}
