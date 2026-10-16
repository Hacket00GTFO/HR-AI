"""Service configuration — all tunables come from the environment."""
from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    # Runtime
    port: int = 3005
    log_level: str = 'INFO'
    # Deployment environment — 'production'/'prod' activates fail-closed
    # provider policy (public LLM providers are refused). Reads ENV or
    # NODE_ENV so the Node monolith convention works too.
    env: str = Field(default='development', validation_alias=AliasChoices('ENV', 'NODE_ENV'))

    # Infra
    database_url: str = 'postgresql://postgres:postgres@localhost:5432/strafor_ai'
    redis_url: str = 'redis://localhost:6379/0'
    rabbitmq_url: str | None = None
    documents_url: str | None = None

    # Service-to-service auth (X-Service-Token). Unset → dev mode, all callers
    # allowed (still fine inside a private network; compose sets it).
    service_auth_token: str | None = None

    # LLM
    llm_provider: str = 'mock'  # openai | anthropic | private | mock
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    llm_parse_model: str = 'gpt-4o-mini'
    llm_rerank_model: str = 'gpt-4o-mini'
    anthropic_parse_model: str = 'claude-haiku-4-5-20251001'
    anthropic_rerank_model: str = 'claude-haiku-4-5-20251001'
    embedding_model: str = 'text-embedding-3-small'
    llm_monthly_budget_usd: float = 50.0

    # Private (self-hosted) inference — OpenAI-compatible endpoint such as
    # vLLM or Ollama. Required when LLM_PROVIDER=private in production.
    private_llm_base_url: str | None = None
    private_llm_api_key: str | None = None
    private_parse_model: str = 'qwen3-8b-instruct'
    private_rerank_model: str = 'qwen3-8b-instruct'
    private_embedding_model: str = 'bge-m3'
    # vLLM enforces response_format json_schema natively. When serving via
    # Ollama (no json_schema support) set this False: the provider then sends
    # response_format={'type': 'json_object'} and validates locally.
    private_strict_schema: bool = True

    # Timeouts (seconds)
    llm_parse_timeout: float = 30.0
    llm_rerank_timeout: float = 10.0
    llm_embed_timeout: float = 15.0
    llm_max_retries: int = 4

    # Circuit breaker
    breaker_failure_threshold: int = 5
    breaker_half_open_after_s: float = 30.0

    # Versioning — persisted on every match_scores row.
    model_version: str = 'rules-1.0.0'
    prompt_version: str = 'cvparse-v1'
    embedding_version: str = 'emb-v1'
    embedding_dim: int = 1536
    embedding_skill_threshold: float = 0.82

    # Ranking
    top_k_rerank: int = 30
    async_rank_threshold: int = 50

    # Feature weights (renormalized over the features actually computable).
    weight_skills: float = 0.40
    weight_experience: float = 0.20
    weight_education: float = 0.15
    weight_text: float = 0.15
    weight_vector: float = 0.10

    @property
    def feature_weights(self) -> dict[str, float]:
        return {
            'skills': self.weight_skills,
            'experience': self.weight_experience,
            'education': self.weight_education,
            'text': self.weight_text,
            'vector': self.weight_vector,
        }

    @property
    def sqlalchemy_url(self) -> str:
        """DATABASE_URL in the postgresql+psycopg:// form alembic expects."""
        url = self.database_url
        if url.startswith('postgres://'):
            url = 'postgresql://' + url[len('postgres://'):]
        if url.startswith('postgresql://'):
            return 'postgresql+psycopg://' + url[len('postgresql://'):]
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()
