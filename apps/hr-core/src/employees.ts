import { z } from 'zod';
import { withId } from './db.js';

/**
 * Employee domain: zod schemas, the filter allowlist ported from the
 * monolith's hardened HR model, and row serializers.
 *
 * SECURITY: filter keys and column names NEVER come from the client. Query
 * params are matched against FILTER_ALLOWLIST; the SQL column is taken from
 * the constant EMPLOYEE_COLUMNS map, so an unknown key can never become SQL.
 */

/** Mark a schema field as sensitive (returned only to the hr role). */
const sensitive = <T extends z.ZodTypeAny>(schema: T) => schema.meta({ sensitive: true });

export const EMPLOYEE_STATUSES = ['pending', 'active', 'on_leave', 'terminated', 'resigned'] as const;
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern', 'temporary'] as const;

// Field shapes WITHOUT defaults — shared by create (which applies defaults)
// and update (which must not inject defaults for absent keys).
const employeeFields = {
    userId: z.number().int().positive().nullable().optional(),
    employeeNumber: z.string().min(1).max(50),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    email: z.email().max(255),
    phone: z.string().max(50).optional(),
    department: z.string().max(100).optional(),
    departmentId: z.number().int().positive().nullable().optional(),
    position: z.string().max(200).optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    hireDate: z.iso.date(),
    terminationDate: z.iso.date().optional(),
    status: z.enum(EMPLOYEE_STATUSES).optional(),
    salary: sensitive(z.number().nonnegative().optional()),
    currency: z.string().length(3).optional(),
    location: z.string().max(200).optional(),
    managerId: z.number().int().positive().nullable().optional(),
    // Mexico-first legal fields — sensitive.
    rfc: sensitive(z.string().max(13).optional()),
    curp: sensitive(z.string().max(18).optional()),
    nss: sensitive(z.string().max(11).optional()),
    legalEntity: z.string().max(200).optional(),
    site: z.string().max(100).optional()
};

export const createEmployeeSchema = z
    .object({
        ...employeeFields,
        employmentType: z.enum(EMPLOYMENT_TYPES).default('full_time'),
        status: z.enum(EMPLOYEE_STATUSES).default('active'),
        currency: z.string().length(3).default('MXN')
    })
    .strict();

// Partial update — absent keys are simply not written (no defaults applied).
export const updateEmployeeSchema = z.object(employeeFields).partial().strict();

/** camelCase API key → snake_case column (constant — never client input). */
export const EMPLOYEE_COLUMNS: Record<string, string> = {
    userId: 'user_id',
    employeeNumber: 'employee_number',
    firstName: 'first_name',
    lastName: 'last_name',
    email: 'email',
    phone: 'phone',
    department: 'department',
    departmentId: 'department_id',
    position: 'position',
    employmentType: 'employment_type',
    hireDate: 'hire_date',
    terminationDate: 'termination_date',
    status: 'status',
    salary: 'salary',
    currency: 'currency',
    location: 'location',
    managerId: 'manager_id',
    rfc: 'rfc',
    curp: 'curp',
    nss: 'nss',
    legalEntity: 'legal_entity',
    site: 'site'
};

/** Query keys usable as ?key=value equality filters (monolith parity). */
export const FILTER_ALLOWLIST = new Set([
    'status',
    'department',
    'departmentId',
    'position',
    'employmentType',
    'location',
    'managerId',
    'legalEntity',
    'site',
    'userId'
]);

/** Columns matched by the ?q= ILIKE search — name/email/employee_number. */
export const SEARCH_COLUMNS = ['employee_number', 'first_name', 'last_name', 'email'];

/** Sensitive fields stripped from responses for non-hr callers. */
export const SENSITIVE_FIELDS = ['rfc', 'curp', 'nss', 'salary'] as const;

export interface EmployeeFilter {
    where: string[];
    params: unknown[];
}

/**
 * Build WHERE clauses from req.query. Exact port of the monolith's allowlist
 * approach: unknown keys are skipped, `q` runs ILIKE over SEARCH_COLUMNS.
 */
export function buildEmployeeFilters(filters: Record<string, unknown>): EmployeeFilter {
    const where = ['e.deleted_at IS NULL'];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(filters)) {
        if (value == null || value === '' || Array.isArray(value)) continue;
        if (key === 'q') {
            params.push(`%${String(value)}%`);
            const p = `$${params.length}`;
            where.push(`(${SEARCH_COLUMNS.map((c) => `e.${c}::text ILIKE ${p}`).join(' OR ')})`);
            continue;
        }
        if (!FILTER_ALLOWLIST.has(key)) continue;
        const column = EMPLOYEE_COLUMNS[key];
        if (!column) continue;
        params.push(value);
        where.push(`e.${column} = $${params.length}`);
    }
    return { where, params };
}

const toDateStr = (v: unknown): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
};

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** Shape a DB row for the API. Sensitive fields are emitted only when
 *  `includeSensitive` (currently: caller role === 'hr'). */
export function rowToEmployee(row: Record<string, unknown>, includeSensitive: boolean) {
    const base: Record<string, unknown> = {
        id: Number(row.id),
        userId: num(row.user_id),
        employeeNumber: row.employee_number,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        phone: row.phone ?? null,
        department: row.department ?? null,
        departmentId: num(row.department_id),
        position: row.position ?? null,
        employmentType: row.employment_type,
        hireDate: toDateStr(row.hire_date),
        terminationDate: toDateStr(row.termination_date),
        status: row.status,
        currency: row.currency,
        location: row.location ?? null,
        managerId: num(row.manager_id),
        legalEntity: row.legal_entity ?? null,
        site: row.site ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
    // users_projection join (optional — present when the SELECT included it)
    if ('user_first_name' in row || 'user_last_name' in row) {
        base.user =
            row.user_id != null
                ? {
                      id: Number(row.user_id),
                      firstName: row.user_first_name ?? null,
                      lastName: row.user_last_name ?? null
                  }
                : null;
    }
    if (includeSensitive) {
        base.salary = num(row.salary);
        base.rfc = row.rfc ?? null;
        base.curp = row.curp ?? null;
        base.nss = row.nss ?? null;
    }
    return withId(base as { id: unknown }) as Record<string, unknown>;
}

/** Map a validated body to column/value pairs using the constant map only. */
export function bodyToColumns(body: Record<string, unknown>): { columns: string[]; values: unknown[] } {
    const columns: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(EMPLOYEE_COLUMNS)) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
            columns.push(column);
            values.push(body[key]);
        }
    }
    return { columns, values };
}
