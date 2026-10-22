# payroll-adapter

Adapter-first payroll service for Mexico. Payroll is **never computed natively**
here — this service is an adapter + lifecycle + reconciliation layer over
external payroll providers (file-based today, pluggable tomorrow), with
shadow-mode comparison before any cutover. Frequencies: `catorcenal`
(biweekly) and `mensual`.

- Port: **3012** — Database: **strafor_payroll**
- Route mounting: `src/app.ts` serves everything under `/v1/payroll/*`.

## Gateway routing (wired by the parent integration — do NOT edit apps/gateway here)

The gateway must proxy:

```
/api/v1/payroll/*  →  payroll-adapter:3012  (strip the /api prefix, keep /v1/payroll/*)
```

All endpoints are HR/Finance-only. `admin` → **403 always** — platform admins
never see payroll data (governance rule, same as hr-core/documents-resumes).

## Lifecycle

```
draft → calculating → review → locked → exported → reconciled → finalized
draft/review → cancelled
```

Four-eyes guard: `locked→exported` and `reconciled→finalized` require the
approving user to differ from the period's `created_by` (409 otherwise).

## Adapters (`src/adapters/`)

| Adapter key    | Purpose                                                       |
| -------------- | ------------------------------------------------------------- |
| `file_generic` | Imports provider results dropped in `IMPORTS_DIR` (CSV/JSON). |
| `sandbox_stub` | Deterministic fake provider for dev/tests.                    |

New providers implement `PayrollAdapter` and register in `adapters/index.ts` —
no route changes needed.

## Import file format (file_generic)

`IMPORTS_DIR/period-<id>.json` (`{ "items": [...] }` or a bare array) or
`period-<id>.csv` with header `employee_id,gross,net,provider_ref,deductions`.
Each item needs `employee_id`, `gross`, `net`, and a unique `provider_ref`
(imports are idempotent on `(period_id, provider_ref)`).

## Tests

`pnpm test` — stubbed pg pool (no live DB), vitest + supertest.
