# @strafor/calendar-bridge

Microservice wrapping Microsoft 365 / Exchange calendar for interview
scheduling (port **3016**, database `strafor_integrations`).

When the `M365_*` credentials are absent the service runs in **stub mode**:
deterministic pseudo-random free/busy blocks (seeded by `email|date`) and
fake `stub-<n>` event ids — the whole API works end-to-end with no tenant.

## Auth

- `X-Service-Token: $SERVICE_AUTH_TOKEN` — internal callers
  (recruitment-core, later the employee portal BFF).
- Gateway user headers (`X-User-Id`, `X-User-Role`) — only role `hr` passes;
  platform `admin` is always 403.

## API

| Method | Path                               | Description                                                                                             |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/calendar/provider`            | Active mode + masked M365 config                                                                        |
| POST   | `/v1/calendar/free-busy`           | `{emails[], start, end}` → per-email busy intervals                                                     |
| POST   | `/v1/calendar/events`              | Create event; `locationOrTeams:true` adds a Teams link. `externalRef` / `interviewId` = idempotency key |
| GET    | `/v1/calendar/events?interviewId=` | Lookup by `external_ref`                                                                                |
| DELETE | `/v1/calendar/events/:id`          | Cancel (internal id or provider event id)                                                               |

## Events out

`strafor.integrations.calendar_event_created` /
`strafor.integrations.calendar_event_cancelled` on the `domain.events`
topic exchange, via the transactional outbox.

## Configuration

| Var                                                        | Notes                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`                                             | `postgres://…/strafor_integrations`                                       |
| `SERVICE_AUTH_TOKEN`                                       | shared service secret                                                     |
| `M365_TENANT_ID` / `M365_CLIENT_ID` / `M365_CLIENT_SECRET` | all three required for real Graph mode; never logged, masked in responses |
| `RABBITMQ_URL` / `RABBITMQ_EXCHANGE`                       | optional; outbox accumulates without a broker                             |

M365 setup: Entra app registration with **application** permission
`Calendars.ReadWrite` (admin consent). Token flow is client credentials
against `login.microsoftonline.com/{tenant}/oauth2/v2.0/token` — no MSAL
dependency.

## Privacy

The event subject is persisted only as `subject_hash` (SHA-256);
`integration_audit` records actor/action/external_ref only — no bodies,
attendee lists, or credentials.
