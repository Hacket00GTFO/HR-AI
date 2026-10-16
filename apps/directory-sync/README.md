# @strafor/directory-sync

Worker (not a business service) that keeps cross-service projections populated.
Runs a sync loop every `SYNC_INTERVAL_MS` (default 60s).

## HTTP surface

`GET /health`, `GET /ready`, `GET /metrics` only — no business routes, no
published host port (internal-only in compose).

## Cycle

1. **Read identity users** — direct pg read of `strafor_identity.users`
   (`IDENTITY_DATABASE_URL`). Rows are split into live upserts and tombstones
   (`deleted_at IS NOT NULL`).
2. **Read hr-core employees** — `GET {HR_CORE_URL}/v1/employees` with
   `X-Service-Token` (service callers pass `serviceOrUserAuth`/`requireHR`).
   Rows without a linked `userId` are skipped (the target contract requires a
   positive `userId`).
3. **Push `users-projection`** to recruitment-core
   (`POST /v1/internal/users-projection`, `{users:[{id,firstName,lastName,email}]}`
   — email included, its schema allows it) and to hr-core
   (same path, `{users:[{id,firstName,lastName}]}` — **no email**, that schema
   is strict). Payloads are chunked at `SYNC_BATCH_SIZE` (max 500, the target
   schemas' hard limit).
4. **Push `employee-directory`** to hr-services
   (`POST /v1/internal/employee-directory`,
   `{employees:[{id,userId,firstName,lastName,department}]}`).

## Deletes / tombstones

Stateless by design: no local state table — each cycle pushes the full source
set as upserts. Hard deletes propagate **only when the source exposes
tombstones**:

- Identity users soft-delete via `deleted_at` → the worker issues
  `DELETE /v1/internal/users-projection/:id` to both projection targets
  (404 = already gone, tolerated).
- hr-core's `/v1/employees` returns only live rows, so employee removals do
  **not** propagate to `employee_directory` — stale rows must be cleaned by
  the owning service or a future tombstone source.

## Resilience

Each step is independent — a failing target never blocks the others (a failed
source read marks its dependent pushes `skipped`). Every step is retried with
exponential backoff (`SYNC_RETRY_BASE_MS * 2^attempt`, `SYNC_RETRY_MAX`
attempts; 4xx other than 429 are not retried). Prometheus counters:
`sync_runs_total{step,status}`, `sync_rows_total{step}`,
`sync_duration_seconds{step}`.

**PII:** only row counts are logged — never names or emails. Upstream
response bodies are never embedded in errors.

## Env

| Var                                     | Default                        | Notes                                       |
| --------------------------------------- | ------------------------------ | ------------------------------------------- |
| `PORT`                                  | `3016`                         | health/metrics listener                     |
| `IDENTITY_DATABASE_URL`                 | —                              | required; read access to `strafor_identity` |
| `SERVICE_AUTH_TOKEN`                    | —                              | required; sent as `X-Service-Token`         |
| `RECRUITMENT_CORE_URL`                  | `http://recruitment-core:3009` |                                             |
| `HR_CORE_URL`                           | `http://hr-core:3010`          |                                             |
| `HR_SERVICES_URL`                       | `http://hr-services:3014`      |                                             |
| `SYNC_INTERVAL_MS`                      | `60000`                        | delay between cycle end and next start      |
| `SYNC_BATCH_SIZE`                       | `500`                          | rows per bulk upsert (≤500)                 |
| `SYNC_HTTP_TIMEOUT_MS`                  | `10000`                        | per-request timeout                         |
| `SYNC_RETRY_MAX` / `SYNC_RETRY_BASE_MS` | `3` / `500`                    | backoff tuning                              |
