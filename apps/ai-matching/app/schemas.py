"""Request/response models for the /v1 API. Candidate/vacancy payloads are
open dicts — the monolith and future services have different field sets; the
pipeline extracts what it knows and skips the rest."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class CVParseRequest(BaseModel):
    text: str | None = None
    document_id: str | int | None = None


class CandidateProfile(BaseModel):
    experience_years: float = 0
    education_level: Literal['none', 'high_school', 'bachelor', 'master', 'phd'] = 'none'
    skills_raw: list[str] = []
    skills_canonical: list[str] = []
    skills_unresolved: list[str] = []
    languages: list[str] = []
    certifications: list[str] = []
    seniority: str | None = None
    flags: list[str] = []
    injection_suspected: bool = False
    source: str = 'rule_based'
    prompt_version: str = ''


class ScoreRequest(BaseModel):
    candidate: dict[str, Any]
    vacancy: dict[str, Any]


class ScoreResponse(BaseModel):
    candidate_id: Any = None
    vacancy_id: Any = None
    score: float
    subscores: dict[str, float | None] = {}
    explanation: dict[str, Any] = {}
    red_flags: list[str] = []
    source: str = 'rule_based'
    model_version: str = ''
    prompt_version: str = ''
    embedding_version: str = ''
    cached: bool = False
    budget_exceeded: bool = False


class RankRequest(BaseModel):
    vacancy: dict[str, Any]
    candidates: list[dict[str, Any]] = []
    async_: bool | None = Field(default=None, alias='async')
    top_k: int | None = None
    min_score: float | None = None

    model_config = {'populate_by_name': True}


class RankedCandidate(BaseModel):
    rank: int
    candidate_id: Any = None
    score: float
    subscores: dict[str, float | None] = {}
    match_level: str = ''
    explanation: dict[str, Any] = {}
    red_flags: list[str] = []


class RankResponse(BaseModel):
    vacancy_id: Any = None
    results: list[RankedCandidate] = []
    excluded: list[dict[str, Any]] = []
    not_evaluated: list[dict[str, Any]] = []
    below_min_score: list[dict[str, Any]] = []
    degradations: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    evaluated: int = 0
    source: str = 'rule_based'
    model_version: str = ''
    prompt_version: str = ''
    embedding_version: str = ''
    budget_exceeded: bool = False


class JobAccepted(BaseModel):
    job_id: str
    status: str = 'queued'


class JobStatus(BaseModel):
    job_id: str
    type: str
    status: str
    result: dict[str, Any] | None = None
    error: str | None = None
    attempts: int = 0
    created_at: str | None = None
    updated_at: str | None = None


class SkillEntry(BaseModel):
    name: str
    aliases: list[str] = []
    esco_uri: str | None = None
    category: str = 'general'


class ExplainResponse(BaseModel):
    candidate_id: Any = None
    vacancy_id: Any = None
    score: float
    subscores: dict[str, Any] = {}
    explanation: dict[str, Any] = {}
    source: str = ''
    model_version: str = ''
    created_at: str | None = None


class EvalRunRequest(BaseModel):
    scorer: str = 'full_pipeline'
    seed: int = 13
    n_vacancies: int = Field(default=12, ge=1, le=30)
    persist: bool = False


class EvalRunResponse(BaseModel):
    scorer: str
    dataset: str | None = None
    dataset_version: str | None = None
    model_version: str = ''
    prompt_version: str = ''
    n_queries: int = 0
    n_pairs: int = 0
    metrics: dict[str, float | None] = {}
    persisted: bool = False
