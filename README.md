# StraforAI

HR/ATS/HRM platform — recruitment pipeline, employee operations, time &
attendance, payroll (MX), HR services, AI-assisted candidate↔vacancy matching.

Structured as a **pnpm workspaces + Turborepo monorepo** decomposed into
independently containerized services (strangler-fig). The legacy monolith is
still deployed and serves as an automatic fallback while extracted domains
soak — every gateway route family can be rolled back by clearing one env var.

## Architecture

```
apps/
  gateway/              # API gateway — routing, JWT/JWKS enforcement (port 8081)
  api/                  # Express monolith — dashboard, admin, settings, legacy domains (3000)
  identity-auth/        # RS256 JWT auth, users, refresh tokens, MFA, OIDC/SAML SSO (3015→3001)
  recruitment-core/     # Vacancies, candidates, applications, interviews, offers (3009)
  hr-core/              # Employees, org tree, onboarding/offboarding, performance (3013→3010)
  time-attendance/      # Check-ins (geolocation opt-in), leave (LFT art. 76), schedules (3011)
  payroll-adapter/      # Payroll lifecycle, SUA/IDSE files, CLABE bank dispersion (3012)
  hr-services/          # Service desk, assets, expenses, NOM-035 surveys (3014)
  documents-resumes/    # Resume/document storage — MinIO S3, ACL-gated (3004)
  notifications/        # Email worker — templates EN/ES-MX, Mailpit SMTP (3007)
  calendar-bridge/      # M365 / Exchange via Graph client-credentials (3016)
  directory-sync/       # Identity → per-service projections (internal worker, no host port)
  ai-matching/          # Candidate↔vacancy matching — FastAPI + Celery (3005)
  analytics/            # Event analytics sink — Express + RabbitMQ (3008)
  web/                  # Next.js 15 — careers, internal UI, employee/candidate portals (3010)
packages/
  node-common/          # Shared pino logger, correlation-id, zod env loader, tracing
  contracts/            # OpenAPI specs + Zod event schemas
  eslint-config/        # Shared ESLint 9 flat config
  tsconfig/             # Shared tsconfig.base.json
infra/
  compose/services/     # Per-service compose fragments (merged via include:)
  compose/observability/# Prometheus, Grafana, Loki, Tempo, Alertmanager, exporters
  compose/initdb/       # PostgreSQL init — creates per-service databases
  compose/keycloak/     # Dev realm for OIDC/SSO testing (profile: sso)
  k8s/                  # Kubernetes manifests (kustomize: base + prod overlay)
  scripts/backfill-recruitment/  # Monolith → recruitment-core data migration
  seed-data/            # Committable seed/eval datasets
tests/
  e2e/                  # Cross-service role-matrix suite (live HTTP vs the stack)
docs/
  extraction/           # Extraction plans (recruitment-core.md)
  runbooks/             # Operational runbooks (recruitment-cutover.md)
  security/role-matrix.md  # Generated authorization matrix (297 checks)
  observability/        # Observability docs + alert runbooks
  adr/                  # Architecture decision records
secure_uploads/         # Runtime resume storage — gitignored, auth-gated
docker-compose.yml      # Root compose — platform services + includes
```

## Service ports

| Service           | Host port      | Internal | Database              |
| ----------------- | -------------- | -------- | --------------------- |
| gateway           | **8081**       | 8081     | —                     |
| api (monolith)    | 3000           | 3000     | innovation            |
| identity-auth     | 3015           | 3001     | strafor_identity      |
| documents-resumes | 3004           | 3004     | strafor_documents     |
| ai-matching       | 3005           | 3005     | strafor_ai            |
| notifications     | 3007           | 3007     | strafor_notifications |
| analytics         | 3008           | 3008     | strafor_analytics     |
| recruitment-core  | 3009           | 3009     | strafor_recruitment   |
| web (Next.js)     | 3010           | 3010     | —                     |
| time-attendance   | 3011           | 3011     | strafor_time          |
| payroll-adapter   | 3012           | 3012     | strafor_payroll       |
| hr-core           | 3013           | 3010     | strafor_hr            |
| hr-services       | 3014           | 3014     | strafor_services      |
| calendar-bridge   | 3016           | 3016     | strafor_integrations  |
| directory-sync    | —              | —        | (worker only)         |
| Keycloak (dev)    | 8180           | 8080     | (profile `sso`)       |
| PostgreSQL        | 127.0.0.1:5433 | 5432     | —                     |
| Redis             | 127.0.0.1:6380 | 6379     | —                     |
| RabbitMQ          | 5672/15672     | —        | —                     |
| MinIO             | 9000/9001      | —        | —                     |
| Mailpit           | 1025/8025      | —        | —                     |

> Host ports for db/redis/identity-auth were remapped to avoid collisions
> with other local projects. Container-to-container DNS never changes —
> `IDENTITY_URL=http://identity-auth:3001` etc. are unaffected.

## Gateway routing

All client traffic enters through the gateway (`:8081`). JWT is required on
`/api/v1/**` except the public allowlist (`/api/v1/auth/*`, vacancies listing,
candidate apply). The gateway strips client-supplied `X-User-*`/`X-Service-*`
headers, verifies RS256 tokens against identity's JWKS, and injects trusted
identity headers downstream.

| Path family                                                                          | Upstream            | Fallback |
| ------------------------------------------------------------------------------------ | ------------------- | -------- |
| `/api/v1/{auth,users,settings}`                                                      | identity-auth       | —        |
| `/api/v1/documents`                                                                  | documents-resumes   | monolith |
| `/api/v1/notifications`                                                              | notifications       | monolith |
| `/api/v1/{match,ai}` (not feedback)                                                  | ai-matching         | monolith |
| `/api/v1/{vacancies,candidates,applications,public,recruitment,ai/process-feedback}` | recruitment-core    | monolith |
| `/api/v1/{employees,hr,org}`                                                         | hr-core             | monolith |
| `/api/v1/{attendance,leave,schedules}`                                               | time-attendance     | monolith |
| `/api/v1/payroll`                                                                    | payroll-adapter     | monolith |
| `/api/v1/{tickets,assets,expenses,surveys}`                                          | hr-services         | monolith |
| `/api/v1/calendar`                                                                   | calendar-bridge     | monolith |
| all other `/api/*`                                                                   | monolith (verbatim) | —        |
| non-`/api/*`                                                                         | web (static)        | —        |

V1 routes strip `/api/v1` before proxying. When a family falls back to the
monolith the path is rewritten `/api/v1/x → /api/x` (the monolith mounts
under `/api` only). **Rollback for any service = clear its `*_URL` env var and
`docker compose up -d gateway`.**

## Prerequisites

- Node.js >= 20 (developed on v24)
- pnpm 11 (`corepack enable`)
- Docker Engine + Compose v2

## Quick start

```bash
pnpm install
cp .env.example .env   # fill in secrets — see "Environment" below
docker compose up -d --build
```

Verify: `docker compose ps` should show all services `healthy` (~30
containers including observability).

Admin login: `admin@strafor.ai` / `admin123` (dev seed). The frontend is at
`http://localhost:3010`; the API perimeter is `http://localhost:8081`.

## Authentication

- **identity-auth** issues RS256 access tokens (15 min) + refresh tokens;
  JWKS at `/.well-known/jwks.json`. Keys via `pnpm --filter @strafor/identity-auth
genkeys`, mounted PEMs, or `JWT_GENERATE_KEYS=true` (dev/CI only — ephemeral).
- **MFA** — TOTP challenge flow + enrollment wizard at `/mfa/setup`; admin-side
  enforcement policies.
- **SSO** — OIDC and SAML-compatible; dev realm via
  `docker compose --profile sso up keycloak` (issuer
  `http://localhost:8180/realms/strafor`).
- **Legacy HS256** is accepted by the monolith only when
  `ALLOW_LEGACY_HS256=true` (default `false` — JWKS only).
- **Service-to-service** calls use `X-Service-Token` (`SERVICE_AUTH_TOKEN`),
  which the gateway strips from client traffic — it never authenticates an
  end user at the perimeter.

## Roles & permissions

Two primary roles — `admin` and `hr` — with **strict** separation enforced
in every service's middleware, not just the UI: admins never inherit HR
capabilities, and HR cannot touch platform configuration.

| Capability                                                      | admin | hr  |
| --------------------------------------------------------------- | :---: | :-: |
| Platform admin: users, audit, jobs, health, feature flags, SSO, |  ✅   | ❌  |
| API keys, webhooks, email templates, retention, branding        |       |     |
| Vacancies/candidates/applications/interviews/offers             |  ❌   | ✅  |
| Employees, org, onboarding, performance, training               |  ❌   | ✅  |
| Attendance, leave approvals, schedules                          |  ❌   | ✅  |
| Payroll periods, SUA/IDSE, bank dispersion, benefits            |  ❌   | ✅  |
| HR services: tickets, assets, expenses, NOM-035 results         |  ❌   | ✅  |

Self-service roles (`employee`, `manager`, `candidate`) are scoped to their
own records via asserted-identity headers injected by the gateway —
identity-auth only mints `admin`/`hr` JWTs (DB CHECK constraint).

The generated authorization matrix lives in
[`docs/security/role-matrix.md`](docs/security/role-matrix.md) — regenerated
from live E2E results, not hand-maintained.

## Feature domains

- **Recruitment** (`recruitment-core`) — vacancies with canonical states,
  candidates, applications + status history, interviews with scorecards,
  offers, public jobs API, cover letters, candidate-facing folios.
- **HR core** (`hr-core`) — employee records, org tree, interdepartmental
  onboarding/offboarding task templates (IT/RH/Finanzas/Facilities) with
  in-transaction auto-completion, performance, training.
- **Time & attendance** (`time-attendance`) — point-in-time geolocation
  check-in with explicit consent (no continuous tracking), approved
  corrections, leave accruals per LFT art. 76, mixed schedules.
- **Payroll** (`payroll-adapter`) — period lifecycle
  `draft→calculating→review→locked→exported→reconciled→finalized` with
  four-eyes approval, SUA file layout (IMSS/IDSE), CLABE-validated bank
  dispersion, tolerance-based reconciliation, idempotent provider imports.
- **HR services** (`hr-services`) — service-desk tickets with SLA by
  priority, asset checkout/checkin, expense workflow
  (draft→submitted→approved→paid, server-computed totals), NOM-035 surveys
  with **k-anonymity n≥5** (small cells suppressed, raw answers never
  exposed via API, health responses access-audited).
- **Calendar** (`calendar-bridge`) — M365/Exchange free-busy and event
  creation with Teams links via Graph client-credentials; deterministic
  `stub` provider when `M365_*` vars are empty. Secrets are never logged or
  returned.
- **Notifications** (`notifications`) — RabbitMQ consumer with 16+ event
  bindings (`strafor.recruitment.*`, `strafor.services.*`, `strafor.payroll.*`,
  `strafor.hr.*`, …), bilingual EN/ES-MX templates, idempotency-key dedupe,
  admin email test-send, Mailpit in dev.
- **Directory sync** (`directory-sync`) — stateless worker projecting
  identity users into `users_projection` (recruitment) and
  `employee_directory` (hr-services/hr-core) on a poll loop.
- **DSAR** — identity publishes `strafor.identity.*` events; each service
  exposes internal `dsar-export`/erasure endpoints for cross-service
  fan-out (access export JSON + transactional anonymization incl. CV and
  embeddings).
- **Frontend** (`web`) — public `/careers` + candidate portal
  (`/portal/candidato`), employee self-service portal (`/portal/*`:
  attendance with geo consent, leave, tickets, expenses, assets), HR pages
  (`/portal/org`, `/portal/team`, `/portal/approvals/*`, `/portal/surveys`),
  role-filtered nav, PWA manifest, i18n ES-MX/EN (`locale` cookie),
  WCAG 2.2 AA (focus-trapped drawer, skip links), CSP with
  `geolocation=(self)`.

## Environment

Root `.env` (never committed — copy from `.env.example`). Key variables:

| Variable                               | Required      | Notes                                                     |
| -------------------------------------- | ------------- | --------------------------------------------------------- |
| `POSTGRES_PASSWORD`                    | yes           | Postgres superuser password                               |
| `DATABASE_URL`                         | yes           | `postgres://user:pass@db:5432/innovation`                 |
| `JWT_SECRET`                           | yes*          | Legacy HS256 secret (* only if `ALLOW_LEGACY_HS256=true`) |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`   | prod          | RS256 PEMs; `JWT_GENERATE_KEYS=true` for dev              |
| `SERVICE_AUTH_TOKEN`                   | yes           | Service-to-service auth header                            |
| `RABBITMQ_PASSWORD`                    | yes           | RabbitMQ password                                         |
| `MINIO_ROOT_PASSWORD`                  | yes           | MinIO root password                                       |
| `SETTINGS_ENCRYPTION_KEY`              | yes           | AES-256-GCM key (base64, 32 bytes)                        |
| `METRICS_TOKEN`                        | yes           | Bearer token required to scrape `/metrics`                |
| `AUTH_MODE`                            | yes           | `v1` → web calls gateway `/api/v1/*`; `legacy` → monolith |
| `*_URL` service vars                   | cutover       | Empty → that path family falls back to the monolith       |
| `M365_TENANT_ID/CLIENT_ID/SECRET`      | prod calendar | All three empty → deterministic stub provider             |
| `LLM_PROVIDER`                         | yes           | `mock` (dev) / `openai` / `anthropic` / self-hosted vLLM  |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | if used       | —                                                         |

See `.env.example` for the full list (SMTP, MinIO, observability,
`PUBLIC_BASE_URL`, retention, …).

## Commands

| Command                                        | What it runs                                  |
| ---------------------------------------------- | --------------------------------------------- |
| `pnpm install`                                 | Install all workspace deps                    |
| `pnpm dev`                                     | `turbo run dev` — watch mode for all services |
| `pnpm test`                                    | `turbo run test` — vitest/pytest suites       |
| `pnpm lint`                                    | `turbo run lint` — ESLint                     |
| `pnpm build`                                   | `turbo run build` — Next.js + service builds  |
| `pnpm typecheck`                               | `turbo run typecheck`                         |
| `pnpm --filter @strafor/api migrate`           | Apply monolith DB migrations                  |
| `pnpm --filter @strafor/identity-auth genkeys` | Generate RS256 keypair                        |
| `pnpm --filter @strafor/e2e-tests test`        | Role-matrix E2E vs the live stack             |
| `pnpm --filter @strafor/e2e-tests seed`        | Seed E2E admin/hr users (idempotent)          |
| `pnpm --filter @strafor/e2e-tests matrix:doc`  | Regenerate `docs/security/role-matrix.md`     |

## Database

Each service owns its own PostgreSQL database (no cross-service FKs).
`infra/compose/initdb/` creates them on first `docker compose up` against a
fresh `pgdata` volume. For existing volumes:

```bash
docker exec straforai-db-1 psql -U strafor -d postgres -c "CREATE DATABASE <name>;"
```

Schema is versioned per service (node-pg-migrate in `apps/<svc>/migrations/`,
or Knex where noted). Services apply pending migrations at boot.

## Recruitment cutover & backfill

`recruitment-core` is **live**: `RECRUITMENT_CORE_URL` is set and the gateway
serves vacancies/candidates/applications from `strafor_recruitment`. The
migration used `infra/scripts/backfill-recruitment`:

```bash
node infra/scripts/backfill-recruitment/run.js --mode=copy    # idempotent, resumable
node infra/scripts/backfill-recruitment/run.js --mode=verify  # per-table checksum diff
```

`users_projection` reporting more rows than the monolith is **expected** —
directory-sync also projects identity-sourced users. During the soak period
(≥1 week) keep the monolith deployed and re-run `--mode=verify` periodically
to detect drift; do not contract the legacy tables until soak completes.
Full procedure: [`docs/runbooks/recruitment-cutover.md`](docs/runbooks/recruitment-cutover.md).

**Rollback:** unset `RECRUITMENT_CORE_URL`, `docker compose up -d gateway`.

## E2E role matrix

`tests/e2e/` exercises the real compose stack over HTTP — no mocks:

- **Gateway layer**: every request through `:8081` like a real client —
  anonymous 401s, forged `X-User-*` rejection, `X-Service-Token` stripping,
  admin→403 on business routes, hr→403 on admin surfaces.
- **Direct layer**: services on their published ports simulating internal
  callers (asserted identity headers / service token) — the only way to
  exercise `employee`/`manager`/`candidate` scoping.

Every check is recorded to `.results/*.jsonl` and folded into
`docs/security/role-matrix.md`. Persistent 429s are classified `tolerated`
(a rejection, but not an authorization verdict); transport aborts are
retried then recorded as `error`. The suite paces requests (~25 ms) because
Docker Desktop's port proxy stalls under rapid sequential connects.

```bash
docker compose up -d
pnpm --filter @strafor/e2e-tests seed && pnpm --filter @strafor/e2e-tests test
pnpm --filter @strafor/e2e-tests matrix:doc
```

## Observability

- **Prometheus** scrapes `/metrics` from every service (requires
  `METRICS_TOKEN`) plus cAdvisor, node-exporter, postgres/redis/blackbox/
  celery exporters.
- **Grafana** is not host-published — the web BFF proxies it at
  `/api/grafana/*`. Dev override (`docker-compose.observability-dev.yml`)
  publishes it directly if needed.
- **Tempo** (OTLP tracing, `OTEL_EXPORTER_OTLP_ENDPOINT`), **Loki** (logs),
  **Alertmanager** → monolith webhook (`ALERT_WEBHOOK_TOKEN`) + email.

## AI matching

The `ai-matching` service replaces the legacy `CandidateMatcher.js` with:

- CV parsing (PDF/DOCX text extraction)
- ESCO-like skill canonicalization
- `pgvector` embeddings + hybrid retrieval
- LLM reranking — self-hosted vLLM/Ollama supported; provider allowlist and
  field whitelist prevent public-API exfiltration; `mock` for offline dev
- Persisted, versioned match scores with explainability (score breakdown,
  red flags, recommendations) — the AI is a **human-supervised recommender**,
  never an autonomous hiring/financial decision-maker
- Prompt-injection detection (red-team corpus in `evaluation/corpora/`)
- Fairness checks (four-fifths rule, protected-field audit)
- Monthly budget gate + circuit breaker

See `apps/ai-matching/docs/eval/README.md` and `docs/compliance/` for
GDPR/AI Act/NYC LL144/threat-model docs.

## Contracts & events

- `packages/contracts/openapi/` — OpenAPI 3.1 specs per service
- `packages/contracts/events/` — Zod event schemas
- Transactional outbox + relay in each domain service → RabbitMQ topic
  exchange `domain.events` → consumers (notifications, analytics, directory
  projections)

## CI

`.github/workflows/ci.yml`:

- `lint` / `typecheck` / `test` — turbo `--filter='[HEAD^]'` changed packages
- `ai-matching` — pytest
- `integration` — API + notifications tests against real Postgres/RabbitMQ/Mailpit services
- `e2e` — full compose stack role matrix (main pushes + manual dispatch; too heavy for PRs)
- `audit` — `pnpm audit --prod`
- `docker-build` + `trivy` — image build, CRITICAL/HIGH fails

## Kubernetes

Base manifests in `infra/k8s/base/`, production overlay (AKS) under
`infra/k8s/` — deploy with kustomize:

```bash
kubectl apply -k infra/k8s/base/
```

See `infra/k8s/README.md` for details.

## Docker

```bash
docker compose up -d --build    # full stack
docker compose ps               # check health
docker compose logs -f <svc>    # tail a service
docker compose build <svc>      # rebuild one image
docker compose up -d <svc>      # recreate with new env
docker compose --profile sso up -d keycloak   # dev IdP
docker compose down             # stop all
```

### Line endings

Shell scripts (`docker-entrypoint.sh`) must use **LF** — `.gitattributes`
enforces this. If you edit one on Windows, run `git add --renormalize .`
before committing.

## Contributing

1. `pnpm install`, create a branch, commit — husky + lint-staged run
   prettier/eslint on staged files.
2. Open a PR — CI lints, typechecks, tests, builds the Docker image and
   scans it with Trivy.
3. When creating a new service: add its compose fragment to
   `infra/compose/services/`, include it in `docker-compose.yml`, add its
   database to `infra/compose/initdb/`, wire its route family in
   `apps/gateway/src/routes.ts` + `config.ts`, document the `*_URL` var in
   `.env.example`, and add role-matrix cases in `tests/e2e/`.
