"""Deterministic, offline MockProvider — the default when LLM_PROVIDER=mock
or no API key is configured. Every test runs against it.

- embed(): sha256-seeded pseudo-random unit vectors (same text → same vector).
- complete_structured(): for task='cv_parse' applies the deterministic
  heuristic parser over the CV text embedded in the prompt; for 'rerank'
  returns a deterministic no-op so rule-based subscores stand; for anything
  else produces a deterministic schema-shaped fill.
"""
from __future__ import annotations

import hashlib
import math
import random
import re

from ..config import get_settings
from ..pipeline.heuristics import parse_cv_text
from .base import LlmProvider

_CV_BLOCK_RE = re.compile(r'<<<CV\s*(.*?)\s*CV>>>', re.DOTALL)


def _extract_cv_text(prompt: str) -> str:
    m = _CV_BLOCK_RE.search(prompt)
    return m.group(1) if m else prompt


class MockProvider(LlmProvider):
    name = 'mock'

    def __init__(self, dim: int | None = None):
        self.dim = dim or get_settings().embedding_dim
        self.calls: list[dict] = []  # observability for tests

    async def embed(self, texts: list[str], *, correlation_id: str | None = None) -> list[list[float]]:
        out = []
        for text in texts:
            seed = int.from_bytes(hashlib.sha256(f'mock-emb|{text}'.encode()).digest()[:8], 'big')
            rng = random.Random(seed)
            vec = [rng.gauss(0.0, 1.0) for _ in range(self.dim)]
            norm = math.sqrt(sum(x * x for x in vec)) or 1.0
            out.append([x / norm for x in vec])
        self.calls.append({'op': 'embed', 'n': len(texts), 'correlation_id': correlation_id})
        return out

    async def complete_structured(
        self,
        prompt: str,
        schema: dict,
        *,
        task: str,
        timeout: float,
        correlation_id: str | None = None,
    ) -> dict:
        self.calls.append({'op': 'complete', 'task': task, 'correlation_id': correlation_id})
        if task == 'cv_parse':
            return parse_cv_text(_extract_cv_text(prompt))
        if task == 'rerank':
            return {
                'adjustments': {},
                'justification': 'mock provider: no rerank adjustment',
                'confidence': 0.0,
            }
        seed = int.from_bytes(hashlib.sha256(f'mock|{task}|{prompt}'.encode()).digest()[:8], 'big')
        rng = random.Random(seed)
        return self._fill(schema, rng)

    def _fill(self, schema: dict, rng: random.Random):
        t = schema.get('type')
        if 'enum' in schema:
            return schema['enum'][rng.randrange(len(schema['enum']))]
        if t == 'object' or 'properties' in schema:
            return {k: self._fill(v, rng) for k, v in (schema.get('properties') or {}).items()}
        if t == 'array':
            return [self._fill(schema.get('items', {'type': 'string'}), rng) for _ in range(rng.randrange(0, 3))]
        if t in ('number', 'integer'):
            return round(rng.random(), 4)
        if t == 'boolean':
            return rng.random() < 0.5
        return f'mock-{rng.randrange(10**6)}'
