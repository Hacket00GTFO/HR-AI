"""OpenAI provider: chat completions w/ JSON-schema structured outputs +
text-embedding-3-*. Retries with exponential backoff + jitter on 429/5xx
(max 4 attempts); per-call timeouts are set by the caller.
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

BASE_URL = 'https://api.openai.com/v1'
_RETRYABLE = {408, 409, 425, 429, 500, 502, 503, 504}


class OpenAIProvider(LlmProvider):
    name = 'openai'

    def __init__(self, api_key: str, *, base_url: str = BASE_URL):
        self._key = api_key
        self._base = base_url
        self._settings = get_settings()

    def _client(self, timeout: float) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self._base,
            headers={'Authorization': f'Bearer {self._key}'},
            timeout=httpx.Timeout(timeout),
        )

    # Hooks overridden by PrivateProvider (self-hosted OpenAI-compatible API).
    def _embed_model(self) -> str:
        return self._settings.embedding_model

    def _chat_model(self, task: str) -> str:
        return self._settings.llm_parse_model if task == 'cv_parse' else self._settings.llm_rerank_model

    def _response_format(self, task: str, schema: dict) -> dict:
        return {
            'type': 'json_schema',
            'json_schema': {'name': f'strafor_{task}', 'schema': schema, 'strict': True},
        }

    async def _post(self, path: str, payload: dict, timeout: float) -> httpx.Response:
        last_exc: Exception | None = None
        for attempt in range(self._settings.llm_max_retries):
            try:
                async with self._client(timeout) as client:
                    resp = await client.post(path, json=payload)
                if resp.status_code in _RETRYABLE:
                    raise _RetryableHttp(resp.status_code, resp.text[:200])
                resp.raise_for_status()
                return resp
            except _RetryableHttp as exc:
                last_exc = exc
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_exc = exc
            # exp backoff with jitter: 0.5s, 1s, 2s, 4s (+ up to 50% jitter)
            delay = (0.5 * (2 ** attempt)) * (1 + random.random() * 0.5)
            await asyncio.sleep(delay)
        raise ProviderUnavailable(f'openai request failed after retries: {last_exc}')

    async def embed(self, texts: list[str], *, correlation_id: str | None = None) -> list[list[float]]:
        model = self._embed_model()
        resp = await self._post(
            '/embeddings',
            {'model': model, 'input': texts},
            self._settings.llm_embed_timeout,
        )
        data = resp.json()
        usage = data.get('usage') or {}
        from ..db import get_async_pool

        await record_usage(
            get_async_pool(), provider=self.name, model=model, task='embed',
            tokens_in=usage.get('prompt_tokens', 0), tokens_out=0,
            correlation_id=correlation_id,
        )
        return [item['embedding'] for item in sorted(data['data'], key=lambda d: d['index'])]

    async def complete_structured(
        self,
        prompt: str,
        schema: dict,
        *,
        task: str,
        timeout: float,
        correlation_id: str | None = None,
    ) -> dict:
        model = self._chat_model(task)
        payload = {
            'model': model,
            'messages': [
                {'role': 'system', 'content': 'You are a precise information-extraction engine. Output only JSON matching the provided schema.'},
                {'role': 'user', 'content': prompt},
            ],
            'response_format': self._response_format(task, schema),
            'temperature': 0,
        }
        resp = await self._post('/chat/completions', payload, timeout)
        data = resp.json()
        usage = data.get('usage') or {}
        from ..db import get_async_pool

        await record_usage(
            get_async_pool(), provider=self.name, model=model, task=task,
            tokens_in=usage.get('prompt_tokens', 0),
            tokens_out=usage.get('completion_tokens', 0),
            correlation_id=correlation_id,
        )
        content = data['choices'][0]['message']['content']
        return json.loads(content)


class _RetryableHttp(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f'HTTP {status}: {body}')
        self.status = status
