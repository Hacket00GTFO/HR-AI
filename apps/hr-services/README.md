# @strafor/hr-services

HR employee-facing services on port **3014**, database **`strafor_services`**:

- **Mesa de servicio** — HR service-desk tickets with SLA due dates, comments
  and a full status history.
- **Activos** — company asset inventory and checkout/checkin assignments
  with condition notes.
- **Viáticos** — travel & expense reports with a
  draft → submitted → approved/rejected → paid approval flow.
- **NOM-035 / climate surveys** — anonymous surveys with pseudonymised
  respondents and k-anonymised aggregate results only.

## Security model

- `requireHR` is strictly `role === 'hr'` — platform **admins get 403 on
  every business route**, including employee self-service routes.
- Employee self-service (`/v1/*/my*`, `/v1/surveys/open`, `respond`,
  `my-response`) requires gateway identity headers (`X-User-Id` /
  `X-User-Role`) and resolves the caller's hr-core `employee_id` through the
  `employee_directory` projection. Every query is scoped by that id — a user
  can never read another employee's tickets, expenses or asset assignments.
- `X-Service-Token` (`requireService`) is accepted on `/v1/internal/*` only;
  it does not grant employee context on self-service routes.
- Survey responses are pseudonymised: `respondent_hash =
HMAC_SHA256(SURVEY_RESPONDENT_SALT, "<surveyId>:<employeeId>")`. The raw
  employee id is never stored on `survey_responses`.
- **HR never sees individual survey answers.** Results are aggregates with
  k-anonymity: any (group, dimension) cell with fewer than
  `SURVEY_MIN_GROUP_SIZE` respondents (default 5) returns HTTP **200** with
  `{ "suppressed": true, "reason": "k<5" }`.
- Answers to `health_related` questions (medical risk factors, psicosocial)
  are stored in `survey_health_answers` — a separate table whose every
  read/write appends to `survey_health_audit`.

## Events (transactional outbox → `domain.events` topic exchange)

`strafor.services.ticket_created`, `.ticket_assigned`, `.ticket_resolved`,
`.asset_assigned`, `.asset_returned`, `.expense_submitted`,
`.expense_decided`, `.survey_opened`, `.survey_closed`. Envelope:
`{ type, version: 1, occurredAt, correlationId, payload }`. Schemas are
defined locally in `src/events.ts`.

## Development

```bash
pnpm install --filter @strafor/hr-services
pnpm --filter @strafor/hr-services migrate   # needs DATABASE_URL
pnpm --filter @strafor/hr-services test
pnpm --filter @strafor/hr-services dev
```

Gateway routes needed (wired by the platform, not this service):
`/api/v1/{tickets,assets,expenses,surveys}*` → `hr-services:3014`.
