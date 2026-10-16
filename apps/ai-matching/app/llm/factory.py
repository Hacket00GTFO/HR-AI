"""Provider construction + resilience facade.

get_provider() returns a ProviderFacade wrapping the configured backend:
  LLM_PROVIDER=openai    + OPENAI_API_KEY    → OpenAIProvider
  LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY → AnthropicProvider
  LLM_PROVIDER=private   + PRIVATE_LLM_BASE_URL → PrivateProvider (self-hosted)
  anything else / no key                     → MockProvider (deterministic)

The facade applies the circuit breaker and the monthly budget gate; failures
surface as ProviderUnavailable so the pipeline degrades to rule_based.

Production policy (ENV/NODE_ENV=production|prod) fails closed: public
providers are refused at startup — labor data must never leave private
infrastructure. validate_provider_policy() runs the check without building
the provider; the FastAPI lifespan and the Celery worker call it eagerly.
"""
from __future__ import annotations

import logging

from ..config import get_settings
from .base import LlmProvider, ProviderUnavailable
from .breaker import CircuitBreaker
from .budget import BudgetGate
from .mock import MockProvider

logger = logging.getLogger(__name__)

# Providers that send candidate/vacancy payloads to third-party APIs.
PUBLIC_PROVIDERS = {'openai', 'anthropic'}
_PRODUCTION_ENVS = {'production', 'prod'}


def validate_provider_policy() -> None:
    """Fail-closed provider policy — called at startup (API lifespan, Celery
    worker import) and again inside _build_inner() as a last line of defense.

    Raises RuntimeError when the configured provider is unsafe for the
    environment; never returns a degraded provider silently in production.
    """
    s = get_settings()
    kind = (s.llm_provider or 'mock').lower()
    if (s.env or '').strip().lower() not in _PRODUCTION_ENVS:
        return
    if kind in PUBLIC_PROVIDERS:
        raise RuntimeError(
            f'LLM_PROVIDER={kind!r} is forbidden in production — labor data '
            'must never leave private infrastructure; use LLM_PROVIDER=private '
            'with PRIVATE_LLM_BASE_URL pointing at the self-hosted endpoint')
    if kind == 'private' and not s.private_llm_base_url:
        raise RuntimeError(
            'LLM_PROVIDER=private in production requires PRIVATE_LLM_BASE_URL')

_redis = None


def get_redis():
    """Lazy redis.asyncio client; None when unreachable is tolerated by callers."""
    global _redis
    if _redis is None:
        try:
            import redis.asyncio as aioredis

            _redis = aioredis.from_url(get_settings().redis_url, decode_responses=True)
        except Exception as exc:
            logger.warning('redis client init failed: %s', exc)
    return _redis


class BudgetExceeded(ProviderUnavailable):
    def __init__(self):
        super().__init__('budget_exceeded')
        self.reason = 'budget_exceeded'


class ProviderFacade(LlmProvider):
    def __init__(self, inner: LlmProvider):
        s = get_settings()
        self._inner = inner
        self.breaker = CircuitBreaker(s.breaker_failure_threshold, s.breaker_half_open_after_s)
        self.budget = BudgetGate(get_redis(), s.llm_monthly_budget_usd)
        self.last_degrade_reason: str | None = None
        self.budget_exceeded = False

    @property
    def name(self) -> str:
        return self._inner.name

    @property
    def is_mock(self) -> bool:
        return isinstance(self._inner, MockProvider)

    def state(self) -> dict:
        return {
            'provider': self.name,
            'circuit': self.breaker.state,
            'budget_exceeded': self.budget_exceeded,
            'degrade_reason': self.last_degrade_reason,
        }

    async def _guard(self) -> None:
        if not self.breaker.allow():
            self.last_degrade_reason = 'circuit_open'
            raise ProviderUnavailable('circuit_open')
        if not self.is_mock and not await self.budget.allows():
            self.last_degrade_reason = 'budget_exceeded'
            self.budget_exceeded = True
            raise BudgetExceeded()

    async def complete_structured(self, prompt, schema, *, task, timeout, correlation_id=None) -> dict:
        await self._guard()
        try:
            result = await self._inner.complete_structured(
                prompt, schema, task=task, timeout=timeout, correlation_id=correlation_id
            )
        except ProviderUnavailable:
            self.breaker.record_failure()
            self.last_degrade_reason = 'provider_error'
            raise
        except Exception as exc:
            self.breaker.record_failure()
            self.last_degrade_reason = 'provider_error'
            raise ProviderUnavailable(str(exc)) from exc
        self.breaker.record_success()
        return result

    async def embed(self, texts, *, correlation_id=None):
        await self._guard()
        try:
            result = await self._inner.embed(texts, correlation_id=correlation_id)
        except ProviderUnavailable:
            self.breaker.record_failure()
            self.last_degrade_reason = 'provider_error'
            raise
        except Exception as exc:
            self.breaker.record_failure()
            self.last_degrade_reason = 'provider_error'
            raise ProviderUnavailable(str(exc)) from exc
        self.breaker.record_success()
        return result


_provider: ProviderFacade | None = None


def _build_inner() -> LlmProvider:
    validate_provider_policy()
    s = get_settings()
    kind = (s.llm_provider or 'mock').lower()
    if kind == 'private':
        if not s.private_llm_base_url:
            logger.warning(
                'LLM_PROVIDER=private but PRIVATE_LLM_BASE_URL is unset '
                '(dev only) — using deterministic mock')
            return MockProvider()
        from .private import PrivateProvider

        return PrivateProvider()
    if kind == 'openai' and s.openai_api_key:
        from .openai import OpenAIProvider

        return OpenAIProvider(s.openai_api_key)
    if kind == 'anthropic' and s.anthropic_api_key:
        from .anthropic import AnthropicProvider

        return AnthropicProvider(s.anthropic_api_key)
    if kind not in ('mock', 'openai', 'anthropic', 'private'):
        logger.warning('unknown LLM_PROVIDER=%r — using mock', kind)
    elif kind != 'mock':
        logger.warning('LLM_PROVIDER=%s but no API key — using deterministic mock', kind)
    return MockProvider()


def get_provider() -> ProviderFacade:
    global _provider
    if _provider is None:
        _provider = ProviderFacade(_build_inner())
    return _provider


def reset_provider() -> None:
    """Test hook."""
    global _provider
    _provider = None
