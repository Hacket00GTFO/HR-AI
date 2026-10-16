"""Synthetic dataset: determinism, shape, label sanity, hard negatives, noise."""
import json

from evaluation import dataset as D


def test_deterministic_same_seed():
    a, b = D.generate(seed=13), D.generate(seed=13)
    assert a['version'] == b['version']
    assert json.dumps(a['pairs'], sort_keys=True) == json.dumps(b['pairs'], sort_keys=True)


def test_different_seed_differs():
    assert D.generate(seed=13)['version'] != D.generate(seed=99)['version']


def test_shape_and_labels():
    ds = D.generate(seed=13, n_queries=26)
    pairs = ds['pairs']
    assert 150 <= len(pairs) <= 200
    assert len(D.queries(ds)) == 26
    assert all(0 <= p['relevance'] <= 3 for p in pairs)
    assert all(len(v[1]) == 7 for v in D.queries(ds))  # one per archetype
    families = {p['family'] for p in pairs}
    assert families == set(D.FAMILIES)


def test_label_distribution_covers_all_grades():
    ds = D.generate(seed=13)
    labels = {p['relevance'] for p in ds['pairs']}
    assert labels == {0, 1, 2, 3}


def test_archetype_labels():
    ds = D.generate(seed=13)
    for p in ds['pairs']:
        tags = set(p['tags'])
        if 'strong' in tags:
            assert p['relevance'] == 3, p
        if 'irrelevant' in tags:
            assert p['relevance'] == 0, p
        if 'hard_neg_seniority' in tags:
            # right skills, experience far below → weak, not strong
            assert p['relevance'] == 1, p
        if 'hard_neg_stack' in tags:
            assert p['relevance'] in (0, 1), p


def test_noisy_pairs_count_and_misspellings():
    ds = D.generate(seed=13)
    noisy = [p for p in ds['pairs'] if 'noisy' in p['tags']]
    assert len(noisy) >= 20
    misspelled = [p for p in noisy if 'misspelled' in p['tags']]
    assert len(misspelled) >= 20  # every noisy pair gets >=1 misspelling
    # noisy pairs still carry their intended relevance (intent-based labels)
    assert all(p['relevance'] >= 1 for p in noisy)


def test_jsonl_roundtrip(tmp_path):
    ds = D.generate(seed=13, n_queries=4)
    path = D.write_jsonl(ds, tmp_path / 'ds.jsonl')
    loaded = D.load_jsonl(path)
    assert loaded['version'] == ds['version']
    assert len(loaded['pairs']) == len(ds['pairs'])
    assert loaded['pairs'][0]['relevance'] == ds['pairs'][0]['relevance']
