from __future__ import annotations

from abc import ABC, abstractmethod


class ProviderUnavailable(Exception):
    """Raised when the configured LLM provider cannot serve the request —
    circuit open, budget exhausted, or a hard upstream failure. Callers must
    degrade to the rule-based path."""


class LlmProvider(ABC):
    name: str = 'abstract'

    @abstractmethod
    async def complete_structured(
        self,
        prompt: str,
        schema: dict,
        *,
        task: str,
        timeout: float,
        correlation_id: str | None = None,
    ) -> dict:
        """Return a dict conforming to `schema` (JSON Schema)."""

    @abstractmethod
    async def embed(
        self,
        texts: list[str],
        *,
        correlation_id: str | None = None,
    ) -> list[list[float]]:
        """Return one embedding vector per input text."""


def _is_mock(provider) -> bool:
    """True for MockProvider or a facade wrapping it (facades expose is_mock)."""
    return getattr(provider, 'is_mock', provider.__class__.__name__ == 'MockProvider')
