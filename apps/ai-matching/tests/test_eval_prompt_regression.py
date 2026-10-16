"""Prompt-regression gate: record → pass → forced-fail paths."""
import json
from pathlib import Path

import pytest

from evaluation import dataset as D
from evaluation import prompt_regression as PR


@pytest.fixture()
def suite(tmp_path):
    ds = D.generate(seed=7, n_queries=3)
    return D.write_jsonl(ds, tmp_path / 'suite.jsonl')


async def test_compute_ndcg(suite):
    out = await PR.compute_ndcg(suite)
    assert out['metric'] == 'ndcg_at_5'
    assert out['n_queries'] == 3
    assert out['value'] is None or 0.0 <= out['value'] <= 1.0


def test_record_then_check_passes(suite, tmp_path):
    golden = tmp_path / 'golden.json'
    assert PR.main(['--suite', str(suite), '--golden', str(golden), '--record']) == 0
    assert golden.exists()
    assert PR.main(['--suite', str(suite), '--golden', str(golden)]) == 0


def test_missing_golden_errors(suite, tmp_path):
    assert PR.main(['--suite', str(suite), '--golden', str(tmp_path / 'nope.json')]) == 2


def test_regression_fails_on_drop(suite, tmp_path):
    golden = tmp_path / 'golden.json'
    PR.main(['--suite', str(suite), '--golden', str(golden), '--record'])
    # Inflate the golden beyond reach — deterministic failure path.
    data = json.loads(golden.read_text())
    data['value'] = 2.0
    golden.write_text(json.dumps(data))
    assert PR.main(['--suite', str(suite), '--golden', str(golden)]) == 1


def test_real_suite_exists():
    assert PR.SUITE_PATH.exists(), 'corpora/regression_pairs.jsonl must be committed'
    assert PR.GOLDEN_PATH.exists(), 'golden/ndcg_baseline.json must be committed'
    ds = D.load_jsonl(PR.SUITE_PATH)
    assert 25 <= len(ds['pairs']) <= 45  # ~30 curated pairs
    golden = json.loads(PR.GOLDEN_PATH.read_text())
    assert 0.0 < golden['value'] <= 1.0
