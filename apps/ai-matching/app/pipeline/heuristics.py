"""Deterministic rule-based CV parsing — used as the offline fallback when no
LLM provider is available, and by MockProvider to keep tests meaningful.
No imports from app.llm (avoids cycles)."""
from __future__ import annotations

import json
import re
from pathlib import Path

_YEARS_RE = re.compile(r'(\d{1,2})\s*(?:\+?\s*)(?:years?|yrs?)\b', re.IGNORECASE)

_LANGS = {
    'english', 'spanish', 'french', 'german', 'portuguese', 'italian',
    'dutch', 'chinese', 'mandarin', 'japanese', 'korean', 'hindi', 'arabic',
    'russian', 'turkish', 'polish', 'swedish',
}

_SKILLS_CACHE: list[dict] | None = None


def _norm(text: str) -> str:
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9+#. ]+', ' ', (text or '').lower())).strip()


def _seed_entries() -> list[dict]:
    global _SKILLS_CACHE
    if _SKILLS_CACHE is None:
        path = Path(__file__).resolve().parents[2] / 'seeds' / 'skills_seed.json'
        with open(path, encoding='utf-8') as fh:
            _SKILLS_CACHE = json.load(fh)
    return _SKILLS_CACHE


def detect_education_level(text: str) -> str:
    t = (text or '').lower()
    if re.search(r'\b(ph\.?\s?d|doctorate|doctoral)\b', t):
        return 'phd'
    if re.search(r'\b(masters?|msc|m\.sc|mba|m\.b\.a|maestr[ií]a)\b', t):
        return 'master'
    if re.search(r'\b(bachelors?|bsc|b\.sc|b\.a\.?|undergraduate|licenciatura|degree)\b', t):
        return 'bachelor'
    if re.search(r'\b(high\s*school|secondary school|bachillerato)\b', t):
        return 'high_school'
    return 'none'


def detect_skills(text: str) -> list[str]:
    norm = f' {_norm(text)} '
    found, seen = [], set()
    for entry in _seed_entries():
        for cand in [entry['name']] + list(entry.get('aliases') or []):
            c = _norm(cand)
            if len(c) < 2:
                continue
            if f' {c} ' in norm or f' {c},' in norm or f' {c}.' in norm:
                if entry['name'] not in seen:
                    seen.add(entry['name'])
                    found.append(entry['name'])
                break
    return found


def detect_years(text: str) -> int:
    years = 0
    for m in _YEARS_RE.finditer(text or ''):
        years = max(years, int(m.group(1)))
    return years


def detect_languages(text: str) -> list[str]:
    t = (text or '').lower()
    return sorted(lang for lang in _LANGS if re.search(rf'\b{lang}\b', t))


def detect_certifications(text: str) -> list[str]:
    return [ln.strip() for ln in (text or '').splitlines() if 'certif' in ln.lower()][:10]


def seniority_for_years(years: int) -> str:
    if years >= 9:
        return 'lead'
    if years >= 5:
        return 'senior'
    if years >= 2:
        return 'mid'
    return 'junior'


def parse_cv_text(text: str) -> dict:
    """Deterministic heuristic CV → CandidateProfile dict."""
    years = detect_years(text)
    return {
        'experience_years': years,
        'education_level': detect_education_level(text),
        'skills_raw': detect_skills(text),
        'languages': detect_languages(text),
        'certifications': detect_certifications(text),
        'seniority': seniority_for_years(years),
    }
