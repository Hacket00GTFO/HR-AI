# Runbook: recruitment-core data backfill + traffic cutover

**Scope**: move `vacancies`, `candidates`, `applications`,
`application_status_history`, `skills`, `candidate_skills`, `vacancy_skills`
(+ `users_projection`) from the monolith DB `innovation` to the
recruitment-core DB `strafor_recruitment`, then flip gateway traffic via
`RECRUITMENT_CORE_URL`.

**Tooling**: `infra/scripts/backfill-recruitment/run.js` (plain `node`, `pg`
only). See its `README.md` for the full flag list.

**Rollback posture**: the monolith keeps its tables and routes. Until the
_contract_ step (separate, later change) nothing is deleted — rollback is an
env change on the gateway.

> Cutover itself is an **operator decision**. This runbook covers everything up
> to and including the traffic flip; execute it when the window is approved.

---

## 0. Preflight

1. **Target DB exists.** `strafor_recruitment` is created by
   `infra/compose/initdb/01-create-service-dbs.sql` on a _fresh_ pgdata volume
   only. On an existing volume:

    ```bash
    docker compose exec db psql -U "$POSTGRES_USER" -c 'CREATE DATABASE strafor_recruitment;'
    ```

2. **Target schema is migrated.** recruitment-core runs `node-pg-migrate` at
   boot (`apps/recruitment-core/migrations/0001_recruitment.js`). Bring the
   service up _before_ flipping traffic:

    ```bash
    docker compose up -d recruitment-core
    docker compose ps recruitment-core        # expect (healthy)
    docker compose logs recruitment-core | grep -i migrat
    ```

    Or migrate explicitly:
    `docker compose exec recruitment-core node scripts/migrate.js up`.

3. **Decide the write window.** The backfill is a point-in-time copy. Choose:

    - **Stop-the-world (simplest, safest):** put the monolith's recruitment
      writes on hold — scale `api` down, or announce a freeze on
      vacancy/candidate/application changes for the duration of steps 1–3.
    - **Dual-publish window:** keep the monolith serving. The copy tolerates
      concurrent writes (`ON CONFLICT … DO NOTHING` re-runs pick up stragglers),
      but you MUST re-run `--mode=copy` then `--mode=verify` immediately before
      the flip, and accept a small catch-up gap covered by replaying
      `strafor.recruitment.*` events post-cutover (see §6).

4. **Connectivity.** The script needs both DBs on one network namespace.
   Options:

    - _Inside the compose network_ (defaults work as-is):

        ```bash
        docker run --rm --network straforai_default \
            -v "$PWD/infra/scripts/backfill-recruitment:/work" -w /work \
            -e SOURCE_DATABASE_URL -e TARGET_DATABASE_URL \
            node:20-alpine sh -c 'npm i --no-save pg && node run.js --dry-run'
        ```

        (`SOURCE_DATABASE_URL`/`TARGET_DATABASE_URL` may be left unset —
        defaults are `postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/…`.)

    - _From the host_ (dev compose exposes `127.0.0.1:5433`):

        ```bash
        export SOURCE_DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:5433/innovation"
        export TARGET_DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:5433/strafor_recruitment"
        node infra/scripts/backfill-recruitment/run.js --dry-run
        ```

---

## 1. Backfill copy

```bash
node infra/scripts/backfill-recruitment/run.js --dry-run     # sanity: plan + counts
node infra/scripts/backfill-recruitment/run.js --mode=copy
```

- Copies in FK-safe order: `skills → vacancies → candidates →
candidate_skills → vacancy_skills → applications →
application_status_history → users_projection` (from monolith `users`).
- Batches of 1000 (`--batch=N`), keyset-paginated on the PK, each batch a
  single `INSERT … ON CONFLICT (<pk>) DO NOTHING` transaction →
  **idempotent + resumable**: re-running skips rows already copied.
- `--mode=copy --truncate` forces a fresh load (`TRUNCATE … RESTART IDENTITY
CASCADE` first).
- After the copy, every `*_id_seq` is `setval`'d to `max(id)` so post-cutover
  inserts don't collide with preserved primary keys.
- `outbox_events` is intentionally **not** copied — the transactional outbox
  starts empty on the new service.
- Timestamp columns are read as `::text` on the source so the `pg` driver's
  `Date` coercion cannot truncate microseconds.

If writes are still live, re-run `--mode=copy` right before the flip to pick
up rows inserted since the first pass (conflict-skips make this cheap).

## 2. Verify

```bash
node infra/scripts/backfill-recruitment/run.js --mode=verify   # exits 1 on mismatch
```

Per table: row count + order-independent `hashtextextended(row_to_json(…))`
checksum over the mapped columns. On mismatch it lists the divergent primary
keys (bounded by `--diff-limit=N`, default 50) and exits non-zero. Do not
proceed until every table reports `OK`.

## 3. `users_projection`

The script already populates `users_projection` from the monolith `users`
table (`id`, `first_name`, `last_name`, `email`; `updated_at` is
service-managed). It auto-skips with a warning if `innovation.users` is gone.

**Alternative / canonical path** (e.g. `users` already dropped, or you prefer
identity as the source of truth): read users from `strafor_identity` and push
them through the service-token-guarded internal API:

```sql
-- strafor_identity
SELECT id, first_name AS "firstName", last_name AS "lastName", email FROM users;
```

```bash
# batches of ≤500 users per call
curl -sS -X POST http://localhost:3009/v1/internal/users-projection \
    -H "X-Service-Token: $SERVICE_AUTH_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"users":[{"id":1,"firstName":"Ada","lastName":"Lovelace","email":"ada@x.com"}]}'
# → {"upserted":1}
```

> Ongoing sync after the one-shot backfill is owned by **directory-sync
> (DV16)** — it calls this same endpoint on user create/update. Do not build a
> second sync path.

## 4. Cutover (approved window only)

```bash
# .env
RECRUITMENT_CORE_URL=http://recruitment-core:3009

docker compose up -d gateway    # recreate so the env var lands
docker compose logs gateway | grep -i recruitment
```

The gateway now proxies `/api/v1/{vacancies,candidates,applications,public,
recruitment}` and `/api/v1/ai/process-feedback` to recruitment-core (rewriting
`/api/v1/x → /v1/x`). With the var empty it rewrites `/api/v1/x → /api/x` and
falls back to the monolith.

## 5. Smoke checks

```bash
GW=http://localhost:8081

# 1. public careers listing (unauthenticated)
curl -sS "$GW/api/v1/vacancies" | head -c 400

# 2. authenticated list
curl -sS "$GW/api/v1/vacancies" -H "Authorization: Bearer $TOKEN"

# 3. public apply flow (rate-limited; use a test vacancy/candidate payload)
curl -sS -X POST "$GW/api/v1/public/apply" -H 'Content-Type: application/json' \
    -d '{"vacancyId":<id>,"firstName":"Smoke","lastName":"Test","email":"smoke@test.dev", …}'

# 4. status change → domain event → notification:
#    PUT /api/v1/candidates/:id/status then check
docker compose logs notifications | grep -i candidate
#    and the outbox drains:
docker compose exec db psql -U "$POSTGRES_USER" -d strafor_recruitment \
    -c "SELECT count(*) FROM outbox_events WHERE published_at IS NULL;"

# 5. service health direct
curl -sS http://localhost:3009/health && curl -sS http://localhost:3009/ready
```

## 6. Soak

Keep the monolith code deployed for **≥ 1 week** (see
`docs/extraction/recruitment-core.md` §3). During soak:

- watch `recruitment-core` error rate/latency and the `outbox_events` backlog;
- re-run `--mode=verify` on a schedule — drift means a write is still landing
  on the monolith (find it before contracting);
- recruitment-core publishes `strafor.recruitment.*` events while the monolith
  published `strafor.{vacancy,candidate,application}.*` — consumers subscribe
  to both during the transition.

## 7. Rollback

**Before cutover:** nothing to roll back — the monolith is still serving.

**After cutover, within soak:**

```bash
# .env — unset or empty
RECRUITMENT_CORE_URL=
docker compose up -d gateway
```

Traffic returns to the monolith, whose tables were never touched. To close the
write gap from the cutover window, replay the `strafor.recruitment.*` events
into `innovation` (plan §3), or worst case accept the bounded gap / restore
from the pre-cutover dump. `strafor_recruitment` tables can be left in place —
they're inert until the next attempt (re-run with `--truncate`).

**After contract:** restore `innovation` tables from the final dump. This is
why contract waits for the soak.

## Appendix: column mapping

| Source (`innovation`) | Target (`strafor_recruitment`) | Notes                                                                                                            |
| --------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| all copied columns    | same names, 1:1                | verified against live schemas                                                                                    |
| `candidates.*`        | `candidates.*`                 | `resume_document_id` is target-only → left `NULL`; legacy `resume` filename **is** copied (RESUMES_DIR fallback) |
| `users`               | `users_projection`             | `id`, `first_name`, `last_name`, `email` only; `updated_at` = `now()`                                            |
| —                     | `outbox_events`                | not copied; new service writes own events                                                                        |
