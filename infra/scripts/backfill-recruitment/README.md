# backfill-recruitment

One-shot data backfill for the recruitment-core extraction: copies
`skills → vacancies → candidates → candidate_skills → vacancy_skills →
applications → application_status_history → users_projection` from the monolith
DB (`innovation`) to the service DB (`strafor_recruitment`), preserving source
primary keys.

Operator procedure: **`docs/runbooks/recruitment-cutover.md`**.

## Requirements

- Node ≥ 20 and the `pg` driver (resolved from the repo root `node_modules`;
  run `npm install` in this directory if missing).
- Network access to both Postgres databases. Inside the compose network both
  live on the `db` host; from the host machine expose port `127.0.0.1:5433`.

## Usage

```bash
# Print the plan (with live source row counts when reachable)
node run.js --dry-run

# Idempotent batched copy (1000 rows/batch, ON CONFLICT (pk) DO NOTHING)
node run.js --mode=copy

# Fresh load: wipe target tables first
node run.js --mode=copy --truncate

# Copy a subset
node run.js --mode=copy --tables=skills,vacancies

# Verify: per-table row count + order-independent row-hash checksum.
# Exits 1 on mismatch and lists divergent primary keys.
node run.js --mode=verify
```

## Connection strings

| Flag       | Env                   | Default                                                                    |
| ---------- | --------------------- | -------------------------------------------------------------------------- |
| `--source` | `SOURCE_DATABASE_URL` | `postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/innovation`          |
| `--target` | `TARGET_DATABASE_URL` | `postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/strafor_recruitment` |

(`POSTGRES_USER`/`POSTGRES_PASSWORD` default to `strafor`/`strafor`.)

From the host machine against the dev compose stack:

```bash
SOURCE_DATABASE_URL='postgres://strafor:<pw>@127.0.0.1:5433/innovation' \
TARGET_DATABASE_URL='postgres://strafor:<pw>@127.0.0.1:5433/strafor_recruitment' \
node run.js --mode=copy
```

Or inside the network: `docker compose exec api node /app/../infra/...` — see the
runbook for the exact invocation.

## Idempotency & resumability

- Every batch is `INSERT … ON CONFLICT (<pk>) DO NOTHING` in its own
  transaction. Re-running `--mode=copy` re-reads the source but skips rows
  already on the target — safe after an interruption, safe to repeat.
- `--truncate` gives a deterministic fresh load instead.
- Sequences (`*_id_seq`) are `setval(max(id))`'d after the copy so post-cutover
  inserts don't collide with preserved primary keys.
- `users_projection` is copied from the monolith `users` table and auto-skips
  (with a warning) if that table is absent; the runbook documents the
  alternative `POST /v1/internal/users-projection` API path.
- `outbox_events` is never copied — the transactional outbox starts empty.

## Tests

```bash
node_modules/.bin/vitest run infra/scripts/backfill-recruitment/tests
```

The suites stub the pg client — no database needed.
