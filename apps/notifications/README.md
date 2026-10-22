# notifications

Templated transactional email service (port 3007). Sends via SMTP (Mailpit in
dev), persists every attempt in `notification_logs` (idempotent on
`idempotency_key`), and renders `notification_templates` rows
(`(key, locale)` → subject/text/html; `en` + `es` seeded) with the
handlebars-lite renderer in `src/render.ts`.

## HTTP API

- `POST /v1/notifications/send` (service token + `Idempotency-Key`) — queue a send
- `PUT|GET /v1/notifications/preferences` — per-user channel opt-out
- `GET /v1/notifications` (admin) — log listing

## Domain-event consumer

`src/consumer.ts` binds the `notifications.domain-events` quorum queue to the
`domain.events` topic exchange for every type in `CONSUMED_EVENT_TYPES`. Each
route validates the payload with a loose zod contract (unknown fields
tolerated), resolves a recipient, and enqueues via `queueNotification`.

Recipient resolution, in order:

1. Explicit `payload.recipientEmail` / `email` (then role-flavoured fields:
   `candidateEmail`, `employeeEmail`, `workEmail`, `approverEmail`).
2. Digest-style events fall back to the `HR_NOTIFY_EMAIL` mailbox.
3. Events that carry ids only are logged and skipped (acked, never
   requeued) — no cross-service DB lookups; projections land separately.

| Event type                                     | Recipient                                        | Template key                       |
| ---------------------------------------------- | ------------------------------------------------ | ---------------------------------- |
| `strafor.application.submitted` (legacy)       | candidate                                        | `application.received`             |
| `strafor.candidate.status_changed` (legacy)    | candidate                                        | `application.status_changed`       |
| `strafor.interview.scheduled`                  | candidate                                        | `interview.scheduled`              |
| `strafor.auth.password_reset_requested`        | user                                             | `auth.password_reset`              |
| `strafor.notification.requested`               | payload-driven                                   | payload-driven                     |
| `strafor.recruitment.application_submitted`    | candidate                                        | `recruitment.application_received` |
| `strafor.recruitment.candidate_status_changed` | candidate                                        | `recruitment.status_changed`       |
| `strafor.recruitment.vacancy_published`        | HR mailbox                                       | `recruitment.vacancy_published`    |
| `strafor.recruitment.hiring_decision_recorded` | candidate                                        | `recruitment.hiring_decision`      |
| `strafor.services.ticket_created`              | employee                                         | `services.ticket_created`          |
| `strafor.services.ticket_assigned`             | employee                                         | `services.ticket_assigned`         |
| `strafor.services.ticket_resolved`             | employee                                         | `services.ticket_resolved`         |
| `strafor.services.expense_submitted`           | approver / HR                                    | `services.expense_submitted`       |
| `strafor.services.expense_decided`             | employee                                         | `services.expense_decided`         |
| `strafor.services.survey_opened`               | employee                                         | `services.survey_opened`           |
| `strafor.services.survey_closed`               | HR mailbox                                       | `services.survey_closed`           |
| `strafor.payroll.period_status`                | HR mailbox                                       | `payroll.period_status`            |
| `strafor.payroll.reconciled`                   | HR mailbox                                       | `payroll.reconciled`               |
| `strafor.hr.employee_created`                  | work email                                       | `hr.employee_welcome`              |
| `strafor.hr.employee_terminated`               | HR mailbox                                       | `hr.employee_terminated`           |
| `strafor.attendance.recorded`                  | HR mailbox, only when `payload.anomaly === true` | `attendance.anomaly`               |

Notes:

- The `strafor.recruitment.application_submitted` route derives
  `application:{applicationId}` as its idempotency key — the same key the
  legacy `strafor.application.submitted` payload carries — so the
  dual-published pair collapses into a single send.
- `strafor.recruitment.hiring_decision_recorded` deliberately omits the
  decision from the template payload (neutral wording for offer/rejection).
- `HR_NOTIFY_EMAIL` unset → every "HR mailbox" row above is skipped.

## Env

`DATABASE_URL`, `SMTP_*` (host/port/secure/user/pass/from),
`SERVICE_AUTH_TOKEN`, `RABBITMQ_URL`, `RABBITMQ_EXCHANGE`,
`HR_NOTIFY_EMAIL` (optional), `WORKER_POLL_MS`, `RETRY_BASE_MS`,
`MAX_ATTEMPTS`.

## Tests

`vitest run` — `tests/render.test.ts` and `tests/consumer.routes.test.ts` are
pure unit tests; `tests/notifications.integration.test.ts` needs
`TEST_DATABASE_URL`, `TEST_SMTP_*` and optionally `TEST_RABBITMQ_URL`.
