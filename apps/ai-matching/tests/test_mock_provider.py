import pytest

from app.llm.mock import MockProvider
from app.llm.breaker import CircuitBreaker
from app.llm.base import ProviderUnavailable
from app.llm.factory import ProviderFacade
from app.pipeline.cv_parse import parse_cv


@pytest.mark.asyncio
async def test_mock_embeddings_deterministic():
    p = MockProvider(dim=32)
    a = await p.embed(['python developer'])
    b = await p.embed(['python developer'])
    c = await p.embed(['java developer'])
    assert a == b
    assert a != c
    assert len(a[0]) == 32
    assert abs(sum(x * x for x in a[0]) ** 0.5 - 1.0) < 1e-6  # unit vector


@pytest.mark.asyncio
async def test_mock_cv_parse_deterministic():
    p = MockProvider(dim=8)
    prompt = 'ctx\n<<<CV\nSenior dev, 6 years, Bachelor degree, python and django\nCV>>>'
    r1 = await p.complete_structured(prompt, {}, task='cv_parse', timeout=30)
    r2 = await p.complete_structured(prompt, {}, task='cv_parse', timeout=30)
    assert r1 == r2
    assert r1['experience_years'] == 6
    assert r1['education_level'] == 'bachelor'
    assert 'python' in r1['skills_raw']


def test_circuit_breaker_opens_and_half_opens():
    b = CircuitBreaker(failure_threshold=3, half_open_after_s=0)
    for _ in range(3):
        b.record_failure()
    assert b.state == CircuitBreaker.OPEN
    b.half_open_after_s = -1  # force elapsed
    assert b.allow() and b.state == CircuitBreaker.HALF_OPEN
    b.record_success()
    assert b.state == CircuitBreaker.CLOSED


class _AlwaysDown:
    class _Inner:
        name = 'alwaysdown'
        is_mock = False

        async def complete_structured(self, *a, **k):
            raise ProviderUnavailable('down')

        async def embed(self, *a, **k):
            raise ProviderUnavailable('down')

    def __init__(self):
        self._inner = self._Inner()


@pytest.mark.asyncio
async def test_rule_based_fallback_when_provider_down():
    """Provider unavailable → cv_parse still returns a profile via heuristics."""
    facade = ProviderFacade.__new__(ProviderFacade)
    facade._inner = _AlwaysDown._Inner()
    facade.breaker = CircuitBreaker(5, 30)
    facade.budget_exceeded = False
    facade.last_degrade_reason = None

    class _NoBudget:
        async def allows(self):
            return True

    facade.budget = _NoBudget()

    result = await parse_cv('5 years python developer, Bachelor degree', facade)
    assert result['source'] == 'rule_based'
    assert result['experience_years'] == 5
    assert 'python' in result['skills_canonical']
