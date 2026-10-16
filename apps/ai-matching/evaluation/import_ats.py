"""Import labeled pairs from the monolith's real ATS data.

Reads SOURCE_DATABASE_URL (the apps/api Postgres): joins applications →
candidates → vacancies and derives ground-truth labels from human outcomes:

    accepted  → 3 (strong)     interview → 1 (weak)
    rejected  → 0 (irrelevant) pending   → skipped (no outcome yet)

Writes the same JSONL shape as dataset.write_jsonl so it feeds the same
runner. Tolerates absence: no SOURCE_DATABASE_URL or unreachable DB → skip
cleanly (exit 0, nothing written).

CLI: SOURCE_DATABASE_URL=postgres://... python -m evaluation.import_ats --out ats.jsonl
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

from .dataset import dataset_version, write_jsonl

logger = logging.getLogger(__name__)

STATUS_LABEL = {'accepted': 3, 'interview': 1, 'rejected': 0}

_SQL = """
SELECT a.id            AS application_id,
       a.status        AS status,
       c.id            AS candidate_id,
       c.skills        AS c_skills,
       c.experience    AS c_experience,
       c.education     AS c_education,
       c.location      AS c_location,
       c.current_position AS c_position,
       v.id            AS vacancy_id,
       v.title         AS v_title,
       v.description   AS v_description,
       v.requirements  AS v_requirements,
       v.skills_required AS v_skills,
       v.experience_level AS v_level,
       v.location      AS v_location,
       v.remote_option AS v_remote,
       v.salary_range  AS v_salary
FROM applications a
JOIN candidates c ON c.id = a.candidate_id
JOIN vacancies  v ON v.id = a.vacancy_id
WHERE a.deleted_at IS NULL
  AND c.deleted_at IS NULL
  AND a.status IN ('accepted', 'interview', 'rejected')
ORDER BY a.vacancy_id, a.id
LIMIT %s
"""


def fetch_pairs(source_url: str, limit: int = 5000) -> list[dict]:
    import psycopg

    with psycopg.connect(source_url, connect_timeout=5) as conn, conn.cursor() as cur:
        cur.execute(_SQL, (limit,))
        rows = cur.fetchall()
    pairs = []
    for r in rows:
        (app_id, status, cid, c_skills, c_exp, c_edu, c_loc, c_pos,
         vid, v_title, v_desc, v_reqs, v_skills, v_level, v_loc, v_remote, v_salary) = r
        pairs.append({
            'id': app_id,
            'query_id': vid,
            'family': None,
            'vacancy': {
                'id': vid, 'title': v_title, 'description': v_desc,
                'requirements': v_reqs, 'skills_required': list(v_skills or []),
                'experience_level': v_level, 'location': v_loc,
                'remote_option': bool(v_remote),
                'salary_max': (v_salary or {}).get('max') if isinstance(v_salary, dict) else None,
            },
            'candidate': {
                'id': cid, 'skills': c_skills, 'experience': c_exp,
                'education': c_edu, 'location': c_loc,
                'summary': ' '.join(x for x in (c_pos, c_skills) if x),
            },
            'relevance': STATUS_LABEL[status],
            'tags': ['ats', f'ats:{status}'],
            'intended_skills': [],
        })
    return pairs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='evaluation.import_ats')
    ap.add_argument('--out', required=True)
    ap.add_argument('--limit', type=int, default=5000)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format='%(message)s')

    url = os.environ.get('SOURCE_DATABASE_URL')
    if not url:
        print('SOURCE_DATABASE_URL not set — skipping ATS import (clean no-op)')
        return 0
    try:
        pairs = fetch_pairs(url, limit=args.limit)
    except Exception as exc:
        print(f'SOURCE_DATABASE_URL unreachable ({exc}) — skipping ATS import')
        return 0
    if not pairs:
        print('no decided applications found — nothing to export')
        return 0
    ds = {'name': 'ats-import', 'seed': None, 'pairs': pairs}
    ds['version'] = dataset_version(ds)
    write_jsonl(ds, args.out)
    print(f'wrote {len(pairs)} labeled pairs → {args.out}  version={ds["version"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
