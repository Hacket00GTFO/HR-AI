"""Per-tenant monthly LLM budget gate, tracked in Redis.

Key: `llm:cost:<yyyymm>` accumulates estimated USD spend. When the configured
LLM_MONTHLY_BUDGET_USD is exceeded the gate denies further LLM calls and the
pipeline degrades to rule_based with `budget_exceeded: true`.

If Redis is unavailable the gate stays open (spend is still recorded to the
llm_usage table by providers when they do run).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


def _month_key(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    return f'llm:cost:{now:%Y%m}'


class BudgetGate:
    def __init__(self, redis_client, monthly_budget_usd: float):
        self._redis = redis_client
        self._budget = monthly_budget_usd

    def _key(self) -> str:
        return _month_key()

    async def spent(self) -> float:
        if self._redis is None:
            return 0.0
        try:
            val = await self._redis.get(self._key())
            return float(val or 0.0)
        except Exception as exc:
            logger.warning('budget check failed (redis): %s', exc)
            return 0.0

    async def allows(self) -> bool:
        return (await self.spent()) < self._budget

    async def record(self, cost_usd: float) -> None:
        if self._redis is None or cost_usd <= 0:
            return
        try:
            await self._redis.incrbyfloat(self._key(), cost_usd)
        except Exception as exc:
            logger.warning('budget record failed (redis): %s', exc)
