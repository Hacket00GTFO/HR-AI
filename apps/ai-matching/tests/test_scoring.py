"""Regression tests for every documented bug in the old JS matcher."""
import math

from app.pipeline import scoring
from app.skills import SkillsTaxonomy

TAXONOMY = SkillsTaxonomy.from_seed()
WEIGHTS = {'skills': 0.4, 'experience': 0.2, 'education': 0.15, 'text': 0.15, 'vector': 0.1}


def canon(raws):
    return {TAXONOMY.resolve(r) for r in raws if TAXONOMY.resolve(r)}


# -- skills -------------------------------------------------------------------

def test_skills_never_exceeds_one():
    # old bug: java,javascript,go vs java → 2.0
    score, matched, missing = scoring.skills_score(
        canon(['java', 'javascript', 'go']), canon(['java']))
    assert score <= 1.0
    assert matched == ['java']
    assert score == 1.0  # all required skills present


def test_skills_no_substring_match():
    score, matched, missing = scoring.skills_score(canon(['javascript']), canon(['java']))
    assert score == 0.0
    assert 'java' in missing


def test_skills_partial_and_empty_vacancy():
    score, matched, missing = scoring.skills_score(canon(['python', 'django']), canon(['python', 'go']))
    assert score == 0.5
    assert scoring.skills_score(canon(['python']), set())[0] == 0.0  # spec: missing vacancy skills → 0


# -- experience ---------------------------------------------------------------

def test_entry_level_is_zero_years_not_auto_pass():
    # old bug: 'Entry Level'→0 and x>=0 always true → everyone scored 1.0.
    # Now: entry-level requirement means 0y required — a 0y candidate meets it,
    # but a mid requirement does NOT give free 1.0 to juniors.
    assert scoring.required_years({'experience_level': 'Entry Level'}) == 0.0
    assert scoring.experience_score(0.0, 0.0) == 1.0
    assert scoring.experience_score(1.0, 3.0) < 1.0  # junior vs mid
    assert scoring.experience_score(1.0, 3.0) == max(0.0, 1 - 2 / 3)


def test_experience_never_nan():
    # old bug: parseInt('') → NaN propagated to DB.
    assert scoring.parse_years('') is None
    assert scoring.parse_years(None) is None
    assert scoring.parse_years('abc') is None
    score = scoring.experience_score(scoring.parse_years(''), scoring.required_years({'experience_level': 'Mid Level'}))
    assert score == 0.0  # missing candidate years → 0, not NaN
    assert math.isfinite(score)


def test_experience_gap_decay():
    assert scoring.experience_score(4.0, 5.0) == max(0.0, 1 - 1 / 3)
    assert scoring.experience_score(0.0, 10.0) == 0.0
    assert scoring.experience_score(8.0, 5.0) == 1.0


# -- education ------------------------------------------------------------------

def test_education_ordinal_diff_not_constant_half():
    # old bug: any non-match returned 0.5; PhD vs Bachelor should differ from
    # High School vs PhD.
    phd_vs_bach = scoring.education_score(4, 2)
    hs_vs_phd = scoring.education_score(1, 4)
    assert phd_vs_bach == 1.0          # overqualified → meets requirement
    assert hs_vs_phd < phd_vs_bach
    assert hs_vs_phd == 0.0            # 3+ levels below → 0
    assert scoring.education_score(2, 3) == max(0.0, 1 - 0.34)


def test_education_parses_levels():
    assert scoring.education_ordinal('PhD in Computer Science') == 4
    assert scoring.education_ordinal("Bachelor's degree") == 2
    assert scoring.education_ordinal('master') == 3
    assert scoring.education_ordinal('') is None
    # vacancy requirement read from requirements text
    assert scoring.vacancy_education_requirement({'requirements': 'Bachelor degree in CS required'}) == 2


# -- text ---------------------------------------------------------------------

def test_text_no_keyword_stuffing():
    # old bug: 'developer developer developer' vs 'developer' → 3.0
    s = scoring.bm25_lite('python developer', 'developer developer developer developer developer')
    assert s is not None and s <= 1.0
    # and a well-written profile still scores reasonably
    good = scoring.bm25_lite('python developer', 'senior python developer building apis')
    assert good > s


def test_text_length_not_penalized():
    # old bug: score = matches/|vacancy keywords| → a 200-term vacancy scored
    # a fully-relevant candidate at ~1%. sqrt normalization bounds dilution.
    short = scoring.bm25_lite('python sql', 'python and sql experience')
    long = scoring.bm25_lite('python sql ' + ' '.join(f'w{i}' for i in range(200)), 'python and sql experience')
    assert short > long > 0.03
    old_formula = 2 / 202  # matches / vacancy keyword count
    assert long > 5 * old_formula


def test_text_full_coverage_scores_high():
    # full coverage saturates: tf=1 per term gives 1/(1+k1)=0.45 each, so a
    # short query tops out ~0.64 while longer full-coverage queries hit 1.0
    assert scoring.bm25_lite('python sql', 'python sql') > 0.6
    long_q = ' '.join(f'k{i}' for i in range(50))
    long_d = ' '.join(f'k{i}' for i in range(50))
    assert scoring.bm25_lite(long_q, long_d) == 1.0


# -- combine --------------------------------------------------------------------

def test_combine_bounded_and_nan_free():
    score = scoring.combine(
        {'skills': 5.0, 'experience': float('nan'), 'education': None, 'text': 0.5, 'vector': None},
        WEIGHTS)
    assert math.isfinite(score) and 0.0 <= score <= 1.0
    assert scoring.combine({'skills': None}, WEIGHTS) == 0.0


def test_full_match_result_shape():
    m = scoring.compute_match(
        {'id': 1, 'skills': 'python, django', 'experience': 5, 'education': 'Bachelor'},
        {'id': 2, 'skills_required': ['python', 'django', 'postgresql'],
         'experience_level': 'Mid Level', 'requirements': 'Bachelor degree',
         'description': 'python developer role'},
        cand_skills=canon(['python', 'django']),
        vac_skills=canon(['python', 'django', 'postgresql']),
        weights=WEIGHTS)
    assert 0.0 <= m['score'] <= 1.0
    assert abs(m['subscores']['skills'] - 2 / 3) < 1e-3
    assert 'postgresql' in m['explanation']['missing_skills']
    assert m['red_flags'] and 'missing required skills' in m['red_flags'][0]
