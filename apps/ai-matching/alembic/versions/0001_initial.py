"""initial schema: skills taxonomy, embeddings, match scores, jobs, llm usage, eval stubs

Revision ID: 0001_initial
Revises:
"""
from alembic import op

revision = '0001_initial'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute('CREATE EXTENSION IF NOT EXISTS vector')

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS canonical_skills (
            id          SERIAL PRIMARY KEY,
            name        TEXT NOT NULL UNIQUE,
            aliases     TEXT[] NOT NULL DEFAULT '{}',
            esco_uri    TEXT,
            category    TEXT NOT NULL DEFAULT 'general',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute('CREATE INDEX IF NOT EXISTS idx_canonical_skills_aliases ON canonical_skills USING GIN (aliases)')

    for table, owner in (('candidate_embeddings', 'candidate'), ('vacancy_embeddings', 'vacancy')):
        op.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {table} (
                id              SERIAL PRIMARY KEY,
                owner_id        INTEGER NOT NULL,
                model_version   TEXT NOT NULL,
                embedding       vector(1536) NOT NULL,
                doc_hash        TEXT NOT NULL,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (owner_id, model_version)
            )
            """
        )
        op.execute(
            f"""
            CREATE INDEX IF NOT EXISTS idx_{table}_hnsw
            ON {table} USING hnsw (embedding vector_cosine_ops)
            WITH (m = 16, ef_construction = 128)
            """
        )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS match_scores (
            id              SERIAL PRIMARY KEY,
            candidate_id    INTEGER NOT NULL,
            vacancy_id      INTEGER NOT NULL,
            score           REAL NOT NULL CHECK (score >= 0 AND score <= 1),
            subscores       JSONB NOT NULL DEFAULT '{}',
            explanation     JSONB NOT NULL DEFAULT '{}',
            model_version   TEXT NOT NULL,
            prompt_version  TEXT NOT NULL,
            embedding_version TEXT NOT NULL,
            source          TEXT NOT NULL CHECK (source IN ('rule_based', 'hybrid', 'llm_rerank')),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (candidate_id, vacancy_id, model_version, prompt_version)
        )
        """
    )
    op.execute('CREATE INDEX IF NOT EXISTS idx_match_scores_vacancy ON match_scores (vacancy_id, score DESC)')

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS match_jobs (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            type            TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            status          TEXT NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'running', 'done', 'failed')),
            payload         JSONB NOT NULL DEFAULT '{}',
            result          JSONB,
            error           TEXT,
            attempts        INTEGER NOT NULL DEFAULT 0,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS llm_usage (
            id              SERIAL PRIMARY KEY,
            ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
            provider        TEXT NOT NULL,
            model           TEXT NOT NULL,
            task            TEXT NOT NULL,
            tokens_in       INTEGER NOT NULL DEFAULT 0,
            tokens_out      INTEGER NOT NULL DEFAULT 0,
            est_cost_usd    NUMERIC(12, 6) NOT NULL DEFAULT 0,
            correlation_id  TEXT
        )
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS eval_datasets (
            id          SERIAL PRIMARY KEY,
            name        TEXT NOT NULL UNIQUE,
            spec        JSONB NOT NULL DEFAULT '{}',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS eval_results (
            id          SERIAL PRIMARY KEY,
            name        TEXT NOT NULL,
            metrics     JSONB NOT NULL DEFAULT '{}',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )


def downgrade() -> None:
    for t in (
        'eval_results', 'eval_datasets', 'llm_usage', 'match_jobs',
        'match_scores', 'candidate_embeddings', 'vacancy_embeddings',
        'canonical_skills',
    ):
        op.execute(f'DROP TABLE IF EXISTS {t}')
