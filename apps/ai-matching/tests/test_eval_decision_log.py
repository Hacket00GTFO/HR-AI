"""decision_log export: JSONL/CSV writing, human-outcome join, graceful skip."""
import json

from evaluation import decision_log as DL


def _scores():
    return [
        {'candidate_id': 1, 'vacancy_id': 9, 'score': 0.83,
         'subscores': {'skills': 1.0}, 'explanation': {'match_level': 'Excellent Match'},
         'model_version': 'rules-1.0.0', 'prompt_version': 'cvparse-v1',
         'embedding_version': 'emb-v1', 'source': 'hybrid', 'created_at': None},
        {'candidate_id': 2, 'vacancy_id': 9, 'score': 0.31,
         'subscores': {'skills': 0.0}, 'explanation': {'match_level': 'Low Match'},
         'model_version': 'rules-1.0.0', 'prompt_version': 'cvparse-v1',
         'embedding_version': 'emb-v1', 'source': 'rule_based', 'created_at': None},
    ]


def _patch(monkeypatch):
    monkeypatch.setattr(DL, 'fetch_scores', lambda *a, **k: _scores())
    monkeypatch.setattr(DL, 'fetch_human_outcomes',
                        lambda url: {(1, 9): {'human_outcome': 'accepted',
                                              'hiring_feedback': 'great', 'outcome_at': 'x'}})


def test_export_jsonl(monkeypatch, tmp_path):
    _patch(monkeypatch)
    out = tmp_path / 'decisions.jsonl'
    summary = DL.export_decisions('postgresql://unused', out, source_url='postgresql://src')
    assert summary['rows'] == 2 and summary['with_outcome'] == 1
    rows = [json.loads(line) for line in out.read_text().splitlines()]
    assert rows[0]['human_outcome'] == 'accepted'
    assert rows[1]['human_outcome'] is None
    assert rows[0]['model_version'] == 'rules-1.0.0'
    assert rows[0]['source'] == 'hybrid'


def test_export_csv(monkeypatch, tmp_path):
    _patch(monkeypatch)
    out = tmp_path / 'decisions.csv'
    DL.export_decisions('postgresql://unused', out)
    text = out.read_text()
    assert 'candidate_id' in text and 'human_outcome' in text
    assert '0.83' in text


def test_export_empty_writes_header(monkeypatch, tmp_path):
    monkeypatch.setattr(DL, 'fetch_scores', lambda *a, **k: [])
    out = tmp_path / 'empty.csv'
    summary = DL.export_decisions('postgresql://unused', out)
    assert summary['rows'] == 0
    assert 'candidate_id' in out.read_text()


def test_import_ats_skips_without_env(monkeypatch, capsys):
    import os
    monkeypatch.delenv('SOURCE_DATABASE_URL', raising=False)
    from evaluation import import_ats
    assert import_ats.main(['--out', 'unused.jsonl']) == 0
    assert 'skipping' in capsys.readouterr().out
