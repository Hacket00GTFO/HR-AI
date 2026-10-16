"""Prompt/pipeline regression gate — CI-able.

Fixed suite of curated pairs (evaluation/corpora/regression_pairs.jsonl, in
the standard dataset JSONL shape) with expected *orderings* (graded relevance,
not exact scores — LLM outputs drift). Computes macro NDCG@5 with the full
pipeline under MockProvider and compares against the recorded golden run:

    exits 0  when ndcg >= golden * (1 - TOLERANCE)
    exits 1  when it dropped more than TOLERANCE (default 2%)
    exits 2  on usage errors / missing golden without --record

    python -m evaluation.prompt_regression            # check
    python -m evaluation.prompt_regression --record   # bless a new golden

Under MockProvider everything is deterministic, so the check is stable in CI;
with a real provider it becomes a drift monitor (widen tolerance as needed).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import metrics as M
from .baselines import FullPipelineScorer
from .dataset import dataset_version, load_jsonl, queries

SUITE_PATH = Path(__file__).resolve().parent / 'corpora' / 'regression_pairs.jsonl'
GOLDEN_PATH = Path(__file__).resolve().parent / 'golden' / 'ndcg_baseline.json'
TOLERANCE = 0.02  # max allowed relative NDCG drop
K = 5


async def compute_ndcg(suite_path: Path = SUITE_PATH) -> dict:
    ds = load_jsonl(suite_path)
    scorer = FullPipelineScorer()
    ndcgs = []
    for vacancy, items in queries(ds):
        scores = await scorer.score_query(vacancy, items)
        ranked = sorted(items, key=lambda p: (-scores.get(p['id'], 0.0), p['id']))
        v = M.ndcg_at_k([p['relevance'] for p in ranked], K)
        if v is not None:
            ndcgs.append(v)
    return {
        'metric': f'ndcg_at_{K}',
        'value': M.macro_average(ndcgs),
        'dataset_version': ds.get('version') or dataset_version(ds),
        'n_queries': len(ndcgs),
        'provider': 'mock',
        'recorded_at': datetime.now(timezone.utc).isoformat(),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='evaluation.prompt_regression')
    ap.add_argument('--record', action='store_true', help='write current NDCG as the golden baseline')
    ap.add_argument('--suite', default=str(SUITE_PATH))
    ap.add_argument('--golden', default=str(GOLDEN_PATH))
    ap.add_argument('--tolerance', type=float, default=TOLERANCE)
    args = ap.parse_args(argv)

    if not Path(args.suite).exists():
        print(f'suite not found: {args.suite}', file=sys.stderr)
        return 2

    current = asyncio.run(compute_ndcg(Path(args.suite)))
    if current['value'] is None:
        print('suite produced no defined NDCG values', file=sys.stderr)
        return 2

    if args.record:
        gp = Path(args.golden)
        gp.parent.mkdir(parents=True, exist_ok=True)
        gp.write_text(json.dumps(current, indent=2) + '\n', encoding='utf-8')
        print(f"golden recorded: {current['metric']}={current['value']:.4f} → {gp}")
        return 0

    gp = Path(args.golden)
    if not gp.exists():
        print(f'golden baseline missing: {gp} — run with --record first', file=sys.stderr)
        return 2
    golden = json.loads(gp.read_text(encoding='utf-8'))
    base, cur = golden['value'], current['value']
    floor = base * (1 - args.tolerance)
    ok = cur >= floor
    print(f"{current['metric']}: current={cur:.4f} golden={base:.4f} "
          f"floor={floor:.4f} (tol={args.tolerance:.0%}) → {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
