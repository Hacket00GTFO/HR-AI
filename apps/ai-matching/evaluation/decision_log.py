"""Audit-ready decision log export.

`match_scores` already persists score + subscores + explanation + model /
prompt / embedding versions + source for every scored pair — that IS the
decision log. This module exports it as JSONL or CSV for a date range, and
joins the human outcome (latest application status / hiring_feedback) from
the monolith database when SOURCE_DATABASE_URL is reachable.

CLI:
    python -m evaluation.decision_log --since 2026-01-01 --out decisions.jsonl
    SOURCE_DATABASE_URL=postgres://... python -m evaluation.decision_log ...
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

_OUTCOME_SQL = """
SELECT DISTINCT ON (candidate_id, vacancy_id)
       candidate_id, vacancy_id, status, hiring_feedback, updated_at
FROM applications
WHERE deleted_at IS NULL
ORDER BY candidate_id, vacancy_id, updated_at DESC
"""

_SCORES_SQL = """
SELECT candidate_id, vacancy_id, score, subscores, explanation,
       model_version, prompt_version, embedding_version, source, created_at
FROM match_scores
WHERE (%s::timestamptz IS NULL OR created_at >= %s::timestamptz)
  AND (%s::timestamptz IS NULL OR created_at <  %s::timestamptz)
ORDER BY created_at
"""


def _connect(url: str):
    import psycopg
    return psycopg.connect(url, connect_timeout=5)


def fetch_scores(db_url: str, since: str | None = None, until: str | None = None) -> list[dict]:
    with _connect(db_url) as conn, conn.cursor() as cur:
        cur.execute(_SCORES_SQL, (since, since, until, until))
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def fetch_human_outcomes(source_url: str) -> dict[tuple[int, int], dict]:
    """(candidate_id, vacancy_id) → latest application status. Empty when the
    source DB is absent/unreachable."""
    try:
        with _connect(source_url) as conn, conn.cursor() as cur:
            cur.execute(_OUTCOME_SQL)
            return {
                (r[0], r[1]): {'human_outcome': r[2], 'hiring_feedback': r[3],
                               'outcome_at': r[4].isoformat() if r[4] else None}
                for r in cur.fetchall()
            }
    except Exception as exc:
        logger.warning('SOURCE_DATABASE_URL unreachable (%s) — exporting without human outcomes', exc)
        return {}


def export_decisions(db_url: str, out_path: str | Path,
                     since: str | None = None, until: str | None = None,
                     source_url: str | None = None) -> dict:
    """Write the log; returns a small summary dict."""
    scores = fetch_scores(db_url, since, until)
    outcomes = fetch_human_outcomes(source_url) if source_url else {}
    rows = []
    for s in scores:
        row = {
            'candidate_id': s['candidate_id'],
            'vacancy_id': s['vacancy_id'],
            'score': s['score'],
            'subscores': s['subscores'],
            'explanation': s['explanation'],
            'model_version': s['model_version'],
            'prompt_version': s['prompt_version'],
            'embedding_version': s['embedding_version'],
            'source': s['source'],
            'created_at': s['created_at'].isoformat() if s['created_at'] else None,
        }
        row.update(outcomes.get((s['candidate_id'], s['vacancy_id']), {
            'human_outcome': None, 'hiring_feedback': None, 'outcome_at': None}))
        rows.append(row)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.suffix == '.csv':
        flat = [{**r, 'subscores': json.dumps(r['subscores'], default=str),
                 'explanation': json.dumps(r['explanation'], default=str)} for r in rows]
        with open(out_path, 'w', newline='', encoding='utf-8') as fh:
            writer = csv.DictWriter(fh, fieldnames=list(flat[0]) if flat else
                                    ['candidate_id', 'vacancy_id', 'score', 'subscores',
                                     'explanation', 'model_version', 'prompt_version',
                                     'embedding_version', 'source', 'created_at',
                                     'human_outcome', 'hiring_feedback', 'outcome_at'])
            writer.writeheader()
            writer.writerows(flat)
    else:
        with open(out_path, 'w', encoding='utf-8') as fh:
            for r in rows:
                fh.write(json.dumps(r, default=str) + '\n')
    return {'rows': len(rows), 'with_outcome': sum(1 for r in rows if r['human_outcome']),
            'out': str(out_path)}


def main(argv: list[str] | None = None) -> int:
    import os
    from app.config import get_settings

    ap = argparse.ArgumentParser(prog='evaluation.decision_log')
    ap.add_argument('--since', default=None, help='ISO date/datetime, inclusive')
    ap.add_argument('--until', default=None, help='ISO date/datetime, exclusive')
    ap.add_argument('--out', required=True, help='.jsonl or .csv output path')
    ap.add_argument('--db', default=None, help='override DATABASE_URL')
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format='%(message)s')

    summary = export_decisions(
        args.db or get_settings().database_url, args.out,
        since=args.since, until=args.until,
        source_url=os.environ.get('SOURCE_DATABASE_URL'),
    )
    print(json.dumps(summary))
    return 0


if __name__ == '__main__':
    sys.exit(main())
