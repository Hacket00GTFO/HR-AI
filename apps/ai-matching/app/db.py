"""Database access.

The FastAPI app uses an async psycopg pool; the Celery worker uses a sync
pool. Both tolerate the database being absent at startup — connections are
acquired lazily and /ready reports the real state.
"""
from __future__ import annotations

import contextvars
import logging

from psycopg_pool import AsyncConnectionPool, ConnectionPool

from .config import get_settings

logger = logging.getLogger(__name__)

_async_pool: AsyncConnectionPool | None = None
_sync_pool: ConnectionPool | None = None

# Celery tasks run on fresh event loops; they set a per-task pool here so the
# shared global pool (bound to the FastAPI loop) is never reused cross-loop.
_current_pool: contextvars.ContextVar[AsyncConnectionPool | None] = contextvars.ContextVar(
    'ai_matching_current_pool', default=None
)


def active_pool() -> AsyncConnectionPool:
    return _current_pool.get() or get_async_pool()


def get_async_pool() -> AsyncConnectionPool:
    global _async_pool
    if _async_pool is None:
        _async_pool = AsyncConnectionPool(
            get_settings().database_url, min_size=1, max_size=10, open=False,
            timeout=5, kwargs={'connect_timeout': 3},
        )
    return _async_pool


def get_sync_pool() -> ConnectionPool:
    global _sync_pool
    if _sync_pool is None:
        _sync_pool = ConnectionPool(
            get_settings().database_url, min_size=1, max_size=4, open=False,
            timeout=5, kwargs={'connect_timeout': 3},
        )
    return _sync_pool


async def open_pools() -> None:
    try:
        await get_async_pool().open(wait=False)
    except Exception as exc:  # pragma: no cover - depends on env
        logger.warning('async db pool open failed: %s', exc)


async def close_pools() -> None:
    global _async_pool, _sync_pool
    if _async_pool is not None:
        await _async_pool.close()
        _async_pool = None
    if _sync_pool is not None:
        _sync_pool.close()
        _sync_pool = None


async def db_alive() -> bool:
    try:
        async with get_async_pool().connection() as conn:
            await conn.execute('SELECT 1')
        return True
    except Exception:
        return False


def db_alive_sync() -> bool:
    try:
        with get_sync_pool().connection() as conn:
            conn.execute('SELECT 1')
        return True
    except Exception:
        return False
