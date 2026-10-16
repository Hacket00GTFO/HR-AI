"""Eval runner — evaluates a scoring callable over a labeled dataset.

    result = await run_dataset(dataset, scorer)   # scorer: see baselines.py
    python -m evaluation.runner [--dataset synthetic|path.jsonl]
        [--scorer legacy_heuristic|bm25_filters|hybrid_no_llm|full_pipeline|all]
        [--seed 13] [--persist] [--no-report] [--report PATH]

Metrics are macro-averaged per query; per-query breakdown is kept in the
result and persisted to `eval_results` when --persist and DATABASE_URL is
reachable (failures are tolerated — eval must never depend on infra).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

from app.config import get_settings

from . import metrics as M
from .baselines import SCORER_ORDER, get_scorer
from .dataset import dataset_version, load_dataset, queries

logger = logging.getLogger(__name__)

KS = (5, 10)
REPORT_PATH = Path(__file__).resolve().parents[1] / 'docs' / 'eval' / 'latest.md'


# ---------------------------------------------------------------------------
# core
# ---------------------------------------------------------------------------

async def run_dataset(dataset: dict, scorer) -> dict:
    """Score every pair, rank within each query, compute metrics."""
    per_query: list[dict] = []
    for vacancy, items in queries(dataset):
        scores = await scorer.score_query(vacancy, items)
        ranked = sorted(items, key=lambda p: (-scores.get(p['id'], 0.0), p['id']))
        labels = [p['relevance'] for p in ranked]
        scored = [(scores.get(p['id'], 0.0), p['relevance']) for p in items]
        qm = M.query_metrics(labels, scored, ks=KS)
        per_query.append({
            'query_id': vacancy.get('id'),
            'family': items[0].get('family'),
            'n': len(items),
            'labels_ranked': labels,
            'scores_ranked': [round(scores.get(p['id'], 0.0), 4) for p in ranked],
            **qm,
        })

    settings = get_settings()
    metric_keys = (
        'mrr', 'auc',
        *[f'{m}_at_{k}' for m in ('precision', 'recall', 'ndcg') for k in KS],
    )
    macro = {key: M.macro_average(q.get(key) for q in per_query) for key in metric_keys}

    return {
        'scorer': scorer.name,
        'dataset': dataset.get('name'),
        'dataset_version': dataset.get('version') or dataset_version(dataset),
        'model_version': settings.model_version,
        'prompt_version': settings.prompt_version,
        'embedding_version': settings.embedding_version,
        'ran_at': datetime.now(timezone.utc).isoformat(),
        'n_queries': len(per_query),
        'n_pairs': sum(q['n'] for q in per_query),
        'metrics': macro,
        'per_query': per_query,
    }


async def run_all(dataset: dict, scorer_names: list[str] | None = None) -> list[dict]:
    names = scorer_names or SCORER_ORDER
    results = []
    for name in names:
        scorer = get_scorer(name)
        results.append(await run_dataset(dataset, scorer))
        logger.info('%-18s ndcg@10=%s', name,
                    f"{results[-1]['metrics'].get('ndcg_at_10'):.4f}"
                    if results[-1]['metrics'].get('ndcg_at_10') is not None else 'n/a')
    return results


# ---------------------------------------------------------------------------
# persistence — eval_datasets / eval_results (tolerates missing DB)
# ---------------------------------------------------------------------------

def persist_result(dataset: dict, result: dict, db_url: str | None = None) -> bool:
    """Insert dataset spec + run metrics. Returns True on success."""
    url = db_url or get_settings().database_url
    try:
        import psycopg

        with psycopg.connect(url, connect_timeout=4) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'INSERT INTO eval_datasets (name, spec) VALUES (%s, %s)'
                    ' ON CONFLICT (name) DO UPDATE SET spec = EXCLUDED.spec',
                    (f"{dataset.get('name')}:{dataset.get('version')}",
                     json.dumps({'seed': dataset.get('seed'),
                                 'n_pairs': len(dataset.get('pairs', [])),
                                 'version': dataset.get('version')})),
                )
                cur.execute(
                    'INSERT INTO eval_results (name, metrics) VALUES (%s, %s)',
                    (f"{result['scorer']}@{result['dataset']}:{result['dataset_version']}",
                     json.dumps(result, default=str)),
                )
            conn.commit()
        return True
    except Exception as exc:
        logger.warning('eval_results persist skipped (%s)', exc)
        return False


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='evaluation.runner')
    ap.add_argument('--dataset', default='synthetic', help="'synthetic' or a JSONL path")
    ap.add_argument('--scorer', default='all', help='scorer name or "all"')
    ap.add_argument('--seed', type=int, default=13)
    ap.add_argument('--persist', action='store_true', help='write eval_results (needs DATABASE_URL)')
    ap.add_argument('--no-report', action='store_true', help='do not write docs/eval/latest.md')
    ap.add_argument('--report', default=str(REPORT_PATH), help='markdown report output path')
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format='%(message)s')
    dataset = load_dataset(args.dataset, seed=args.seed)
    names = SCORER_ORDER if args.scorer == 'all' else [args.scorer]
    results = asyncio.run(run_all(dataset, names))

    persisted = []
    for r in results:
        if args.persist:
            persisted.append(persist_result(dataset, r))
        else:
            persisted.append(False)

    from .report import render_markdown
    md = render_markdown(results, dataset, persisted=persisted)
    print()
    print(md)
    if not args.no_report:
        out = Path(args.report)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(md, encoding='utf-8')
        print(f'\nreport → {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
