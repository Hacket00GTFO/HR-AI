"""Fairness & proxy-discrimination checks.

- impact_ratio / four_fifths_report: selection-rate parity per protected
  group with the EEOC four-fifths (0.8) alert threshold.
- accessed_candidate_fields(): static inspection of the scoring code —
  which candidate keys the pipeline actually reads.
- perturbation_check(): empirical — same qualifications, different
  name/gender/dob/photo/university/gap → scores must be identical under
  MockProvider (under a real provider this becomes a monitored metric).
- embedding_payload_audit(): reports which non-scoring fields *would* leak
  into the embedded text if rank's fallback serialized the raw dict —
  the pipeline projects whitelisted keys first (app.scoring_fields), so
  leak_fields is the residual exposure surface under a regression.

CLI: python -m evaluation.fairness [--out docs/eval/fairness.md]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from app.pii import PII_KEYS, strip_pii
from app.pipeline import scoring
from app.scoring_fields import CANDIDATE_SCORING_FIELDS, VACANCY_SCORING_FIELDS

logger = logging.getLogger(__name__)

FOUR_FIFTHS = 0.8

# Direct identifiers + protected attributes — must never reach the score.
PROTECTED_FIELDS = {
    'name', 'first_name', 'last_name', 'full_name', 'gender', 'pronouns',
    'dob', 'date_of_birth', 'birthdate', 'age', 'photo', 'avatar', 'picture',
    'nationality', 'ethnicity', 'race', 'religion', 'marital_status',
}
# Not protected per se, but known correlated proxies worth auditing.
PROXY_FIELDS = {
    'university', 'college', 'school', 'graduation_year',
    'employment_gap_months', 'zip', 'postal_code', 'address',
}

# The documented whitelist of candidate fields the scorer is allowed to use.
# app/scoring_fields.py is the runtime source of truth; this alias keeps the
# report wording stable.
SCORING_WHITELIST = CANDIDATE_SCORING_FIELDS

# Fields the static scan legitimately sees outside the candidate whitelist:
# the accessor regexes cannot attribute dict types, so vacancy-side reads
# (skills_required, min_experience_years, …) show up, and the CV parser reads
# its own output fields during coercion. None of these are scored on.
NON_CANDIDATE_FIELDS = VACANCY_SCORING_FIELDS | {'languages', 'certifications'}


# ---------------------------------------------------------------------------
# four-fifths / impact ratio
# ---------------------------------------------------------------------------

def impact_ratio(group_rate: float, ref_rate: float) -> float | None:
    """selected_rate_group / selected_rate_ref. None when ref selects nobody
    (ratio undefined — reported, not silently zeroed)."""
    if ref_rate == 0:
        return None
    return group_rate / ref_rate


def four_fifths_report(rows: list[dict], attribute: str = 'group',
                       selected_key: str = 'selected',
                       reference: str | None = None) -> dict:
    """rows: [{'<attribute>': group, '<selected_key>': bool}].
    Returns per-group rates + impact ratios vs the reference group
    (defaults to the largest group)."""
    groups: dict[str, list[bool]] = {}
    for r in rows:
        g = str(r.get(attribute, 'unknown'))
        groups.setdefault(g, []).append(bool(r.get(selected_key)))
    if not groups:
        return {'attribute': attribute, 'reference': None, 'groups': {}, 'pass': True}
    ref = reference or max(groups, key=lambda g: len(groups[g]))
    ref_sel = groups.get(ref, [])
    ref_rate = sum(ref_sel) / len(ref_sel) if ref_sel else 0.0
    out = {}
    for g, sel in sorted(groups.items()):
        rate = sum(sel) / len(sel) if sel else 0.0
        ir = impact_ratio(rate, ref_rate)
        out[g] = {
            'n': len(sel), 'selected': sum(sel), 'rate': round(rate, 4),
            'impact_ratio': round(ir, 4) if ir is not None else None,
            'alert': ir is not None and ir < FOUR_FIFTHS,
        }
    return {
        'attribute': attribute,
        'reference': ref,
        'threshold': FOUR_FIFTHS,
        'groups': out,
        'pass': all(not v['alert'] for v in out.values()),
    }


# ---------------------------------------------------------------------------
# static inspection — what fields does the scorer read?
# ---------------------------------------------------------------------------

_PIPELINE_DIR = Path(__file__).resolve().parents[1] / 'app' / 'pipeline'
_ACCESSOR_RE = re.compile(r"(?:candidate|c|item)\.get\(\s*['\"]([\w-]+)['\"]")
_INDEX_RE = re.compile(r"(?:candidate|c|item)\[\s*['\"]([\w-]+)['\"]\s*\]")
_KEY_TUPLE_RE = re.compile(r"for key in \(([^)]*)\)", re.DOTALL)
# `keys = ('a', 'b', ...)` tuple fields — e.g. rank._compact_profile.
_KEYS_ASSIGN_RE = re.compile(r"\bkeys\s*=\s*\(([^)]*)\)", re.DOTALL)
_STR_LIT_RE = re.compile(r"['\"]([\w-]+)['\"]")


def accessed_candidate_fields() -> dict:
    """Scan app/pipeline sources for candidate-field accessors.
    Returns the accessed set, its intersection with protected/proxy fields,
    and whether everything accessed is inside SCORING_WHITELIST."""
    accessed: set[str] = set()
    for path in sorted(_PIPELINE_DIR.glob('*.py')):
        text = path.read_text(encoding='utf-8')
        accessed |= set(_ACCESSOR_RE.findall(text))
        accessed |= set(_INDEX_RE.findall(text))
        for tup in _KEY_TUPLE_RE.findall(text):
            accessed |= set(_STR_LIT_RE.findall(tup))
        for tup in _KEYS_ASSIGN_RE.findall(text):
            accessed |= set(_STR_LIT_RE.findall(tup))
    # rank.py's embedding fallback + rerank profile serialize
    # project_for_scoring(candidate) — every whitelisted key is then a field
    # the pipeline may read.
    rank_src = (_PIPELINE_DIR / 'rank.py').read_text(encoding='utf-8')
    if 'project_for_scoring' in rank_src:
        accessed |= CANDIDATE_SCORING_FIELDS
    return {
        'fields': sorted(accessed),
        'protected_hits': sorted(accessed & PROTECTED_FIELDS),
        'proxy_hits': sorted(accessed & PROXY_FIELDS),
        'outside_whitelist': sorted(accessed - SCORING_WHITELIST - NON_CANDIDATE_FIELDS),
        'clean': not (accessed & (PROTECTED_FIELDS | PROXY_FIELDS))
        and accessed <= (SCORING_WHITELIST | NON_CANDIDATE_FIELDS),
    }


def embedding_payload_audit(candidate: dict) -> dict:
    """What the embedding stage would embed for this candidate. When the
    profile-text fields are absent the pipeline serializes a whitelisted
    projection (app.scoring_fields.project_for_scoring); `leak_fields` lists
    the non-scoring keys that would leak only if that projection regressed
    to embedding the whole PII-stripped dict."""
    profile_text = scoring.candidate_text(candidate)
    if profile_text.strip():
        return {
            'mode': 'profile_text',
            'leak_fields': [],
            'note': 'only summary/description/current_position/headline/profile are embedded',
        }
    stripped = strip_pii(candidate)
    leaks = sorted(k for k in stripped if k not in SCORING_WHITELIST)
    return {
        'mode': 'full_dict_fallback',
        'leak_fields': leaks,
        'note': 'fallback path embeds a whitelisted projection — these non-scoring keys '
                '(e.g. university, graduation_year) are dropped and cannot influence the '
                'vector score unless the projection regresses',
    }


# ---------------------------------------------------------------------------
# empirical perturbation check
# ---------------------------------------------------------------------------

DEFAULT_PERTURBATIONS: list[tuple[str, dict]] = [
    ('name swap', {'name': 'Alexandra Doe'}),
    ('name swap 2', {'name': 'Mohammed Al-Farsi'}),
    ('gender', {'gender': 'F'}),
    ('gender 2', {'gender': 'M', 'pronouns': 'he/him'}),
    ('date of birth', {'dob': '1978-03-14'}),
    ('photo', {'photo': 'https://example.com/photos/x.jpg'}),
    ('university prestige', {'university': 'MIT'}),
    ('university prestige 2', {'university': 'Unknown Community College'}),
    ('graduation year (age proxy)', {'graduation_year': 1989}),
    ('employment gap', {'employment_gap_months': 42}),
]


async def perturbation_check(score_fn, candidate: dict, vacancy: dict,
                             perturbations: list[tuple[str, dict]] | None = None) -> dict:
    """score_fn: async (candidate, vacancy) -> float. Every perturbation must
    yield an identical score."""
    base = await score_fn(candidate, vacancy)
    cases = []
    for label, pert in (perturbations or DEFAULT_PERTURBATIONS):
        mutated = {**candidate, **pert}
        val = await score_fn(mutated, vacancy)
        cases.append({
            'perturbation': label, 'fields': sorted(pert),
            'base': base, 'perturbed': val, 'identical': val == base,
        })
    return {
        'passed': all(c['identical'] for c in cases),
        'base_score': base,
        'cases': cases,
    }


# ---------------------------------------------------------------------------
# full report
# ---------------------------------------------------------------------------

async def build_report() -> dict:
    """Run all checks over a small synthetic dataset under MockProvider."""
    from .baselines import FullPipelineScorer
    from .dataset import generate, queries

    ds = generate(seed=13, n_queries=12)
    scorer = FullPipelineScorer()

    # selection = top-1 per query → four-fifths over the synthetic 'group' attr
    rows: list[dict] = []
    for vacancy, items in queries(ds):
        scores = await scorer.score_query(vacancy, items)
        best = max(items, key=lambda p: scores.get(p['id'], 0.0))
        for p in items:
            rows.append({'group': p['candidate'].get('group', 'unknown'),
                         'selected': p is best})
    parity = four_fifths_report(rows)

    # perturbation on a representative strong pair
    rep = next(p for p in ds['pairs'] if p['relevance'] == 3)

    async def score_fn(cand, vac):
        from app.pipeline.rank import score_pair
        from app.config import get_settings
        r = await score_pair(cand, vac, scorer.taxonomy(), scorer.llm(), get_settings())
        return r['score']

    pert = await perturbation_check(score_fn, rep['candidate'], rep['vacancy'])
    static = accessed_candidate_fields()
    audits = {
        'with_profile_text': embedding_payload_audit(rep['candidate']),
        'without_profile_text': embedding_payload_audit(
            {k: v for k, v in rep['candidate'].items()
             if k not in ('summary', 'description', 'current_position', 'headline', 'profile')}),
    }
    return {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'provider': 'mock',
        'four_fifths': parity,
        'perturbation': pert,
        'static_inspection': static,
        'embedding_payload_audit': audits,
    }


def render_markdown(report: dict) -> str:
    ff = report['four_fifths']
    lines = [
        '# ai-matching fairness report', '',
        f"- generated: {report['generated_at']}",
        f"- provider: {report['provider']} (deterministic — perturbation deltas are exact)", '',
        '## Four-fifths rule (selection parity)', '',
        f"attribute: `{ff['attribute']}` — reference group: `{ff['reference']}` — threshold: {ff['threshold']}",
        '', '| group | n | selected | rate | impact ratio | alert |', '|---|---|---|---|---|---|',
    ]
    for g, v in ff['groups'].items():
        ir = 'n/a' if v['impact_ratio'] is None else f"{v['impact_ratio']:.4f}"
        lines.append(f"| {g} | {v['n']} | {v['selected']} | {v['rate']:.4f} "
                     f"| {ir} | {'ALERT' if v['alert'] else 'ok'} |")
    lines += ['', f"**{'PASS' if ff['pass'] else 'FAIL'}** — groups are synthetic cohorts "
              'assigned at random, so parity here is a smoke test; run over real '
              'cohorts when protected attributes are lawfully available.', '',
              '## Perturbation check (score invariance)', '',
              f"base score: `{report['perturbation']['base_score']:.4f}` — "
              f"**{'PASS' if report['perturbation']['passed'] else 'FAIL'}**", '',
              '| perturbation | perturbed score | identical |', '|---|---|---|']
    for c in report['perturbation']['cases']:
        lines.append(f"| {c['perturbation']} ({', '.join(c['fields'])}) "
                     f"| {c['perturbed']:.4f} | {'yes' if c['identical'] else 'NO'} |")
    si = report['static_inspection']
    lines += ['', '## Static inspection of scoring inputs', '',
              f"fields read by the pipeline: `{', '.join(si['fields'])}`", '',
              f"- protected-field hits: {si['protected_hits'] or 'none'}",
              f"- proxy-field hits: {si['proxy_hits'] or 'none'}",
              f"- fields outside the scoring whitelist: {si['outside_whitelist'] or 'none'}",
              f"- **{'CLEAN' if si['clean'] else 'REVIEW NEEDED'}**", '',
              '## Embedding payload audit', '']
    for mode, a in report['embedding_payload_audit'].items():
        lines.append(f"- `{mode}` → mode={a['mode']}, leaks={a['leak_fields'] or 'none'}"
                     f" — {a['note']}")
    lines.append('')
    return '\n'.join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='evaluation.fairness')
    ap.add_argument('--out', default=None, help='markdown output path (stdout always prints)')
    ap.add_argument('--json', dest='json_out', default=None, help='raw JSON report path')
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.WARNING)
    report = asyncio.run(build_report())
    md = render_markdown(report)
    print(md)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(md, encoding='utf-8')
    if args.json_out:
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_out).write_text(json.dumps(report, indent=2, default=str), encoding='utf-8')
    ok = report['perturbation']['passed'] and report['static_inspection']['clean']
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
