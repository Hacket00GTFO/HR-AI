# time-attendance

Work schedules, consent-gated geo check-ins, approval-only attendance
corrections, and MX statutory leave. Port **3011**, database `strafor_time`.

## Privacy & governance rules

- **Point-in-time geo only.** Coordinates are stored on a punch event when —
  and only when — the employee passes `consent: true` for that event. There
  is no continuous tracking, no location history beyond recorded punches, and
  the DB enforces it (`CHECK (geo_lat IS NULL OR geo_consent = true)`).
- **No direct event edits.** `attendance_events` is append-only for clients;
  every change goes through `attendance_corrections` (request → hr/manager
  approve → applied in a transaction, `source` flips to `'correction'`).
- **`admin` gets 403 everywhere.** Platform admins never see attendance or
  geo data. Self-service roles are `employee`, `hr`, `manager`.
- **Employee ids are hr-core integers** — plain columns, no cross-DB FK.
  `X-Employee-Id` (gateway header) supplies the id; it falls back to
  `X-User-Id` until hr-core wires the user → employee link.

## Endpoints

All routes are mounted under `/v1` and reached through the gateway as
`/api/v1/...` (the gateway strips `/api`).

| Method         | Path                                     | Auth                | Notes                                                                                                                                                          |
| -------------- | ---------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST           | `/v1/attendance/check`                   | employee/hr/manager | `{kind, occurredAt?, lat?, lng?, accuracy?, consent}` — geo only with `consent=true`; `source='pwa'`; duplicate open check-in → 409                            |
| GET            | `/v1/attendance/mine`                    | employee/hr/manager | own events (`from`, `to`, `limit`)                                                                                                                             |
| GET            | `/v1/attendance`                         | hr                  | `?employeeId=&from=&to=`                                                                                                                                       |
| POST           | `/v1/attendance/corrections`             | employee/hr/manager | `{eventId, field: occurred_at\|kind\|geo, newValue, reason}` — own events only (hr: any)                                                                       |
| GET            | `/v1/attendance/corrections`             | employee/hr/manager | reviewers see all, employees see own; `?status=`                                                                                                               |
| PUT            | `/v1/attendance/corrections/:id/approve` | hr/manager          | applies the change to the event in a tx                                                                                                                        |
| PUT            | `/v1/attendance/corrections/:id/reject`  | hr/manager          |                                                                                                                                                                |
| GET            | `/v1/leave/types`                        | employee/hr/manager | seeded MX statutory types                                                                                                                                      |
| POST           | `/v1/leave/requests`                     | employee/hr/manager | `{leaveTypeId\|leaveTypeCode, startDate, endDate, reason?}`; days computed server-side (inclusive calendar days); auto-approves when `requires_approval=false` |
| GET            | `/v1/leave/requests`                     | employee/hr/manager | self → own; hr → all (`?employeeId=`, `?status=`)                                                                                                              |
| PUT            | `/v1/leave/requests/:id/approve`         | hr/manager          | decrements balance in tx for entitlement-bearing types; insufficient → 409                                                                                     |
| PUT            | `/v1/leave/requests/:id/reject`          | hr/manager          |                                                                                                                                                                |
| PUT            | `/v1/leave/requests/:id/cancel`          | employee/hr/manager | owner cancels a pending request                                                                                                                                |
| GET            | `/v1/leave/balances`                     | employee/hr/manager | self → own; hr → all or `?employeeId=`, `?year=`                                                                                                               |
| POST           | `/v1/leave/accrue`                       | **X-Service-Token** | `{employeeId, hireDate, asOf?}` — recomputes MX LFT-76 vacation entitlement, upserts `leave_balances`                                                          |
| POST           | `/v1/schedules`                          | hr                  | `{name, type: fixed\|flexible\|shift, weeklyHours, config}`                                                                                                    |
| GET            | `/v1/schedules`                          | hr                  | `?active=`                                                                                                                                                     |
| GET/PUT/DELETE | `/v1/schedules/:id`                      | hr                  | DELETE is a soft-delete (`active=false`)                                                                                                                       |
| POST           | `/v1/schedules/:id/assign`               | hr                  | `{employeeId, effectiveFrom, effectiveTo?}` — one open assignment per employee                                                                                 |
| POST           | `/v1/schedules/:id/unassign`             | hr                  | `{employeeId, effectiveTo?}` — closes the open assignment                                                                                                      |

## MX vacation accrual (LFT art. 76, reforma 2023)

The statutory table is stored in `leave_types.accrual` for `vacaciones` and
mirrored in `src/mxVacation.ts`:

| Years of service | Days |
| ---------------- | ---- |
| 1                | 12   |
| 2                | 14   |
| 3                | 16   |
| 4                | 18   |
| 5                | 20   |
| 6–10             | 22   |
| 11–15            | 24   |
| 16–20            | 26   |
| 21–25            | 28   |
| 26–30            | 30   |
| 31–35            | 32   |

`POST /v1/leave/accrue` computes completed years at `asOf` (default: today),
looks up the entitlement, and upserts `leave_balances` for the current
calendar year. Only `leave_types` rows with a non-empty `accrual.table` are
entitlement-bearing — approval of other types does not touch balances.

## Domain events (best-effort, `domain.events` topic exchange)

- `strafor.attendance.recorded` — `{eventId, employeeId, kind, occurredAt, source, geo?}`
- `strafor.leave.requested` — `{requestId, employeeId, leaveType, startDate, endDate, days, requiresApproval}`
- `strafor.leave.decided` — `{requestId, employeeId, leaveType, decision, approverId?}`

Schemas live in `src/eventSchemas.ts` (`eventEnvelope` from
`@strafor/contracts/events/base.js`); promote to `@strafor/contracts` when a
second consumer needs them.

## Gateway wiring (do this in apps/gateway — NOT part of this service)

`apps/gateway/src/config.ts` — add to `GatewayConfig` and `loadConfig`:

```ts
timeAttendanceUrl?: string;
// ...
...(env.TIME_ATTENDANCE_URL ? { timeAttendanceUrl: env.TIME_ATTENDANCE_URL } : {}),
```

`apps/gateway/src/routes.ts` — extend the `/api/v1` switch:

```ts
case 'attendance':
case 'leave':
case 'schedules':
    target = config.timeAttendanceUrl ?? api;
    break;
```

`infra/compose/services/gateway.yml` / gateway env:

```yaml
TIME_ATTENDANCE_URL: http://time-attendance:3011
```

No public-path changes needed — all `/api/v1/{attendance,leave,schedules}`
routes require the gateway JWT guard (none are in `isPublicV1Path`).

## Develop

```bash
cp .env.example .env          # point DATABASE_URL at a strafor_time database
pnpm install
pnpm migrate                  # node-pg-migrate up
pnpm dev                      # tsc + node --watch dist/server.js
pnpm test                     # vitest run (stubbed pool — no infra needed)
pnpm typecheck
```

Migrations also run automatically at boot (`server.js` → `node-pg-migrate`).
