"""Persistence helpers over psycopg — match_scores, match_jobs, embeddings.
All functions accept/return plain dicts and tolerate missing tables by letting
the caller decide (they raise; callers catch where degradation is OK).
"""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from .db import active_pool


def doc_hash(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def _vec_literal(vec: list[float]) -> str:
    return '[' + ','.join(f'{x:.6f}' for x in vec) + ']'


# -- match_scores ------------------------------------------------------------

async def get_match_score(candidate_id: int, vacancy_id: int, model_version: str, prompt_version: str) -> dict | None:
    async with active_pool().connection() as conn:
        cur = await conn.execute(
            'SELECT id, candidate_id, vacancy_id, score, subscores, explanation,'
            '       model_version, prompt_version, embedding_version, source, created_at'
            ' FROM match_scores'
            ' WHERE candidate_id = %s AND vacancy_id = %s AND model_version = %s AND prompt_version = %s',
            (candidate_id, vacancy_id, model_version, prompt_version),
        )
        row = await cur.fetchone()
    if not row:
        return None
    cols = ['id', 'candidate_id', 'vacancy_id', 'score', 'subscores', 'explanation',
            'model_version', 'prompt_version', 'embedding_version', 'source', 'created_at']
    out = dict(zip(cols, row))
    out['created_at'] = out['created_at'].isoformat() if out['created_at'] else None
    return out


async def upsert_match_score(
    candidate_id: int,
    vacancy_id: int,
    score: float,
    subscores: dict,
    explanation: dict,
    *,
    model_version: str,
    prompt_version: str,
    embedding_version: str,
    source: str,
) -> None:
    async with active_pool().connection() as conn:
        await conn.execute(
            'INSERT INTO match_scores (candidate_id, vacancy_id, score, subscores, explanation,'
            ' model_version, prompt_version, embedding_version, source)'
            ' VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)'
            ' ON CONFLICT (candidate_id, vacancy_id, model_version, prompt_version)'
            ' DO UPDATE SET score = EXCLUDED.score, subscores = EXCLUDED.subscores,'
            '   explanation = EXCLUDED.explanation, embedding_version = EXCLUDED.embedding_version,'
            '   source = EXCLUDED.source, created_at = now()',
            (
                candidate_id, vacancy_id, score, json.dumps(subscores), json.dumps(explanation),
                model_version, prompt_version, embedding_version, source,
            ),
        )


# -- embeddings ----------------------------------------------------------------

async def get_embedding(table: str, owner_id: int, model_version: str, dhash: str) -> list[float] | None:
    """Return stored embedding only when the doc_hash still matches (stale
    docs are re-embedded)."""
    assert table in ('candidate_embeddings', 'vacancy_embeddings')
    async with active_pool().connection() as conn:
        cur = await conn.execute(
            f'SELECT embedding::text FROM {table} WHERE owner_id = %s AND model_version = %s',
            (owner_id, model_version),
        )
        row = await cur.fetchone()
    if not row:
        return None
    return _parse_vec(row[0])


async def put_embedding(table: str, owner_id: int, model_version: str, vec: list[float], dhash: str) -> None:
    assert table in ('candidate_embeddings', 'vacancy_embeddings')
    async with active_pool().connection() as conn:
        await conn.execute(
            f'INSERT INTO {table} (owner_id, model_version, embedding, doc_hash)'
            ' VALUES (%s, %s, %s::vector, %s)'
            ' ON CONFLICT (owner_id, model_version)'
            ' DO UPDATE SET embedding = EXCLUDED.embedding, doc_hash = EXCLUDED.doc_hash, created_at = now()',
            (owner_id, model_version, _vec_literal(vec), dhash),
        )


async def get_embedding_with_hash(table: str, owner_id: int, model_version: str) -> tuple[list[float] | None, str | None]:
    assert table in ('candidate_embeddings', 'vacancy_embeddings')
    async with active_pool().connection() as conn:
        cur = await conn.execute(
            f'SELECT embedding::text, doc_hash FROM {table} WHERE owner_id = %s AND model_version = %s',
            (owner_id, model_version),
        )
        row = await cur.fetchone()
    if not row:
        return None, None
    return _parse_vec(row[0]), row[1]


def _parse_vec(text: str | list) -> list[float] | None:
    if isinstance(text, list):
        return [float(x) for x in text]
    if isinstance(text, str):
        return [float(x) for x in text.strip('[]').split(',') if x]
    return None


# -- match_jobs -----------------------------------------------------------------

async def create_job(job_type: str, idempotency_key: str, payload: dict) -> dict:
    async with active_pool().connection() as conn:
        cur = await conn.execute(
            'INSERT INTO match_jobs (type, idempotency_key, payload)'
            ' VALUES (%s, %s, %s)'
            ' ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key'
            ' RETURNING id, type, status, created_at, updated_at',
            (job_type, idempotency_key, json.dumps(payload)),
        )
        row = await cur.fetchone()
    return {'job_id': str(row[0]), 'type': row[1], 'status': row[2],
            'created_at': row[3].isoformat(), 'updated_at': row[4].isoformat()}


async def get_job(job_id: str) -> dict | None:
    try:
        jid = uuid.UUID(str(job_id))
    except ValueError:
        return None
    async with active_pool().connection() as conn:
        cur = await conn.execute(
            'SELECT id, type, status, result, error, attempts, created_at, updated_at'
            ' FROM match_jobs WHERE id = %s',
            (jid,),
        )
        row = await cur.fetchone()
    if not row:
        return None
    return {
        'job_id': str(row[0]), 'type': row[1], 'status': row[2],
        'result': row[3], 'error': row[4], 'attempts': row[5],
        'created_at': row[6].isoformat() if row[6] else None,
        'updated_at': row[7].isoformat() if row[7] else None,
    }


async def update_job(job_id: str, *, status: str, result: dict | None = None, error: str | None = None) -> None:
    async with active_pool().connection() as conn:
        await conn.execute(
            'UPDATE match_jobs SET status = %s, result = COALESCE(%s, result),'
            ' error = %s, attempts = attempts + 1, updated_at = now() WHERE id = %s',
            (status, json.dumps(result) if result is not None else None, error, job_id),
        )


# -- eval_datasets / eval_results -------------------------------------------------

async def upsert_eval_dataset(name: str, spec: dict) -> None:
    async with active_pool().connection() as conn:
        await conn.execute(
            'INSERT INTO eval_datasets (name, spec) VALUES (%s, %s)'
            ' ON CONFLICT (name) DO UPDATE SET spec = EXCLUDED.spec',
            (name, json.dumps(spec, default=str)),
        )


async def insert_eval_result(name: str, metrics: dict) -> int | None:
    async with active_pool().connection() as conn:
        cur = await conn.execute(
            'INSERT INTO eval_results (name, metrics) VALUES (%s, %s) RETURNING id',
            (name, json.dumps(metrics, default=str)),
        )
        row = await cur.fetchone()
    return int(row[0]) if row else None
