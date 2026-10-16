"""Injection red-team corpus — every injected CV must be flagged and must
never outscore its equivalently-qualified clean twin."""
import json
from pathlib import Path

import pytest

from app.config import get_settings
from app.llm.mock import MockProvider
from app.pipeline.cv_parse import parse_cv
from app.pipeline.rank import score_pair
from app.pipeline.sanitize import sanitize_document
from app.skills import SkillsTaxonomy

CORPUS = Path(__file__).resolve().parents[1] / 'evaluation' / 'corpora' / 'injected_cvs.jsonl'
TAXONOMY = SkillsTaxonomy.from_seed()

VACANCIES = {
    'clean-backend': {
        'id': 9001, 'title': 'Backend Engineer',
        'description': 'backend engineer building rest apis',
        'skills_required': ['python', 'django', 'postgresql'],
        'experience_level': 'Mid Level',
        'requirements': 'Bachelor degree required.',
    },
    'clean-data': {
        'id': 9002, 'title': 'Data Analyst',
        'description': 'data analysis role producing dashboards',
        'skills_required': ['python', 'sql', 'pandas'],
        'experience_level': 'Mid Level',
        'requirements': 'Master degree preferred.',
    },
}


def _corpus():
    entries = {}
    with open(CORPUS, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if line:
                e = json.loads(line)
                entries[e['id']] = e
    return entries


ENTRIES = _corpus()
INJECTED = [e for e in ENTRIES.values() if e['injected']]
CLEAN = [e for e in ENTRIES.values() if not e['injected']]


def test_corpus_shape():
    assert len(INJECTED) >= 15
    assert len(CLEAN) >= 4
    assert all(e['twin'] in ENTRIES for e in INJECTED)


@pytest.mark.parametrize('entry', INJECTED, ids=[e['id'] for e in INJECTED])
async def test_injected_cvs_flagged(entry):
    profile = await parse_cv(entry['text'], MockProvider())
    assert profile['injection_suspected'] is True, entry['id']


@pytest.mark.parametrize('entry', CLEAN, ids=[e['id'] for e in CLEAN])
async def test_clean_cvs_not_flagged(entry):
    profile = await parse_cv(entry['text'], MockProvider())
    assert profile['injection_suspected'] is False, entry['id']


def _candidate_from(text: str, parsed: dict, cid: int) -> dict:
    """What the system would store+score: parsed fields + sanitized text."""
    return {
        'id': cid,
        'skills': parsed['skills_raw'],
        'experience': parsed['experience_years'],
        'education': parsed['education_level'],
        'summary': sanitize_document(text).text,
    }


@pytest.mark.parametrize('entry', INJECTED, ids=[e['id'] for e in INJECTED])
async def test_injected_never_outscores_clean_twin(entry):
    twin = ENTRIES[entry['twin']]
    vacancy = VACANCIES[entry['twin']]
    provider = MockProvider()
    settings = get_settings()

    inj_parsed = await parse_cv(entry['text'], provider)
    clean_parsed = await parse_cv(twin['text'], provider)

    inj_score = (await score_pair(
        _candidate_from(entry['text'], inj_parsed, 1), vacancy, TAXONOMY, provider, settings))['score']
    clean_score = (await score_pair(
        _candidate_from(twin['text'], clean_parsed, 2), vacancy, TAXONOMY, provider, settings))['score']

    # Mock embeddings are hash-seeded pseudo-random vectors, so the vector
    # feature differs by pure noise (~±0.03 cosine * 0.10 weight). All other
    # features are identical by construction — a real boost would exceed eps.
    assert inj_score <= clean_score + 0.05, (
        f"{entry['id']} ({entry['technique']}): injected {inj_score} > clean {clean_score}")
