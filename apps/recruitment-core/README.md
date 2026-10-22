# recruitment-core

Vacancies + candidates + applications extracted from the Express monolith
(`apps/api`) following the strangler pattern — see
`docs/extraction/recruitment-core.md` for the plan and
`packages/contracts/openapi/recruitment.yaml` for the target API contract.

- **Port:** 3009 · **Database:** `strafor_recruitment`
- **Stack:** TypeScript · Express 4 · pg · node-pg-migrate · Zod · Multer · RabbitMQ (amqplib)
- **Auth:** gateway-verified headers (`X-User-Id`/`X-User-Role`) + `X-Service-Token` for service callers. **HR-only** — `admin` does NOT get candidate/recruitment data (403).

## Surface (mounted under `/v1`, gateway rewrites `/api/v1/* → /v1/*`)

| Route                                                                            | Auth                                                                                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/vacancies`                                                              | anonymous (public careers listing)                                                                                   |
| `POST /v1/vacancies`, `GET/PUT/DELETE /v1/vacancies/:id`                         | HR / service token                                                                                                   |
| `GET /v1/vacancies/:id/candidates`, `/:id/applications`, `/:id/top-candidates`   | HR / service token                                                                                                   |
| `GET/POST /v1/candidates`, `POST /v1/candidates/upload`                          | HR / service token                                                                                                   |
| `PUT /v1/candidates/:id/status`, `PUT /v1/candidates/:id/feedback`               | HR / service token                                                                                                   |
| `GET /v1/candidates/:id/resume`, `GET /v1/candidates/:id/history`                | HR / service token                                                                                                   |
| `POST /v1/public/apply`                                                          | anonymous — rate-limited 20/hour/IP                                                                                  |
| `POST /v1/ai/process-feedback`                                                   | HR / service token                                                                                                   |
| `POST /v1/internal/users-projection`, `DELETE /v1/internal/users-projection/:id` | **service token only** — display-name projection maintenance (callers hit the service directly, not via the gateway) |
| `GET /health`, `GET /ready` (db + broker), `GET /metrics`                        | infra                                                                                                                |

Wire shapes are the monolith's legacy shapes on purpose (snake_case,
`applied_for` int/`{_id,title}` duality, `application_id` on apply). The
normalized shapes in `recruitment.yaml` are the post-soak target.

## Resumes

Uploads are received in memory, validated (extension + size + **magic
bytes**), forwarded to documents-resumes (`POST /v1/documents`), and the
returned document id is stored in `candidates.resume_document_id`. Downloads
resolve the id via `GET /v1/documents/:id/download` and 302 to the presigned
URL. `RESUMES_DIR` is a legacy fallback ONLY for migrated rows that still
carry the old `resume` filename. HR clients may also pass
`resume_document_id` directly on `POST /v1/candidates` (spec §8a).

## Events

Every mutating route writes BOTH event families into `outbox_events` inside
the business transaction, then `flushOutbox` publishes to the `domain.events`
topic exchange (a 15s sweeper retries stragglers):

- new: `strafor.recruitment.{vacancy_published,vacancy_updated,vacancy_closed,application_submitted,candidate_status_changed,hiring_decision_recorded}`
- legacy: `strafor.vacancy.{published,updated}`, `strafor.application.submitted`, `strafor.candidate.status_changed`, `strafor.candidate.hiring_decision_recorded`

The legacy payloads keep the keys `apps/notifications/src/consumer.ts` routes
on (`email`, `name`, `vacancyTitle`, `newStatus`, `idempotencyKey`).

## Operator checklist

1. **Provision the DB.** `infra/compose/initdb/01-create-service-dbs.sql`
   creates `strafor_recruitment` on a _fresh_ pgdata volume only. On existing
   volumes: `docker compose exec db psql -U $POSTGRES_USER -c 'CREATE DATABASE strafor_recruitment;'`
2. **Deploy** `recruitment-core` (migrations run at boot; service must be
   healthy with `RECRUITMENT_CORE_URL` still unset on the gateway — monolith
   keeps serving).
3. **Backfill.** Copy `vacancies`, `candidates`, `applications`,
   `application_status_history`, `skills`, `candidate_skills`,
   `vacancy_skills` from `innovation`; populate `users_projection` from
   `strafor_identity.users` (`id`, `first_name`, `last_name`, `email`).
   Preserve ids; then `setval` every `*_id_seq` to `max(id)` to avoid PK
   collisions. Verify row counts + `max(updated_at)`.
4. **Cutover.** Set `RECRUITMENT_CORE_URL=http://recruitment-core:3009` on the
   gateway. `/api/v1/{vacancies,candidates,applications,public,recruitment}`
   and `/api/v1/ai/process-feedback` now proxy to the service.
5. **Rollback (soak window).** Unset `RECRUITMENT_CORE_URL` — the gateway
   rewrites `/api/v1/x → /api/x` back onto the monolith. Replay
   `strafor.recruitment.*` events into `innovation` to close the writes gap
   (see plan §3).
6. **Contract (≥ 1 week soak).** Remove the monolith route mounts and drop
   migrated tables from `innovation` (final dump first).

## Development

```bash
pnpm install
cp .env.example .env   # fill DATABASE_URL, SERVICE_AUTH_TOKEN
pnpm migrate           # node-pg-migrate up against strafor_recruitment
pnpm dev               # tsc + node --watch
pnpm test              # vitest
pnpm typecheck         # tsc --noEmit
```
