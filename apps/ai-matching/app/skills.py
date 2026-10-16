"""Canonical skills taxonomy.

Resolution order for a raw skill string:
  1. exact match on canonical name
  2. exact match on a registered alias
  3. embedding cosine similarity >= EMBEDDING_SKILL_THRESHOLD (only when a
     provider is available)

This replaces the old substring matcher — 'r' resolves to the R language,
never to 'ruby'; 'java' never to 'javascript'.
"""
from __future__ import annotations

import json
import logging
import math
import re
import unicodedata
from pathlib import Path

from .config import get_settings

logger = logging.getLogger(__name__)

SEED_PATH = Path(__file__).resolve().parent.parent / 'seeds' / 'skills_seed.json'

_NON_ALNUM = re.compile(r'[^a-z0-9+#. ]+')
_WS = re.compile(r'\s+')


def normalize_text(raw: str) -> str:
    """Lowercase, accent-fold, collapse whitespace/punctuation variants so
    'React.js'/'reactjs'/'React JS' all funnel to the same alias bucket."""
    text = unicodedata.normalize('NFKD', raw or '')
    text = ''.join(c for c in text if not unicodedata.combining(c))
    text = text.lower().strip()
    text = _NON_ALNUM.sub(' ', text)
    return _WS.sub(' ', text).strip()


def _squash(text: str) -> str:
    """Aggressive form used only for alias lookup: removes spaces/dots so
    'react.js', 'react js' and 'reactjs' collapse together."""
    return re.sub(r'[\s.\-_/]+', '', text)


class SkillsTaxonomy:
    def __init__(self, entries: list[dict]):
        self._by_name: dict[str, dict] = {}
        self._alias: dict[str, str] = {}       # normalized alias -> canonical name
        self._squashed: dict[str, str] = {}    # squashed alias -> canonical name
        for e in entries:
            name = e['name']
            self._by_name[name] = e
            self._alias[normalize_text(name)] = name
            self._squashed[_squash(normalize_text(name))] = name
            for alias in e.get('aliases') or []:
                self._alias[normalize_text(alias)] = name
                self._squashed[_squash(normalize_text(alias))] = name

    # -- loading -----------------------------------------------------------

    @classmethod
    def from_seed(cls, path: Path = SEED_PATH) -> 'SkillsTaxonomy':
        with open(path, encoding='utf-8') as fh:
            return cls(json.load(fh))

    @classmethod
    async def load(cls) -> 'SkillsTaxonomy':
        """Prefer the DB table; fall back to the bundled seed file."""
        try:
            from .db import get_async_pool

            async with get_async_pool().connection() as conn:
                rows = await (
                    await conn.execute(
                        'SELECT name, aliases, esco_uri, category FROM canonical_skills'
                    )
                ).fetchall()
            if rows:
                return cls([
                    {'name': r[0], 'aliases': list(r[1] or []), 'esco_uri': r[2], 'category': r[3]}
                    for r in rows
                ])
        except Exception as exc:
            logger.warning('canonical_skills unavailable (%s); using seed file', exc)
        return cls.from_seed()

    # -- lookup ------------------------------------------------------------

    def __len__(self) -> int:
        return len(self._by_name)

    def get(self, name: str) -> dict | None:
        return self._by_name.get(name)

    def names(self) -> list[str]:
        return list(self._by_name)

    def search(self, query: str, limit: int = 10) -> list[dict]:
        """Prefix/substring search for UI autocomplete — bounded, no fuzzy
        equality (normalization is what protects matching)."""
        q = normalize_text(query)
        if not q:
            return []
        scored = []
        for name in self._by_name:
            if name.startswith(q):
                scored.append((0, name))
            elif q in name:
                scored.append((1, name))
            else:
                entry = self._by_name[name]
                if any(q in normalize_text(a) for a in entry.get('aliases') or []):
                    scored.append((2, name))
        scored.sort()
        return [self._by_name[n] for _, n in scored[:limit]]

    def resolve(self, raw: str) -> str | None:
        """Exact → alias resolution. Returns the canonical name or None."""
        if not raw:
            return None
        norm = normalize_text(raw)
        if norm in self._alias:
            return self._alias[norm]
        squashed = _squash(norm)
        if squashed and squashed in self._squashed:
            return self._squashed[squashed]
        return None

    async def resolve_with_embedding(self, raw: str, provider) -> str | None:
        """Alias resolution plus a last-resort embedding similarity check."""
        hit = self.resolve(raw)
        if hit:
            return hit
        if provider is None:
            return None
        try:
            names = self.names()
            [qvec] = await provider.embed([normalize_text(raw)])
            vecs = await provider.embed(names)
            best, best_sim = None, 0.0
            for name, vec in zip(names, vecs):
                sim = _cosine(qvec, vec)
                if sim > best_sim:
                    best, best_sim = name, sim
            if best_sim >= get_settings().embedding_skill_threshold:
                return best
        except Exception as exc:
            logger.warning('embedding skill resolution failed: %s', exc)
        return None

    async def normalize_many(self, raw_skills: list[str], provider=None) -> tuple[list[str], list[str]]:
        """→ (canonical_names_deduped, unresolved_raws)."""
        canonical, unresolved = [], []
        seen = set()
        for raw in raw_skills or []:
            name = await self.resolve_with_embedding(raw, provider) if provider else self.resolve(raw)
            if name and name not in seen:
                seen.add(name)
                canonical.append(name)
            elif not name:
                unresolved.append(raw)
        return canonical, unresolved


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


_taxonomy: SkillsTaxonomy | None = None


async def get_taxonomy() -> SkillsTaxonomy:
    global _taxonomy
    if _taxonomy is None:
        _taxonomy = await SkillsTaxonomy.load()
    return _taxonomy


def set_taxonomy(t: SkillsTaxonomy | None) -> None:
    """Test hook."""
    global _taxonomy
    _taxonomy = t
