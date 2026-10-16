"""Private (self-hosted) inference provider — OpenAI-compatible endpoint
served by vLLM or Ollama inside private infrastructure. Labor data never
leaves the network; production policy in factory.py refuses public
providers outright.

- vLLM accepts response_format json_schema natively (private_strict_schema=True).
- Ollama does not: set PRIVATE_STRICT_SCHEMA=false to send
  response_format={'type': 'json_object'} and validate the decoded payload
  against the requested schema locally — a validation failure is logged and
  surfaced as ProviderUnavailable so the pipeline degrades cleanly.
"""
from __future__ import annotations

import logging
from typing import Any

from ..config import get_settings
from .base import ProviderUnavailable
from .openai import OpenAIProvider

logger = logging.getLogger(__name__)


class PrivateProvider(OpenAIProvider):
    name = 'private'

    def __init__(self):
        s = get_settings()
        if not s.private_llm_base_url:
            raise ProviderUnavailable('PRIVATE_LLM_BASE_URL is not configured')
        super().__init__(s.private_llm_api_key or 'none', base_url=s.private_llm_base_url)

    def _embed_model(self) -> str:
        return self._settings.private_embedding_model

    def _chat_model(self, task: str) -> str:
        s = self._settings
        return s.private_parse_model if task == 'cv_parse' else s.private_rerank_model

    def _response_format(self, task: str, schema: dict) -> dict:
        if self._settings.private_strict_schema:
            return super()._response_format(task, schema)
        return {'type': 'json_object'}

    async def complete_structured(
        self,
        prompt: str,
        schema: dict,
        *,
        task: str,
        timeout: float,
        correlation_id: str | None = None,
    ) -> dict:
        result = await super().complete_structured(
            prompt, schema, task=task, timeout=timeout, correlation_id=correlation_id
        )
        if not self._settings.private_strict_schema:
            errors = list(_schema_errors(result, schema))
            if errors:
                logger.warning(
                    'private provider %s response failed local schema validation: %s',
                    task, '; '.join(errors[:3]),
                )
                raise ProviderUnavailable(
                    f'private provider response failed schema validation: {errors[0]}')
        return result


# ---------------------------------------------------------------------------
# minimal local schema validation (only used when strict_schema is off)
# ---------------------------------------------------------------------------

_TYPE_CHECKS = {
    'object': lambda v: isinstance(v, dict),
    'array': lambda v: isinstance(v, list),
    'string': lambda v: isinstance(v, str),
    'integer': lambda v: isinstance(v, int) and not isinstance(v, bool),
    'number': lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    'boolean': lambda v: isinstance(v, bool),
    'null': lambda v: v is None,
}


def _schema_errors(value: Any, schema: dict, path: str = '$'):
    """Yield human-readable violations of `schema` in `value`. Deliberately
    partial: covers the shapes this service actually requests (objects with
    required keys, typed properties, arrays, additionalProperties maps)."""
    if not isinstance(schema, dict):
        return
    expected = schema.get('type')
    if expected:
        types = expected if isinstance(expected, list) else [expected]
        if not any(_TYPE_CHECKS.get(t, lambda v: True)(value) for t in types):
            yield f'{path}: expected {"|".join(types)}, got {type(value).__name__}'
            return
    if isinstance(value, dict):
        for key in schema.get('required') or []:
            if key not in value:
                yield f'{path}: missing required key {key!r}'
        properties = schema.get('properties') or {}
        additional = schema.get('additionalProperties')
        for key, item in value.items():
            if key in properties:
                yield from _schema_errors(item, properties[key], f'{path}.{key}')
            elif isinstance(additional, dict):
                yield from _schema_errors(item, additional, f'{path}.{key}')
    elif isinstance(value, list):
        items = schema.get('items')
        if isinstance(items, dict):
            for i, item in enumerate(value):
                yield from _schema_errors(item, items, f'{path}[{i}]')
