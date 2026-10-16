"""Markdown report renderer — per-baseline metrics + deltas vs legacy.

Writes docs/eval/latest.md (via runner CLI or `python -m evaluation.report`).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .dataset import load_dataset

METRIC_COLS = ['ndcg_at_10', 'ndcg_at_5', 'precision_at_5', 'recall_at_5', 'mrr', 'auc']


def _fmt(v: float | None) -> str:
    return '—' if v is None else f'{v:.4f}'


def render_markdown(results: list[dict], dataset: dict | None = None,
                    persisted: list[bool] | None = None) -> str:
    """Comparison table; deltas are vs the legacy_heuristic row when present."""
    by_name = {r['scorer']: r for r in results}
    base = by_name.get('legacy_heuristic')
    ds = dataset or {}
    lines = [
        '# ai-matching evaluation report',
        '',
        f"- generated: {datetime.now(timezone.utc).isoformat(timespec='seconds')}",
        f"- dataset: `{ds.get('name', '?')}` version `{ds.get('version', '?')}`"
        f" (seed={ds.get('seed')}, {sum(r.get('n_pairs', 0) for r in results[:1]) or len(ds.get('pairs', []))} pairs,"
        f" {results[0].get('n_queries', '?') if results else '?'} queries)",
        '- provider: MockProvider (deterministic, offline) — LLM rerank is a no-op here;'
        ' rerun against a real provider for production numbers.',
        '',
        '| scorer | ' + ' | '.join(METRIC_COLS) + ' | Δ ndcg@10 | persisted |',
        '|' + '---|' * (len(METRIC_COLS) + 3),
    ]
    for i, r in enumerate(results):
        m = r['metrics']
        delta = '—'
        if base and r['scorer'] != 'legacy_heuristic':
            b, c = base['metrics'].get('ndcg_at_10'), m.get('ndcg_at_10')
            if b is not None and c is not None:
                delta = f'{c - b:+.4f}'
        per = '—' if persisted is None else ('yes' if persisted[i] else 'no')
        lines.append(
            f"| `{r['scorer']}` | " + ' | '.join(_fmt(m.get(c)) for c in METRIC_COLS)
            + f' | {delta} | {per} |'
        )

    lines += [
        '',
        '## Reading the table',
        '',
        '- `legacy_heuristic` is a bug-for-bug port of the old monolith',
        '  `CandidateMatcher.js` (substring skills, entry-level auto-pass,',
        '  constant-0.5 education, naive keyword overlap). It is the floor.',
        '- `bm25_filters` = hard filters + text retrieval only.',
        '- `hybrid_no_llm` = the corrected feature scorer on every pair.',
        '- `full_pipeline` = the production path (filters → retrieval → scoring',
        '  → rerank). Under MockProvider the rerank is a deterministic no-op, so',
        '  `full_pipeline ≈ hybrid_no_llm` modulo retrieval/hard-filter effects —',
        '  that equivalence is itself a useful sanity check.',
        '',
        'Synthetic labels are built from skill overlap + experience fit + location,',
        'which structurally favors lexical matchers; see docs/eval/README.md for',
        'caveats before quoting these numbers.',
        '',
        '## Per-query detail',
        '',
    ]
    for r in results:
        lines.append(f"### `{r['scorer']}`")
        lines.append('')
        lines.append('| query | family | n | labels (ranked) | ndcg@10 | mrr |')
        lines.append('|---|---|---|---|---|---|')
        for q in r['per_query']:
            labels = ','.join(str(x) for x in q['labels_ranked'])
            lines.append(f"| {q['query_id']} | {q['family']} | {q['n']} | {labels} "
                         f"| {_fmt(q.get('ndcg_at_10'))} | {_fmt(q.get('mrr'))} |")
        lines.append('')
    return '\n'.join(lines)


def main(argv: list[str] | None = None) -> int:
    """Re-render latest.md from a saved results JSON (or rerun fresh)."""
    ap = argparse.ArgumentParser(prog='evaluation.report')
    ap.add_argument('--results', help='JSON file with a list of run results; '
                                      'omit to rerun all scorers on the synthetic dataset')
    ap.add_argument('--dataset', default='synthetic')
    ap.add_argument('--seed', type=int, default=13)
    ap.add_argument('--out', default=None)
    args = ap.parse_args(argv)

    if args.results:
        results = json.loads(Path(args.results).read_text(encoding='utf-8'))
        dataset = load_dataset(args.dataset, seed=args.seed)
    else:
        import asyncio
        from .runner import run_all
        dataset = load_dataset(args.dataset, seed=args.seed)
        results = asyncio.run(run_all(dataset))

    md = render_markdown(results, dataset)
    print(md)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(md, encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
