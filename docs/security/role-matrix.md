# Cross-service role matrix

Generated from 297 recorded checks — `tests/e2e/.results/*.jsonl`.
Do not edit by hand; regenerate with `pnpm --filter @strafor/e2e-tests matrix:doc`.

Marks: ✓ expected status · △ tolerated deviation · ✗ unexpected status · ! transport error.

## auth-matrix

### `hr-core/employees` — GET /api/v1/employees (gateway → hr-core)

Guard: serviceOrUserAuth + requireHR

| Persona   | Expected | Actual | Result |
| --------- | -------- | ------ | ------ |
| forged    | 401      | 401    | ✓      |
| anon      | 401      | 401    | ✓      |
| anon      | 401      | 401    | ✓      |
| admin     | 403      | 403    | ✓      |
| admin     | 403      | 403    | ✓      |
| hr        | 200      | 200    | ✓      |
| hr        | 200      | 200    | ✓      |
| manager   | 403      | 403    | ✓      |
| employee  | 403      | 403    | ✓      |
| candidate | 403      | 403    | ✓      |
| service   | 401      | 401    | ✓      |
| service   | 200      | 200    | ✓      |

### `hr-core/employees-create` — POST /api/v1/employees (gateway → hr-core)

Guard: serviceOrUserAuth + requireHR

| Persona | Expected        | Actual | Result |
| ------- | --------------- | ------ | ------ |
| forged  | 401             | 401    | ✓      |
| anon    | 401             | 401    | ✓      |
| admin   | 403             | 403    | ✓      |
| hr      | 200/201/400/422 | 400    | ✓      |
| service | 401             | 401    | ✓      |

### `hr-core/org-tree` — GET /api/v1/org/tree (gateway → hr-core)

Guard: serviceOrUserAuth + requireHR

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| forged  | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| admin   | 403      | 403    | ✓      |
| hr      | 200      | 200    | ✓      |
| service | 401      | 401    | ✓      |

### `hr-core/org-departments` — GET /api/v1/org/departments (gateway → hr-core)

Guard: serviceOrUserAuth + requireHR

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| forged  | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| admin   | 403      | 403    | ✓      |
| hr      | 200      | 200    | ✓      |
| service | 401      | 401    | ✓      |

### `hr-core/onboarding` — GET /api/v1/hr/onboarding (gateway → hr-core)

Guard: serviceOrUserAuth + requireHR

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| forged  | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| admin   | 403      | 403    | ✓      |
| hr      | 200      | 200    | ✓      |
| service | 401      | 401    | ✓      |

### `time/attendance-feed` — GET /api/v1/attendance (gateway → time-attendance)

Guard: requireHR

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| forged  | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| admin   | 403      | 403    | ✓      |
| hr      | 200      | 200    | ✓      |
| service | 401      | 401    | ✓      |

### `time/attendance-mine` — GET /api/v1/attendance/mine (gateway → time-attendance)

Guard: requireUser (hr/employee/manager; admin → 403)

| Persona   | Expected | Actual | Result |
| --------- | -------- | ------ | ------ |
| forged    | 401      | 401    | ✓      |
| anon      | 401      | 401    | ✓      |
| anon      | 401      | 401    | ✓      |
| admin     | 403      | 403    | ✓      |
| admin     | 403      | 403    | ✓      |
| hr        | 200      | 200    | ✓      |
| hr        | 200      | 200    | ✓      |
| manager   | 200      | 200    | ✓      |
| employee  | 200      | 200    | ✓      |
| candidate | 403      | 403    | ✓      |
| service   | 401      | 401    | ✓      |
| service   | 401      | 401    | ✓      |

### `time/correction-approve` — PUT /api/v1/attendance/corrections/1/approve (gateway → time-attendance)

Guard: requireReviewer (hr/manager)

| Persona   | Expected        | Actual | Result |
| --------- | --------------- | ------ | ------ |
| forged    | 401             | 401    | ✓      |
| anon      | 401             | 401    | ✓      |
| anon      | 401             | 401    | ✓      |
| admin     | 403             | 403    | ✓      |
| admin     | 403             | 403    | ✓      |
| hr        | 200/400/404/422 | 404    | ✓      |
| hr        | 200/400/404/422 | 404    | ✓      |
| manager   | 200/400/404/422 | 404    | ✓      |
| employee  | 403             | 403    | ✓      |
| candidate | 403             | 403    | ✓      |
| service   | 401             | 401    | ✓      |

### `time/leave-types` — GET /api/v1/leave/types (gateway → time-attendance)

Guard: requireUser

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| forged  | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| admin   | 403      | 403    | ✓      |
| hr      | 200      | 200    | ✓      |
| service | 401      | 401    | ✓      |

### `time/leave-requests` — GET /api/v1/leave/requests (gateway → time-attendance)

Guard: requireUser

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| forged  | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| admin   | 403      | 403    | ✓      |
| hr      | 200      | 200    | ✓      |
| service | 401      | 401    | ✓      |

### `time/schedules` — GET /api/v1/schedules (gateway → time-attendance)

Guard: requireHR

| Persona   | Expected | Actual | Result |
| --------- | -------- | ------ | ------ |
| forged    | 401      | 401    | ✓      |
| anon      | 401      | 401    | ✓      |
| anon      | 401      | 401    | ✓      |
| admin     | 403      | 403    | ✓      |
| admin     | 403      | 403    | ✓      |
| hr        | 200      | 200    | ✓      |
| hr        | 200      | 200    | ✓      |
| manager   | 403      | 403    | ✓      |
| employee  | 403      | 403    | ✓      |
| candidate | 403      | 403    | ✓      |
| service   | 401      | 401    | ✓      |

### `payroll/periods` — GET /api/v1/payroll/periods (gateway → payroll-adapter)

Guard: serviceOrUserAuth + requireHR

| Persona   | Expected | Actual | Result |
| --------- | -------- | ------ | ------ |
| forged    | 401      | 401    | ✓      |
| anon      | 401      | 401    | ✓      |
| anon      | 401      | 401    | ✓      |
| admin     | 403      | 403    | ✓      |
| admin     | 403      | 403    | ✓      |
| hr        | 200      | 200    | ✓      |
| hr        | 200      | 200    | ✓      |
| manager   | 403      | 403    | ✓      |
| employee  | 403      | 403    | ✓      |
| candidate | 403      | 403    | ✓      |
| service   | 401      | 401    | ✓      |
| service   | 200      | 200    | ✓      |

### `payroll/periods-create` — POST /api/v1/payroll/periods (gateway → payroll-adapter)

Guard: serviceOrUserAuth + requireHR

| Persona  | Expected        | Actual | Result |
| -------- | --------------- | ------ | ------ |
| forged   | 401             | 401    | ✓      |
| anon     | 401             | 401    | ✓      |
| anon     | 401             | 401    | ✓      |
| admin    | 403             | 403    | ✓      |
| admin    | 403             | 403    | ✓      |
| hr       | 200/201/400/422 | 400    | ✓      |
| hr       | 200/201/400/422 | 400    | ✓      |
| employee | 403             | 403    | ✓      |
| service  | 401             | 401    | ✓      |
| service  | 200/201/400/422 | 400    | ✓      |

### `payroll/fiscal` — GET /api/v1/payroll/fiscal/1 (gateway → payroll-adapter)

Guard: serviceOrUserAuth + requireHR (audit-logged)

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| forged  | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| admin   | 403      | 403    | ✓      |
| hr      | 200/404  | 404    | ✓      |
| service | 401      | 401    | ✓      |

### `payroll/providers` — GET /api/v1/payroll/providers (gateway → payroll-adapter)

Guard: serviceOrUserAuth + requireHR

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| forged  | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| admin   | 403      | 403    | ✓      |
| hr      | 200      | 200    | ✓      |
| service | 401      | 401    | ✓      |

### `hr-services/tickets` — GET /api/v1/tickets (gateway → hr-services)

Guard: serviceOrUserAuth + requireHR

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| forged   | 401      | 401    | ✓      |
| anon     | 401      | 401    | ✓      |
| anon     | 401      | 401    | ✓      |
| admin    | 403      | 403    | ✓      |
| admin    | 403      | 403    | ✓      |
| hr       | 200      | 200    | ✓      |
| hr       | 200      | 200    | ✓      |
| manager  | 403      | 403    | ✓      |
| employee | 403      | 403    | ✓      |
| service  | 401      | 401    | ✓      |
| service  | 200      | 200    | ✓      |

### `hr-services/tickets-my` — GET /api/v1/tickets/my (gateway → hr-services)

Guard: requireEmployee (admin → 403; needs linked employee)

| Persona   | Expected | Actual | Result                                                                                 |
| --------- | -------- | ------ | -------------------------------------------------------------------------------------- |
| forged    | 401      | 401    | ✓ — hr → 200 only when the user is linked in employee_directory (suite seeds the link) |
| anon      | 401      | 401    | ✓ — hr → 200 only when the user is linked in employee_directory (suite seeds the link) |
| anon      | 401      | 401    | ✓                                                                                      |
| admin     | 403      | 403    | ✓ — hr → 200 only when the user is linked in employee_directory (suite seeds the link) |
| admin     | 403      | 403    | ✓                                                                                      |
| hr        | 200/403  | 200    | ✓ — hr → 200 only when the user is linked in employee_directory (suite seeds the link) |
| hr        | 200/403  | 200    | ✓                                                                                      |
| manager   | 200/403  | 200    | ✓                                                                                      |
| employee  | 200/403  | 200    | ✓                                                                                      |
| candidate | 403      | 403    | ✓                                                                                      |
| service   | 401      | 401    | ✓ — hr → 200 only when the user is linked in employee_directory (suite seeds the link) |
| service   | 401      | 401    | ✓                                                                                      |

### `hr-services/expenses` — GET /api/v1/expenses (gateway → hr-services)

Guard: serviceOrUserAuth + requireHR

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| forged  | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| admin   | 403      | 403    | ✓      |
| hr      | 200      | 200    | ✓      |
| service | 401      | 401    | ✓      |

### `hr-services/expenses-my` — GET /api/v1/expenses/my (gateway → hr-services)

Guard: requireEmployee

| Persona | Expected | Actual | Result             |
| ------- | -------- | ------ | ------------------ |
| forged  | 401      | 401    | ✓ — see tickets-my |
| anon    | 401      | 401    | ✓ — see tickets-my |
| admin   | 403      | 403    | ✓ — see tickets-my |
| hr      | 200/403  | 200    | ✓ — see tickets-my |
| service | 401      | 401    | ✓ — see tickets-my |

### `hr-services/assets` — GET /api/v1/assets (gateway → hr-services)

Guard: serviceOrUserAuth + requireHR

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| forged  | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| admin   | 403      | 403    | ✓      |
| hr      | 200      | 200    | ✓      |
| service | 401      | 401    | ✓      |

### `hr-services/surveys-open` — GET /api/v1/surveys/open (gateway → hr-services)

Guard: requireEmployee

| Persona | Expected | Actual | Result             |
| ------- | -------- | ------ | ------------------ |
| forged  | 401      | 401    | ✓ — see tickets-my |
| anon    | 401      | 401    | ✓ — see tickets-my |
| admin   | 403      | 403    | ✓ — see tickets-my |
| hr      | 200/403  | 200    | ✓ — see tickets-my |
| service | 401      | 401    | ✓ — see tickets-my |

### `documents/get` — GET /api/v1/documents/00000000-0000-0000-0000-000000000000 (gateway → documents-resumes)

Guard: requireAuth + denyAdminContent + canAccessDocument

| Persona   | Expected    | Actual | Result |
| --------- | ----------- | ------ | ------ |
| forged    | 401         | 401    | ✓      |
| anon      | 401         | 401    | ✓      |
| anon      | 401         | 401    | ✓      |
| admin     | 403         | 403    | ✓      |
| admin     | 403         | 403    | ✓      |
| hr        | 200/400/404 | 404    | ✓      |
| hr        | 200/400/404 | 404    | ✓      |
| manager   | 403/404     | 404    | ✓      |
| employee  | 403/404     | 404    | ✓      |
| candidate | 403/404     | 404    | ✓      |
| service   | 401         | 401    | ✓      |
| service   | 200/400/404 | 404    | ✓      |

### `documents/upload` — POST /api/v1/documents (gateway → documents-resumes)

Guard: requireAuth + denyAdminContent

| Persona | Expected                | Actual | Result |
| ------- | ----------------------- | ------ | ------ |
| forged  | 401                     | 401    | ✓      |
| anon    | 401                     | 401    | ✓      |
| admin   | 403                     | 403    | ✓      |
| hr      | 200/201/400/413/415/422 | 400    | ✓      |
| service | 401                     | 401    | ✓      |

### `notifications/list` — GET /api/v1/notifications (gateway → notifications)

Guard: serviceOrAdminAuth

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| forged   | 401      | 401    | ✓      |
| anon     | 401      | 401    | ✓      |
| anon     | 401      | 401    | ✓      |
| admin    | 200      | 200    | ✓      |
| admin    | 200      | 200    | ✓      |
| hr       | 403      | 403    | ✓      |
| hr       | 403      | 403    | ✓      |
| employee | 403      | 403    | ✓      |
| service  | 401      | 401    | ✓      |
| service  | 200      | 200    | ✓      |

### `notifications/preferences` — GET /api/v1/notifications/preferences (gateway → notifications)

Guard: requireUser — any authenticated role incl. admin

| Persona  | Expected | Actual | Result                                                        |
| -------- | -------- | ------ | ------------------------------------------------------------- |
| forged   | 401      | 401    | ✓ — user-scoped prefs: admin is allowed (no business content) |
| anon     | 401      | 401    | ✓ — user-scoped prefs: admin is allowed (no business content) |
| anon     | 401      | 401    | ✓                                                             |
| admin    | 200      | 200    | ✓ — user-scoped prefs: admin is allowed (no business content) |
| admin    | 200      | 200    | ✓                                                             |
| hr       | 200      | 200    | ✓ — user-scoped prefs: admin is allowed (no business content) |
| hr       | 200      | 200    | ✓                                                             |
| employee | 200      | 200    | ✓                                                             |
| service  | 401      | 401    | ✓ — user-scoped prefs: admin is allowed (no business content) |
| service  | 401      | 401    | ✓                                                             |

### `notifications/send` — POST /api/v1/notifications/send (gateway → notifications)

Guard: serviceOrUserAuth — any authenticated user may queue a send

| Persona | Expected        | Actual | Result                                                                    |
| ------- | --------------- | ------ | ------------------------------------------------------------------------- |
| forged  | 401             | 401    | ✓ — no role gate on /send — authenticated users can trigger notifications |
| anon    | 401             | 401    | ✓ — no role gate on /send — authenticated users can trigger notifications |
| admin   | 200/202/400/422 | 400    | ✓ — no role gate on /send — authenticated users can trigger notifications |
| hr      | 200/202/400/422 | 400    | ✓ — no role gate on /send — authenticated users can trigger notifications |
| service | 401             | 401    | ✓ — no role gate on /send — authenticated users can trigger notifications |

### `identity/users-list` — GET /api/v1/users (gateway → identity-auth)

Guard: requireAdmin (RS256 verified upstream too)

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| forged  | 401      | 401    | ✓      |
| forged  | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| admin   | 200      | 200    | ✓      |
| hr      | 403      | 403    | ✓      |
| service | 401      | 401    | ✓      |
| service | 401      | 401    | ✓      |

### `monolith/admin-audit` — GET /api/admin/audit (gateway → api)

Guard: isAdmin (verifies RS256 itself — no header trust)

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| forged  | 401      | 401    | ✓      |
| forged  | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| anon    | 401      | 401    | ✓      |
| admin   | 200      | 200    | ✓      |
| hr      | 403      | 403    | ✓      |
| service | 401      | 401    | ✓      |
| service | 401      | 401    | ✓      |

### `recruitment/vacancies-list` — GET /api/v1/vacancies (gateway → recruitment-core)

Guard: PUBLIC allowlist (isPublicV1Path) → upstream listing

| Persona | Expected | Actual | Result                                                                 |
| ------- | -------- | ------ | ---------------------------------------------------------------------- |
| anon    | 200      | 200    | ✓ — 404 tolerated = VACANCIES_URL pointed at monolith (no /v1/* there) |
| anon    | 200      | 200    | ✓                                                                      |
| admin   | 200      | 200    | ✓ — 404 tolerated = VACANCIES_URL pointed at monolith (no /v1/* there) |
| admin   | 200      | 200    | ✓                                                                      |
| hr      | 200      | 200    | ✓ — 404 tolerated = VACANCIES_URL pointed at monolith (no /v1/* there) |
| hr      | 200      | 200    | ✓                                                                      |

### `recruitment/vacancy-detail` — GET /api/v1/vacancies/1 (gateway → recruitment-core)

Guard: JWT guard → upstream isHR

| Persona | Expected | Actual | Result                                |
| ------- | -------- | ------ | ------------------------------------- |
| anon    | 401      | 401    | ✓ — same VACANCIES_URL routing caveat |
| admin   | 403      | 403    | ✓ — same VACANCIES_URL routing caveat |
| hr      | 200/404  | 200    | ✓ — same VACANCIES_URL routing caveat |

### `recruitment/candidates` — GET /api/v1/candidates (gateway → recruitment-core)

Guard: JWT guard → upstream isHR (candidate PII)

| Persona | Expected | Actual | Result                                 |
| ------- | -------- | ------ | -------------------------------------- |
| anon    | 401      | 401    | ✓ — same CANDIDATES_URL routing caveat |
| admin   | 403      | 403    | ✓ — same CANDIDATES_URL routing caveat |
| hr      | 200      | 200    | ✓ — same CANDIDATES_URL routing caveat |

### `recruitment/public-apply` — POST /api/v1/public/apply (gateway → recruitment-core)

Guard: PUBLIC allowlist (POST only) — reachable anonymously

| Persona | Expected                | Actual | Result                                                         |
| ------- | ----------------------- | ------ | -------------------------------------------------------------- |
| anon    | 200/201/400/413/415/422 | 400    | ✓ — 400/415/422 prove reachability; 401/403/404 would be a gap |

### `internal/not-gateway-routed` — POST /api/v1/internal/users-projection (gateway → platform)

Guard: no public rule → JWT guard; X-Service-Token stripped

| Persona | Expected | Actual | Result                                                                            |
| ------- | -------- | ------ | --------------------------------------------------------------------------------- |
| forged  | 401      | 401    | ✓ — /v1/internal/* is compose-internal only — never reachable through the gateway |
| anon    | 401      | 401    | ✓ — /v1/internal/* is compose-internal only — never reachable through the gateway |
| admin   | 401/404  | 404    | ✓ — /v1/internal/* is compose-internal only — never reachable through the gateway |
| hr      | 401/404  | 404    | ✓ — /v1/internal/* is compose-internal only — never reachable through the gateway |
| service | 401      | 401    | ✓ — /v1/internal/* is compose-internal only — never reachable through the gateway |

### `hr-core/internal-users-projection` — POST /v1/internal/users-projection (direct → hr-core)

Guard: requireService (token-only)

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| anon     | 401      | 401    | ✓      |
| admin    | 401      | 401    | ✓      |
| hr       | 401      | 401    | ✓      |
| employee | 401      | 401    | ✓      |
| service  | 200/400  | 400    | ✓      |

### `time/leave-accrue` — POST /v1/leave/accrue (direct → time-attendance)

Guard: requireServiceToken

| Persona  | Expected        | Actual | Result |
| -------- | --------------- | ------ | ------ |
| anon     | 401             | 401    | ✓      |
| admin    | 403             | 403    | ✓      |
| hr       | 403             | 403    | ✓      |
| employee | 403             | 403    | ✓      |
| service  | 200/400/404/422 | 400    | ✓      |

### `time/internal-dsar-export` — POST /v1/internal/dsar-export (direct → time-attendance)

Guard: requireServiceToken (token-only)

| Persona  | Expected        | Actual | Result |
| -------- | --------------- | ------ | ------ |
| anon     | 401             | 401    | ✓      |
| admin    | 403             | 403    | ✓      |
| hr       | 403             | 403    | ✓      |
| employee | 403             | 403    | ✓      |
| service  | 200/400/404/422 | 400    | ✓      |

### `hr-services/internal-employee-directory` — POST /v1/internal/employee-directory (direct → hr-services)

Guard: requireService (token-only)

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| anon     | 401      | 401    | ✓      |
| admin    | 401      | 401    | ✓      |
| hr       | 401      | 401    | ✓      |
| employee | 401      | 401    | ✓      |
| service  | 200/400  | 400    | ✓      |

### `recruitment/vacancies-create` — POST /v1/vacancies (direct → recruitment-core)

Guard: serviceOrHrAuth

| Persona  | Expected        | Actual | Result |
| -------- | --------------- | ------ | ------ |
| anon     | 401             | 401    | ✓      |
| admin    | 403             | 403    | ✓      |
| hr       | 200/201/400/422 | 400    | ✓      |
| employee | 403             | 403    | ✓      |
| service  | 200/201/400/422 | 400    | ✓      |

### `recruitment/internal-users-projection` — POST /v1/internal/users-projection (direct → recruitment-core)

Guard: requireService (token-only)

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| anon    | 401      | 401    | ✓      |
| hr      | 401      | 401    | ✓      |
| service | 200/400  | 400    | ✓      |

### `ai/jobs` — GET /v1/jobs/e2e-probe (direct → ai-matching)

Guard: service_auth (token OR any user id)

| Persona  | Expected | Actual | Result                                                          |
| -------- | -------- | ------ | --------------------------------------------------------------- |
| anon     | 401      | 401    | ✓ — no role gate — any authenticated caller reaches the handler |
| admin    | 200/404  | 404    | ✓ — no role gate — any authenticated caller reaches the handler |
| hr       | 200/404  | 404    | ✓ — no role gate — any authenticated caller reaches the handler |
| employee | 200/404  | 404    | ✓ — no role gate — any authenticated caller reaches the handler |
| service  | 200/404  | 404    | ✓ — no role gate — any authenticated caller reaches the handler |

## personas

### `persona/anon-vacancies` — GET /api/v1/vacancies (gateway → recruitment-core)

Guard: public allowlist

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| anon    | 200      | 200    | ✓      |

### `persona/anon-apply` — POST /api/v1/public/apply (gateway → recruitment-core)

Guard: public allowlist (POST)

| Persona | Expected                | Actual | Result |
| ------- | ----------------------- | ------ | ------ |
| anon    | 200/201/400/413/415/422 | 400    | ✓      |

### `persona/anon-users` — GET /api/v1/users (gateway → identity-auth)

Guard: requireAdmin

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| anon    | 401      | 401    | ✓      |

### `persona/admin-audit` — GET /api/admin/audit (gateway → api)

Guard: isAdmin

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| admin   | 200      | 200    | ✓      |

### `persona/admin-hr-core` — GET /api/v1/employees (gateway → hr-core)

Guard: role guard

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| admin   | 403      | 403    | ✓      |

### `persona/admin-time-attendance` — GET /api/v1/attendance/mine (gateway → time-attendance)

Guard: role guard

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| admin   | 403      | 403    | ✓      |

### `persona/admin-payroll-adapter` — GET /api/v1/payroll/periods (gateway → payroll-adapter)

Guard: role guard

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| admin   | 403      | 403    | ✓      |

### `persona/admin-hr-services` — GET /api/v1/tickets (gateway → hr-services)

Guard: role guard

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| admin   | 403      | 403    | ✓      |
| admin   | 403      | 403    | ✓      |

### `persona/admin-documents-resumes` — GET /api/v1/documents/1 (gateway → documents-resumes)

Guard: role guard

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| admin   | 403      | 403    | ✓      |

### `persona/hr-api-adminonly` — GET /api/admin/audit (gateway → api)

Guard: admin-only

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| hr      | 403      | 403    | ✓      |

### `persona/hr-identity-auth-adminonly` — GET /api/v1/users (gateway → identity-auth)

Guard: admin-only

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| hr      | 403      | 403    | ✓      |

### `persona/hr-notifications-adminonly` — GET /api/v1/notifications (gateway → notifications)

Guard: admin-only

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| hr      | 403      | 403    | ✓      |

### `persona/employee-can-timeAttendance/v1/attendance/mine` — GET /v1/attendance/mine (direct → timeAttendance)

Guard: self-service

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 200      | 200    | ✓      |

### `persona/employee-can-timeAttendance/v1/leave/types` — GET /v1/leave/types (direct → timeAttendance)

Guard: self-service

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 200      | 200    | ✓      |

### `persona/employee-can-timeAttendance/v1/leave/requests` — GET /v1/leave/requests (direct → timeAttendance)

Guard: self-service

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 200      | 200    | ✓      |

### `persona/employee-can-timeAttendance/v1/leave/balances` — GET /v1/leave/balances (direct → timeAttendance)

Guard: self-service

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 200      | 200    | ✓      |

### `persona/employee-can-hrServices/v1/tickets/my` — GET /v1/tickets/my (direct → hrServices)

Guard: self-service

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 200      | 200    | ✓      |

### `persona/employee-can-hrServices/v1/expenses/my` — GET /v1/expenses/my (direct → hrServices)

Guard: self-service

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 200      | 200    | ✓      |

### `persona/employee-can-hrServices/v1/assets/my` — GET /v1/assets/my (direct → hrServices)

Guard: self-service

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 200      | 200    | ✓      |

### `persona/employee-can-hrServices/v1/surveys/open` — GET /v1/surveys/open (direct → hrServices)

Guard: self-service

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 200      | 200    | ✓      |

### `persona/employee-deny-payroll/v1/payroll/periods` — POST /v1/payroll/periods (direct → payroll)

Guard: hr/reviewer guard

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 403      | 403    | ✓      |
| employee | 403      | 403    | ✓      |

### `persona/employee-deny-payroll/v1/payroll/fiscal/1` — GET /v1/payroll/fiscal/1 (direct → payroll)

Guard: hr/reviewer guard

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 403      | 403    | ✓      |

### `persona/employee-deny-hrServices/v1/tickets` — GET /v1/tickets (direct → hrServices)

Guard: hr/reviewer guard

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 403      | 403    | ✓      |

### `persona/employee-deny-hrServices/v1/expenses` — GET /v1/expenses (direct → hrServices)

Guard: hr/reviewer guard

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 403      | 403    | ✓      |

### `persona/employee-deny-timeAttendance/v1/schedules` — GET /v1/schedules (direct → timeAttendance)

Guard: hr/reviewer guard

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 403      | 403    | ✓      |

### `persona/employee-deny-timeAttendance/v1/attendance/corrections/1/approve` — PUT /v1/attendance/corrections/1/approve (direct → timeAttendance)

Guard: hr/reviewer guard

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 403      | 403    | ✓      |

### `persona/employee-deny-hrCore/v1/employees` — GET /v1/employees (direct → hrCore)

Guard: hr/reviewer guard

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 403      | 403    | ✓      |

### `persona/employee-cross-scope` — GET /v1/tickets/my/9 (direct → hr-services)

Guard: requireEmployee + scoped query

| Persona  | Expected | Actual | Result |
| -------- | -------- | ------ | ------ |
| employee | 404      | 404    | ✓      |

### `persona/manager-reviewer` — PUT /v1/attendance/corrections/999999/approve (direct → time-attendance)

Guard: requireReviewer

| Persona | Expected        | Actual | Result |
| ------- | --------------- | ------ | ------ |
| manager | 200/400/404/422 | 404    | ✓      |

### `persona/service-internal` — POST /v1/internal/users-projection (direct → hr-core)

Guard: requireService

| Persona | Expected | Actual | Result |
| ------- | -------- | ------ | ------ |
| service | 200/400  | 400    | ✓      |

## Summary

- total checks: 297
- ok: 297 · tolerated: 0 · fail: 0 · error: 0
