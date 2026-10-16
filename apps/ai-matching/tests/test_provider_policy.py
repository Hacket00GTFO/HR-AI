"""Provider policy (production fail-closed), PrivateProvider construction,
scoring-field projection, and rank visibility fields."""
import pytest

from app.config import get_settings
from app.llm import factory
from app.llm.base import ProviderUnavailable
from app.llm.mock import MockProvider
from app.pipeline.rank import rank_candidates
from app.scoring_fields import (
    CANDIDATE_SCORING_FIELDS, VACANCY_SCORING_FIELDS, project_for_scoring,
)
from app.skills import SkillsTaxonomy


@pytest.fixture()
def env_patch(monkeypatch):
    """Apply env vars, then drop the cached Settings/provider."""
    def apply(**env):
        for key, value in env.items():
            if value is None:
                monkeypatch.delenv(key, raising=False)
            else:
                monkeypatch.setenv(key, value)
        get_settings.cache_clear()
        factory.reset_provider()
        return get_settings()
    yield apply
    get_settings.cache_clear()
    factory.reset_provider()


# ---------------------------------------------------------------------------
# production policy
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('provider', ['openai', 'anthropic'])
def test_production_rejects_public_providers(env_patch, provider):
    env_patch(ENV='production', LLM_PROVIDER=provider)
    with pytest.raises(RuntimeError, match='forbidden in production'):
        factory.validate_provider_policy()


def test_production_rejects_public_provider_at_build(env_patch):
    env_patch(ENV='production', LLM_PROVIDER='openai', OPENAI_API_KEY='sk-x')
    with pytest.raises(RuntimeError):
        factory.get_provider()


def test_production_private_requires_base_url(env_patch):
    env_patch(ENV='production', LLM_PROVIDER='private', PRIVATE_LLM_BASE_URL=None)
    with pytest.raises(RuntimeError, match='PRIVATE_LLM_BASE_URL'):
        factory.validate_provider_policy()


def test_production_private_ok(env_patch):
    env_patch(ENV='production', LLM_PROVIDER='private',
              PRIVATE_LLM_BASE_URL='http://vllm.internal:8000/v1')
    factory.validate_provider_policy()  # must not raise
    provider = factory.get_provider()
    assert provider.name == 'private'
    assert provider.is_mock is False


def test_node_env_production_also_enforced(env_patch):
    env_patch(NODE_ENV='production', LLM_PROVIDER='anthropic')
    with pytest.raises(RuntimeError):
        factory.validate_provider_policy()


# ---------------------------------------------------------------------------
# private provider construction
# ---------------------------------------------------------------------------

def test_private_provider_builds(env_patch):
    env_patch(LLM_PROVIDER='private',
              PRIVATE_LLM_BASE_URL='http://ollama.internal:11434/v1')
    from app.llm.private import PrivateProvider

    provider = factory.get_provider()
    assert provider.name == 'private'
    inner = provider._inner
    assert isinstance(inner, PrivateProvider)
    assert inner._base == 'http://ollama.internal:11434/v1'
    assert inner._key == 'none'  # no PRIVATE_LLM_API_KEY → placeholder
    assert inner._chat_model('cv_parse') == 'qwen3-8b-instruct'
    assert inner._chat_model('rerank') == 'qwen3-8b-instruct'
    assert inner._embed_model() == 'bge-m3'


def test_private_provider_missing_url_dev_warns_to_mock(env_patch):
    env_patch(LLM_PROVIDER='private', PRIVATE_LLM_BASE_URL=None)
    provider = factory.get_provider()
    assert isinstance(provider._inner, MockProvider)


def test_private_provider_requires_base_url(env_patch):
    env_patch(PRIVATE_LLM_BASE_URL=None)
    from app.llm.private import PrivateProvider

    with pytest.raises(ProviderUnavailable):
        PrivateProvider()


def test_private_provider_relaxed_schema_mode(env_patch):
    s = env_patch(PRIVATE_LLM_BASE_URL='http://x/v1', PRIVATE_STRICT_SCHEMA='false')
    from app.llm.private import PrivateProvider, _schema_errors

    p = PrivateProvider()
    assert s.private_strict_schema is False
    assert p._response_format('rerank', {}) == {'type': 'json_object'}
    # local validator: catches missing required keys and wrong types
    schema = {'type': 'object', 'properties': {'a': {'type': 'number'}},
              'required': ['a'], 'additionalProperties': False}
    assert list(_schema_errors({'a': 1.0}, schema)) == []
    assert list(_schema_errors({}, schema))  # missing required
    assert list(_schema_errors({'a': 'nope'}, schema))  # wrong type


# ---------------------------------------------------------------------------
# scoring-field projection
# ---------------------------------------------------------------------------

def test_project_for_scoring_drops_non_whitelisted():
    candidate = {
        'id': 1, 'skills': ['python'], 'experience': 4,
        'summary': 'backend dev',
        'name': 'Jane Doe', 'email': 'jane@x.com', 'university': 'MIT',
        'graduation_year': 1990, 'gender': 'F', 'ssn': '123',
        'internal_notes': 'do not score on this',
    }
    projected = project_for_scoring(candidate)
    assert set(projected) == {'id', 'skills', 'experience', 'summary'}
    assert 'university' not in projected
    assert set(projected) <= CANDIDATE_SCORING_FIELDS
    # vacancy whitelist mirrors the documented field set
    assert 'skills_required' in VACANCY_SCORING_FIELDS
    assert 'salary_range' in VACANCY_SCORING_FIELDS


# ---------------------------------------------------------------------------
# rank visibility: not_evaluated / counts / degradations
# ---------------------------------------------------------------------------

def _vacancy():
    return {'id': 1, 'title': 'Backend Engineer',
            'skills_required': ['python'], 'experience_level': 'Mid Level',
            'description': 'python backend developer'}


async def test_not_evaluated_below_top_k(env_patch):
    settings = env_patch(LLM_PROVIDER='mock')
    candidates = [{'id': i, 'skills': ['python'], 'experience': 4,
                   'summary': f'python developer {i}'} for i in range(6)]
    result = await rank_candidates(
        _vacancy(), candidates, SkillsTaxonomy.from_seed(),
        MockProvider(), settings, top_k=2)
    assert len(result['results']) == 2
    assert len(result['not_evaluated']) == 4
    assert all(n['reason'] == 'below_top_k' for n in result['not_evaluated'])
    cut = {n['candidate_id'] for n in result['not_evaluated']}
    kept = {r['candidate_id'] for r in result['results']}
    assert not (cut & kept)
    assert result['evaluated'] == len(result['results'])
    assert result['counts'] == {
        'received': 6, 'hard_filtered': 0, 'scored': 2, 'not_evaluated': 4,
    }


async def test_scoring_error_isolated(env_patch, monkeypatch):
    settings = env_patch(LLM_PROVIDER='mock')
    from app.pipeline import scoring

    real_compute = scoring.compute_match

    def boom(candidate, vacancy, **kw):
        if candidate.get('id') == 13:
            raise ValueError('corrupt payload')
        return real_compute(candidate, vacancy, **kw)

    monkeypatch.setattr(scoring, 'compute_match', boom)
    candidates = [
        {'id': 13, 'skills': ['python'], 'summary': 'bad candidate'},
        {'id': 14, 'skills': ['python'], 'summary': 'good candidate'},
    ]
    result = await rank_candidates(
        _vacancy(), candidates, SkillsTaxonomy.from_seed(),
        MockProvider(), settings)
    assert [r['candidate_id'] for r in result['results']] == [14]
    assert result['not_evaluated'] == [
        {'candidate_id': 13, 'reason': 'scoring_error', 'detail': 'corrupt payload'}]
    assert result['counts']['not_evaluated'] == 1


async def test_rank_response_shape_defaults(env_patch):
    settings = env_patch(LLM_PROVIDER='mock')
    result = await rank_candidates(
        _vacancy(), [{'id': 1, 'skills': ['python'], 'summary': 'dev'}],
        SkillsTaxonomy.from_seed(), MockProvider(), settings)
    assert result['not_evaluated'] == []
    assert result['below_min_score'] == []
    assert result['degradations'] == []
    assert result['counts']['received'] == 1


async def test_vector_degradation_recorded(env_patch, monkeypatch):
    settings = env_patch(LLM_PROVIDER='mock')
    provider = MockProvider()

    async def dead_embed(texts, *, correlation_id=None):
        raise ProviderUnavailable('embed backend down')

    monkeypatch.setattr(provider, 'embed', dead_embed)
    result = await rank_candidates(
        _vacancy(), [{'id': 1, 'skills': ['python'], 'summary': 'dev'}],
        SkillsTaxonomy.from_seed(), provider, settings)
    features = {d['feature'] for d in result['degradations']}
    assert 'vector' in features


# ---------------------------------------------------------------------------
# API level — min_score post-filter visibility
# ---------------------------------------------------------------------------

@pytest.fixture(scope='module')
def client():
    from starlette.testclient import TestClient

    from app.main import app
    with TestClient(app) as c:
        yield c


def test_min_score_drops_are_reported(client, auth_headers):
    resp = client.post('/v1/vacancies/42/rank', headers=auth_headers, json={
        'vacancy': {'id': 42, 'title': 'Python Dev',
                    'skills_required': ['python'], 'description': 'python dev'},
        'candidates': [
            {'id': 300, 'skills': 'python', 'experience': 5, 'description': 'python dev'},
            {'id': 301, 'skills': 'cobol', 'experience': 0, 'description': 'mainframe'},
        ],
        'min_score': 0.99,
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    dropped = {d['candidate_id'] for d in body['below_min_score']}
    kept = {r['candidate_id'] for r in body['results']}
    assert dropped | kept == {300, 301}
    assert not (dropped & kept)
    assert body['evaluated'] == len(body['results'])
