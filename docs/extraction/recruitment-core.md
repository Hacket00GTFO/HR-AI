# Extraction plan: `recruitment-core` (vacancies + candidates + applications)

> Status: **plan only — no code in this phase.** Companion artifacts:
> `packages/contracts/openapi/recruitment.yaml` (API contract) and
> `packages/contracts/events/recruitment.js` (domain-event contracts).

This document describes how to pull the recruitment core out of `apps/api`
(the legacy monolith) into a new `apps/recruitment-core` service, following the
strangler pattern already used for `identity-auth`, `documents-resumes`,
`notifications` and `ai-matching`. The gateway keeps every public URL stable;
clients never see the move.

`recruitment-core` is deliberately the **intermediate** step of the final
split: vacancies and candidates stay in one service (and one database) because
they are coupled by `applications.vacancy_id → vacancies.id` and five read
paths that JOIN them (`routes/vacancies.js` candidate lists, top-candidates,
`models/Candidate.js` vacancy lookups). The later split into `vacancies` (port
3002) + `candidates-applications` (port 3003) with a
`candidate_vacancy_projection` read model is only attempted once the event
pipeline is proven loss-free.

---

## 1. Service boundary analysis

### 1.1 What moves to `apps/recruitment-core`

| Asset (monolith)                            | Endpoint surface                                        | Moves as                                   |
| ------------------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| `routes/vacancies.js`                       | `GET/POST /api/vacancies`, `GET/PUT/DELETE /:id`, `GET /:id/candidates`, `GET /:id/applications`, `GET /:id/top-candidates` | `routes/vacancies.js` under `/v1/vacancies` |
| `routes/candidates.js`                      | `GET/POST /api/candidates`, `PUT /:id/status`, `PUT /:id/feedback`, `GET /:id/resume`, `POST /upload` | `routes/candidates.js` under `/v1/candidates` |
| `routes/public.js` (`POST /apply` only)     | public application form target                          | `routes/public.js` under `/v1/public/apply` |
| `models/Vacancy.js`                         | —                                                       | `models/Vacancy.js`                        |
| `models/Candidate.js`                       | —                                                       | `models/Candidate.js`                      |
| `models/Application.js`                     | —                                                       | `models/Application.js`                    |
| `models/Skill.js`                           | —                                                       | `models/Skill.js`                          |
| `middleware/auth.js` (`isHR`)               | —                                                       | replaced by gateway header auth (`X-User-Id`/`X-User-Role`) + `@strafor/node-common` |
| resume upload (`uploadResume`, `RESUMES_DIR`) | `POST /api/candidates`, `POST /upload`, `GET /:id/resume` | **rewired to `documents-resumes`**: upload returns a `document_id`; download proxies a signed URL. Local disk storage is dropped |

### 1.2 What stays in the monolith (post-extraction shape)

After this extraction the monolith becomes a **dashboard + settings + admin**
shell only:

- `routes/dashboard.js` — until `analytics` read models replace it (see §6)
- `routes/settings.js`, `routes/user.js`, `routes/admin-accounts.js`,
  `routes/hr-accounts.js` — thin compatibility aliases that proxy to
  `identity-auth` (these already live in `identity-auth`; the monolith routes
  remain only until the web app stops calling legacy `/api/*` paths)
- `routes/countries.js` — reference data; candidate for a shared package or
  stays until the last consumer leaves
- `routes/ai.js` — already a proxy to `ai-matching`; retires with the monolith
- `public/` static frontend — retires with the Next.js `web` app

### 1.3 Explicit non-goals

- No split of `vacancies` and `candidates` into two services yet.
- No schema redesign beyond what migrations 0001–0010 already did
  (snake_case, `applications`, skills tables, FKs, audit).
- No change to the event types already published
  (`strafor.vacancy.*`, `strafor.candidate.*`, `strafor.application.*`).

---

## 2. Database ownership strategy

| Table                          | Today (DB `innovation`) | Target (DB `strafor_recruitment`) | Notes |
| ------------------------------ | ----------------------- | --------------------------------- | ----- |
| `vacancies`                    | owned by monolith       | owned by recruitment-core         | includes `departments`/`companies` columns normalized in migration 0006 |
| `candidates`                   | owned by monolith       | owned by recruitment-core         | `resume` filename column replaced by `resume_document_id` (UUID → documents-resumes) |
| `applications`                 | owned by monolith       | owned by recruitment-core         | the join table; keeps `vacancy_id`/`candidate_id` FKs **inside** the new DB |
| `application_status_history`   | owned by monolith       | owned by recruitment-core         | |
| `skills`, `candidate_skills`, `vacancy_skills` | owned by monolith | owned by recruitment-core | ESCO-aligned taxonomy; `ai-matching` reads taxonomy via API/events, not SQL |
| `candidate_embeddings`, `vacancy_embeddings` | owned by monolith | **stay behind** / move to `strafor_ai` | owned by `ai-matching`, not recruitment-core |
| `users`, `settings`, `audit_logs` | owned by monolith  | stay in `innovation` (users/settings already mirrored in `strafor_identity`) | |
| `countries`, `states`          | owned by monolith       | stay in `innovation`              | shared reference data; later move to a reference-data owner |

`strafor_recruitment` is created by `infra/compose/initdb/01-create-service-dbs.sql`
(one `CREATE DATABASE` line alongside the existing `strafor_*` DBs).

**Cross-database rules after the move:**

- `applications.vacancy_id → vacancies.id` and
  `applications.candidate_id → candidates.id` survive intact (same DB).
- `vacancies.created_by → users.id` is **dropped as a FK** (migration 0010
  already removed user FKs in preparation). The column keeps the user id from
  the JWT claim; a `users_projection` table fed by `strafor.identity.user_updated`
  provides display names without cross-DB reads.
- `candidates.resume_document_id` is an **unenforced reference** to
  documents-resumes; deletion propagates via `strafor.document.*` events.

---

## 3. Migration path (online, reversible)

Expand → migrate → contract, with the gateway as the traffic switch.

1. **Expand (deploy 1).** Provision `strafor_recruitment`. Stand up
   `apps/recruitment-core` with its own `node-pg-migrate` chain that replays
   the vacancy/candidate/application/skills DDL (a `recruitment_` namespaced
   baseline migration copied from monolith migrations 0001–0009, minus
   users/settings/audit tables it does not own). Service starts with
   `READ_FROM=shadow`: it serves traffic but the gateway still routes to the
   monolith.
2. **Backfill (online).** `pg_dump -t vacancies -t candidates -t applications
   -t application_status_history -t 'skills*' innovation | psql strafor_recruitment`
   for the initial copy, then a catch-up worker tails `audit_logs`
   (or logical replication / `pg_logical` slot `recruitment_core`) to stay
   within seconds of the monolith. Verify with row counts + checksums
   (`count(*)`, `max(updated_at)`, sampled row hashes) logged on a schedule.
3. **Cutover (deploy 2).** Set `RECRUITMENT_CORE_URL` on the gateway
   (see §5). New reads/writes go to recruitment-core; the monolith routes
   return `410 Gone` guarded by a feature flag
   (`RECRUITMENT_EXTRACTION=enabled`). Keep the monolith code deployed — it is
   the rollback target.
4. **Contract (deploy 3, after a soak period ≥ 1 week).** Drop the monolith's
   vacancies/candidates route mounts, delete the migrated tables from
   `innovation` (after a final dump), and remove the feature flag.

### Rollback

- **Before cutover:** nothing to roll back — the monolith is still serving.
- **After cutover, within soak:** unset `RECRUITMENT_CORE_URL` on the gateway
  (env change, no redeploy of the monolith). Writes made during the cutover
  window are replayed back via the `strafor.recruitment.*` events the new
  service published — a `replay-back` script consumes them and upserts into
  `innovation`. Worst case (events lost): restore `innovation` tables from the
  pre-cutover dump plus accept the bounded data gap — document the decision.
- **After contract:** full restore from the final dump; this is why contract
  waits for a soak period.

### Dual-write is intentionally avoided

The plan uses event replay for rollback instead of synchronous dual-write:
dual-write would couple monolith availability to the new service and re-create
the distributed-transaction problem the extraction is removing.

---

## 4. API contract

`packages/contracts/openapi/recruitment.yaml` is the contract the new service
implements. Surface summary:

- `GET/POST /v1/vacancies`, `GET/PUT/DELETE /v1/vacancies/{id}`
- `GET /v1/vacancies/{id}/candidates`, `GET /v1/vacancies/{id}/applications`,
  `GET /v1/vacancies/{id}/top-candidates` (reads precomputed `match_scores`
  served by ai-matching — the service calls `AI_SERVICE_URL`, never computes)
- `GET/POST /v1/candidates`, `PUT /v1/candidates/{id}/status`,
  `PUT /v1/candidates/{id}/feedback`, `GET /v1/candidates/{id}/resume`
  (302 → signed URL from documents-resumes)
- `POST /v1/public/apply` (unauthenticated, rate-limited at the gateway)
- `GET /health`, `GET /ready` (db + broker check)

Auth model: gateway-verified. The service trusts `X-User-Id` / `X-User-Role`
headers injected by the gateway after JWT validation (same convention as
notifications), plus `X-Service-Token` for service-to-service calls.
Errors use the shared envelope `{ "error": string, "details"?: any }`.

## 5. Event contracts

`packages/contracts/events/recruitment.js` (registered in `events/index.js`)
defines the events recruitment-core publishes on the `domain.events` topic
exchange (RabbitMQ, quorum queues):

| Type                                  | Emitted on                              | Key consumers |
| ------------------------------------- | --------------------------------------- | ------------- |
| `strafor.recruitment.vacancy_published` | vacancy created/published              | ai-matching (index), analytics |
| `strafor.recruitment.vacancy_updated`   | vacancy updated                        | ai-matching, analytics |
| `strafor.recruitment.vacancy_closed`    | vacancy deleted/closed                 | analytics, candidates projection |
| `strafor.recruitment.application_submitted` | new application                   | notifications, ai-matching, analytics |
| `strafor.recruitment.candidate_status_changed` | `PUT /candidates/:id/status`  | notifications, analytics |
| `strafor.recruitment.hiring_decision_recorded` | `PUT /candidates/:id/feedback` | ai-matching (labels), analytics |

These mirror the existing `strafor.vacancy.published` /
`strafor.candidate.status_changed` / `strafor.application.submitted` envelopes
(`packages/contracts/events/{vacancy,candidate,application}.js`) — the
monolith keeps publishing the legacy types during the transition and
recruitment-core publishes the `strafor.recruitment.*` family, so consumers
can subscribe to either without a flag day. After contract, the legacy types
are deprecated and the `recruitment.*` types may drop the `recruitment`
segment in v2.

Every event carries the shared envelope
`{ type, version, occurredAt, correlationId, payload }`
(`packages/contracts/events/base.js`).

## 6. Gateway routing changes

`apps/gateway/src/routes.ts` gains one upstream, mirroring the existing
`vacanciesUrl`/`candidatesUrl` pattern:

```ts
case 'vacancies':
case 'candidates':
case 'applications':
    target = config.recruitmentCoreUrl ?? config.vacanciesUrl ?? config.candidatesUrl ?? api;
    break;
case 'recruitment':          // new canonical namespace
    target = config.recruitmentCoreUrl ?? api;
    break;
```

- New env: `RECRUITMENT_CORE_URL=http://recruitment-core:3009`
  (port 3009 — next free slot in the port map; 3008 is analytics).
- `isPublicV1Path` adds `public/apply` passthrough (already covered by the
  `public/` prefix rule — verify against the public apply route).
- `VACANCIES_URL`/`CANDIDATES_URL` remain defined and take precedence so the
  future vacancies/candidates split only requires pointing them at the new
  services — no further gateway changes.
- `docker-compose` gateway fragment adds `RECRUITMENT_CORE_URL` with empty
  default (falls back to the monolith).

## 7. What the monolith becomes

Post-extraction, `apps/api` shrinks to:

- `routes/dashboard.js` — **transitional**. `analytics` builds event-fed read
  models (`analytics_vacancy_funnel`, `analytics_time_to_hire`,
  `analytics_recruiter_load`, …); once `GET /v1/analytics/*` covers the
  dashboard queries, the gateway reroutes `/api/v1/dashboard/*` and this route
  is deleted.
- `routes/settings.js`, `routes/user.js`, `routes/admin-accounts.js`,
  `routes/hr-accounts.js`, `routes/auth.js` — compatibility aliases over
  `identity-auth`; deleted when `web` stops calling legacy `/api/*`.
- `routes/countries.js` — until the last consumer moves.
- `routes/ai.js` — thin proxy to ai-matching until deleted.
- `public/` — until `web` fully replaces the HTML frontend.

At that point the monolith is retired entirely (plan §Fase 8: "Retirar el
monolito").

## 8. Risks & open questions

- **Resume file handling**: `POST /candidates` currently couples candidate
  creation to a multipart upload. Extraction must either (a) split into
  `POST /v1/documents` → `POST /v1/candidates {resumeDocumentId}` (preferred,
  matches the documents-resumes contract) or (b) keep a transitional
  multipart endpoint that forwards to documents-resumes. Decide during
  implementation; (a) is already assumed in `recruitment.yaml`.
- **`applied_for` dual shape**: the legacy contract returns `applied_for` as
  object `{id,title}` in some endpoints and as bare id in others. The new
  contract normalizes to `vacancyId` + a `vacancy` object on reads; the
  gateway keeps a compat shim only if `web` still needs it.
- **Sequence/ID drift during backfill**: copy with `pg_dump` preserves ids —
  set sequences with `setval` post-restore to avoid PK collisions.
- **Notification templates keyed to legacy types**: notifications consumer
  must subscribe to both `strafor.candidate.*` and
  `strafor.recruitment.candidate_*` during the transition (or a thin relay
  republishes legacy → recruitment until consumers migrate).
