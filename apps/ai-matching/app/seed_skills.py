"""Idempotent seeder: loads seeds/skills_seed.json into canonical_skills.

Run via `python -m app.seed_skills` (called from docker-entrypoint.sh).
"""
import json
import logging

import psycopg

from .config import get_settings
from .skills import SEED_PATH

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


def run() -> None:
    with open(SEED_PATH, encoding='utf-8') as fh:
        entries = json.load(fh)
    with psycopg.connect(get_settings().database_url) as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT count(*) FROM canonical_skills')
            (count,) = cur.fetchone()
            if count:
                logger.info('canonical_skills already seeded (%s rows) — skipping', count)
                return
            for e in entries:
                cur.execute(
                    'INSERT INTO canonical_skills (name, aliases, esco_uri, category) '
                    'VALUES (%s, %s, %s, %s) ON CONFLICT (name) DO NOTHING',
                    (e['name'], e.get('aliases') or [], e.get('esco_uri'), e.get('category', 'general')),
                )
        conn.commit()
    logger.info('seeded %s canonical skills', len(entries))


if __name__ == '__main__':
    run()
