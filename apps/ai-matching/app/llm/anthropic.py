"""Anthropic provider (claude-haiku) implementing the same LlmProvider ABC.

Structured output is requested via a forced tool_use block. Anthropic has no
first-party embeddings API — embed() raises ProviderUnavailable so the
pipeline degrades the vector feature while keeping everything else.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random

import httpx

from ..config import get_settings
from .base import LlmProvider, ProviderUnavailable
from .usage import record_usage

logger = logging.getLogger(__name__)

BASE_URL = 'https://api.anthropic.com/v1'
API_VERSION = '2023-06-01'
_RETRYABLE = {408, 409, 429, 500, 502, 503, 504, 529}


class AnthropicProvider(LlmProvider):
    name = 'anthropic'

    def __init__(self, api_key: str, *, base_url: str = BASE_URL):
        self._key = api_key
        self._base = base_url
        self._settings = get_settings()

    async def _post(self, path: str, payload: dict, timeout: float) -> httpx.Response:
        last_exc: Exception | None = None
        for attempt in range(self._settings.llm_max_retries):
            try:
                async with httpx.AsyncClient(
                    base_url=self._base,
                    headers={
                        'x-api-key': self._key,
                        'anthropic-version': API_VERSION,
                    },
                    timeout=httpx.Timeout(timeout),
                ) as client:
                    resp = await client.post(path, json=payload)
                if resp.status_code in _RETRYABLE:
                    raise _RetryableHttp(resp.status_code, resp.text[:200])
                resp.raise_for_status()
                return resp
            except _RetryableHttp as exc:
                last_exc = exc
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_exc = exc
            await asyncio.sleep((0.5 * (2 ** attempt)) * (1 + random.random() * 0.5))
        raise ProviderUnavailable(f'anthropic request failed after retries: {last_exc}')

    async def embed(self, texts: list[str], *, correlation_id: str | None = None) -> list[list[float]]:
        raise ProviderUnavailable('anthropic provider does not support embeddings')

    async def complete_structured(
        self,
        prompt: str,
        schema: dict,
        *,
        task: str,
        timeout: float,
        correlation_id: str | None = None,
    ) -> dict:
        model = (
            self._settings.anthropic_parse_model if task == 'cv_parse' else self._settings.anthropic_rerank_model
        )
        payload = {
            'model': model,
            'max_tokens': 2048,
            'temperature': 0,
            'system': 'You are a precise information-extraction engine. Output only via the provided tool.',
            'messages': [{'role': 'user', 'content': prompt}],
            'tools': [{
                'name': f'strafor_{task}',
                'description': 'Return the structured result.',
                'input_schema': schema,
            }],
            'tool_choice': {'type': 'tool', 'name': f'strafor_{task}'},
        }
        resp = await self._post('/messages', payload, timeout)
        data = resp.json()
        usage = data.get('usage') or {}
        from ..db import get_async_pool

        await record_usage(
            get_async_pool(), provider=self.name, model=model, task=task,
            tokens_in=usage.get('input_tokens', 0),
            tokens_out=usage.get('output_tokens', 0),
            correlation_id=correlation_id,
        )
        for block in data.get('content', []):
            if block.get('type') == 'tool_use':
                return block['input']
        raise ProviderUnavailable('anthropic response contained no tool_use block')


class _RetryableHttp(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f'HTTP {status}: {body}')
        self.status = status
