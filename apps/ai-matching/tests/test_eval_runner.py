"""Runner: all four scorers over a synthetic slice — metrics shape, sane
ordering, persistence tolerated offline, and the /v1/eval/run endpoint."""
import pytest
from starlette.testclient import TestClient

from app.main import app
from evaluation import dataset as D
from evaluation.baselines import SCORER_ORDER, get_scorer
from evaluation.runner import persist_result, run_all, run_dataset


@pytest.fixture(scope='module')
def ds():
    return D.generate(seed=13, n_queries=8)  # 56 pairs — fast under mock


async def test_all_scorers_produce_metrics(ds):
    results = await run_all(ds)
    assert [r['scorer'] for r in results] == SCORER_ORDER
    for r in results:
        assert r['n_queries'] == 8
        assert r['n_pairs'] == 56
        assert r['dataset_version'] == ds['version']
        for key, val in r['metrics'].items():
            assert val is None or 0.0 <= val <= 1.0, (r['scorer'], key, val)


async def test_pipeline_beats_legacy_on_slice(ds):
    """The corrected pipeline must not lose to the buggy heuristic on NDCG@10.
    (Full-dataset numbers live in docs/eval/latest.md.)"""
    results = await run_all(ds)
    by_name = {r['scorer']: r for r in results}
    legacy = by_name['legacy_heuristic']['metrics']['ndcg_at_10']
    full = by_name['full_pipeline']['metrics']['ndcg_at_10']
    assert legacy is not None and full is not None
    assert full >= legacy


async def test_scorer_unknown_name():
    with pytest.raises(KeyError):
        get_scorer('nope')


def test_persist_tolerates_missing_db(ds):
    # conftest points DATABASE_URL at localhost:1 → must not raise
    result = {'scorer': 'x', 'dataset': 'd', 'dataset_version': 'v', 'metrics': {}}
    assert persist_result(ds, result, db_url='postgresql://u:p@localhost:1/x') is False


def test_eval_run_endpoint(auth_headers):
    client = TestClient(app)
    resp = client.post('/v1/eval/run', headers=auth_headers,
                       json={'scorer': 'legacy_heuristic', 'n_vacancies': 2, 'persist': False})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body['scorer'] == 'legacy_heuristic'
    assert body['n_queries'] == 2 and body['n_pairs'] == 14
    assert 'ndcg_at_10' in body['metrics']


def test_eval_run_endpoint_bad_scorer(auth_headers):
    client = TestClient(app)
    resp = client.post('/v1/eval/run', headers=auth_headers, json={'scorer': 'bogus'})
    assert resp.status_code == 400


def test_eval_run_requires_auth():
    client = TestClient(app)
    assert client.post('/v1/eval/run', json={}).status_code == 401
