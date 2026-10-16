"""Fairness: impact-ratio math, four-fifths alerts, static field inspection,
empirical perturbation invariance under MockProvider."""
from evaluation import dataset as D
from evaluation import fairness as F
from evaluation.baselines import HybridNoLlmScorer


# -- impact ratio / four-fifths ------------------------------------------------

def test_impact_ratio_math():
    assert F.impact_ratio(0.5, 0.5) == 1.0
    assert F.impact_ratio(0.4, 0.5) == 0.8
    assert F.impact_ratio(0.3, 0.5) == 0.6
    assert F.impact_ratio(0.5, 0.0) is None


def test_four_fifths_alert():
    rows = (
        [{'group': 'a', 'selected': True}] * 8 + [{'group': 'a', 'selected': False}] * 2
        + [{'group': 'b', 'selected': True}] * 3 + [{'group': 'b', 'selected': False}] * 7
    )
    rep = F.four_fifths_report(rows)
    assert rep['reference'] == 'a'  # tie-break: both n=10, sorted() picks 'a'
    assert rep['groups']['a']['rate'] == 0.8
    assert rep['groups']['b']['rate'] == 0.3
    assert rep['groups']['b']['impact_ratio'] == 0.375
    assert rep['groups']['b']['alert'] is True
    assert rep['pass'] is False


def test_four_fifths_pass_when_balanced():
    rows = [{'group': g, 'selected': i % 2 == 0} for g in ('a', 'b') for i in range(10)]
    rep = F.four_fifths_report(rows)
    assert rep['pass'] is True
    assert rep['groups']['b']['impact_ratio'] == 1.0


# -- static inspection -----------------------------------------------------------

def test_scorer_reads_no_protected_fields():
    rep = F.accessed_candidate_fields()
    assert rep['protected_hits'] == []
    assert rep['proxy_hits'] == []
    assert rep['clean'] is True
    # sanity: the scan actually finds the real fields
    assert 'skills' in rep['fields']
    assert 'experience' in rep['fields'] or 'experience_years' in rep['fields']


# -- perturbation -----------------------------------------------------------------

async def test_perturbation_identical_scores():
    ds = D.generate(seed=13, n_queries=6)
    rep = next(p for p in ds['pairs'] if p['relevance'] == 3)
    scorer = HybridNoLlmScorer()

    from app.config import get_settings
    from app.pipeline.rank import score_pair

    async def score_fn(cand, vac):
        r = await score_pair(cand, vac, scorer.taxonomy(), scorer.llm(), get_settings())
        return r['score']

    out = await F.perturbation_check(score_fn, rep['candidate'], rep['vacancy'])
    assert out['passed'] is True
    assert all(c['identical'] for c in out['cases'])


# -- embedding payload audit -------------------------------------------------------

def test_embedding_payload_audit_modes():
    with_text = {'summary': 'python dev', 'university': 'MIT'}
    a = F.embedding_payload_audit(with_text)
    assert a['mode'] == 'profile_text' and a['leak_fields'] == []

    no_text = {'skills': ['python'], 'university': 'MIT', 'graduation_year': 1990}
    b = F.embedding_payload_audit(no_text)
    assert b['mode'] == 'full_dict_fallback'
    assert 'university' in b['leak_fields'] and 'graduation_year' in b['leak_fields']


async def test_build_report_passes():
    rep = await F.build_report()
    assert rep['perturbation']['passed'] is True
    assert rep['static_inspection']['clean'] is True
    assert 'four_fifths' in rep and 'groups' in rep['four_fifths']
