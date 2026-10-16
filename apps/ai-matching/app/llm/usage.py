"""Cost estimation + llm_usage persistence (best-effort, never raises)."""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# USD per 1M tokens: (input, output). Rough public list prices — adjust as
# pricing changes; underestimation is acceptable for a budget gate.
RATES: dict[str, tuple[float, float]] = {
    'gpt-4o-mini': (0.15, 0.60),
    'gpt-4o': (2.50, 10.00),
    'text-embedding-3-small': (0.02, 0.0),
    'text-embedding-3-large': (0.13, 0.0),
    'claude-haiku-4-5-20251001': (1.00, 5.00),
    'claude-sonnet-4-5-20250929': (3.00, 15.00),
    # Self-hosted private inference — no third-party spend, must never trip
    # the budget gate.
    'private': (0.0, 0.0),
    'qwen3-8b-instruct': (0.0, 0.0),
    'bge-m3': (0.0, 0.0),
}
DEFAULT_RATE = (1.00, 5.00)


def estimate_cost_usd(model: str, tokens_in: int, tokens_out: int) -> float:
    rin, rout = RATES.get(model, DEFAULT_RATE)
    return round((tokens_in * rin + tokens_out * rout) / 1_000_000, 6)


async def record_usage(
    pool,
    *,
    provider: str,
    model: str,
    task: str,
    tokens_in: int,
    tokens_out: int,
    correlation_id: str | None = None,
) -> float:
    """Insert one llm_usage row; returns the estimated cost."""
    cost = estimate_cost_usd(model, tokens_in, tokens_out)
    try:
        async with pool.connection() as conn:
            await conn.execute(
                'INSERT INTO llm_usage (provider, model, task, tokens_in, tokens_out, est_cost_usd, correlation_id)'
                ' VALUES (%s, %s, %s, %s, %s, %s, %s)',
                (provider, model, task, tokens_in, tokens_out, cost, correlation_id),
            )
    except Exception as exc:
        logger.warning('llm_usage insert failed: %s', exc)
    return cost
