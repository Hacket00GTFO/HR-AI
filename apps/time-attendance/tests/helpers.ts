// In-memory fake pool — interprets the SQL emitted by the routers so tests
// run with zero infra (same stub style as apps/api/tests).
import type { Pool, PoolClient } from 'pg';
import type { Express } from 'express';
import type { ServiceLogger } from '@strafor/node-common';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { EventPublisher } from '../src/events.js';

export interface FakeState {
    workSchedules: any[];
    employeeSchedules: any[];
    attendanceEvents: any[];
    corrections: any[];
    leaveTypes: any[];
    leaveRequests: any[];
    leaveBalances: any[];
    seq: number;
}

function seedLeaveTypes(): any[] {
    return [
        {
            id: 1,
            code: 'vacaciones',
            name: 'Vacaciones (LFT art. 76)',
            paid: true,
            requires_approval: true,
            accrual: {
                jurisdiction: 'MX',
                statute: 'LFT-76',
                unit: 'days',
                table: [
                    { minYears: 1, maxYears: 1, days: 12 },
                    { minYears: 2, maxYears: 2, days: 14 },
                    { minYears: 3, maxYears: 3, days: 16 },
                    { minYears: 4, maxYears: 4, days: 18 },
                    { minYears: 5, maxYears: 5, days: 20 },
                    { minYears: 6, maxYears: 10, days: 22 },
                    { minYears: 11, maxYears: 15, days: 24 },
                    { minYears: 16, maxYears: 20, days: 26 },
                    { minYears: 21, maxYears: 25, days: 28 },
                    { minYears: 26, maxYears: 30, days: 30 },
                    { minYears: 31, maxYears: 35, days: 32 }
                ]
            }
        },
        { id: 2, code: 'incapacidad', name: 'Incapacidad', paid: true, requires_approval: false, accrual: {} },
        { id: 3, code: 'permiso', name: 'Permiso', paid: false, requires_approval: true, accrual: {} },
        { id: 4, code: 'maternidad', name: 'Maternidad', paid: true, requires_approval: false, accrual: {} },
        { id: 5, code: 'paternidad', name: 'Paternidad', paid: true, requires_approval: false, accrual: {} }
    ];
}

export function makeFakeDb() {
    const state: FakeState = {
        workSchedules: [],
        employeeSchedules: [],
        attendanceEvents: [],
        corrections: [],
        leaveTypes: seedLeaveTypes(),
        leaveRequests: [],
        leaveBalances: [],
        seq: 1
    };
    const nextId = () => state.seq++;
    const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
    const uniqueViolation = (): never => {
        const e = new Error('duplicate key value violates unique constraint') as any;
        e.code = '23505';
        throw e;
    };

    async function query(text: string, params: any[] = []): Promise<any> {
        const t = norm(text);

        if (t === 'SELECT 1' || t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') {
            return rows([]);
        }

        // ---------- attendance_events ----------
        if (t.startsWith('INSERT INTO attendance_events')) {
            const [employee_id, kind, occurredAt, geo_lat, geo_lng, geo_accuracy_m, geo_consent, created_by] = params;
            if (geo_lat != null && geo_consent !== true) {
                const e = new Error('check constraint violation: geo requires consent') as any;
                e.code = '23514';
                throw e;
            }
            const row = {
                id: nextId(),
                employee_id,
                kind,
                occurred_at: occurredAt ? new Date(occurredAt) : new Date(),
                geo_lat: geo_lat ?? null,
                geo_lng: geo_lng ?? null,
                geo_accuracy_m: geo_accuracy_m ?? null,
                geo_consent: geo_consent === true,
                source: 'pwa',
                created_by,
                created_at: new Date()
            };
            state.attendanceEvents.push(row);
            return rows([row]);
        }
        if (t.startsWith('UPDATE attendance_events')) {
            const id = Number(params[0]);
            const ev = state.attendanceEvents.find((e) => e.id === id);
            if (!ev) return rows([]);
            ev.source = 'correction';
            if (t.includes('SET occurred_at = $2')) ev.occurred_at = new Date(params[1]);
            else if (t.includes('SET kind = $2')) ev.kind = params[1];
            else if (t.includes('geo_lat = NULL')) {
                ev.geo_lat = ev.geo_lng = ev.geo_accuracy_m = null;
                ev.geo_consent = false;
            } else if (t.includes('geo_lat = $2')) {
                ev.geo_lat = params[1];
                ev.geo_lng = params[2];
                ev.geo_accuracy_m = params[3];
                ev.geo_consent = true;
            }
            return rows([ev]);
        }
        if (t.includes('FROM attendance_events')) {
            // open check-in probe
            if (t.includes('NOT EXISTS')) {
                const emp = params[0];
                const open = state.attendanceEvents
                    .filter((e) => e.employee_id === emp && e.kind === 'check_in')
                    .filter(
                        (ci) =>
                            !state.attendanceEvents.some(
                                (o) =>
                                    o.employee_id === emp &&
                                    o.kind === 'check_out' &&
                                    new Date(o.occurred_at).getTime() > new Date(ci.occurred_at).getTime()
                            )
                    )
                    .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
                return rows(open.slice(0, 1).map((e) => ({ id: e.id })));
            }
            if (t.includes('WHERE id = $1')) {
                return rows(state.attendanceEvents.filter((e) => e.id === Number(params[0])));
            }
            // list: params [employeeId|null, from|null, to|null, limit]
            const [emp, from, to, limit] = params;
            let list = state.attendanceEvents.slice();
            if (emp != null) list = list.filter((e) => e.employee_id === emp);
            if (from != null) list = list.filter((e) => new Date(e.occurred_at) >= new Date(from));
            if (to != null) list = list.filter((e) => new Date(e.occurred_at) <= new Date(to));
            list.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
            return rows(list.slice(0, limit ?? 500));
        }

        // ---------- attendance_corrections ----------
        if (t.startsWith('INSERT INTO attendance_corrections')) {
            const [event_id, employee_id, requested_by, field, old_value, new_value, reason] = params;
            const row = {
                id: nextId(),
                event_id,
                employee_id,
                requested_by,
                field,
                old_value: typeof old_value === 'string' ? JSON.parse(old_value) : old_value,
                new_value: typeof new_value === 'string' ? JSON.parse(new_value) : new_value,
                reason,
                status: 'pending',
                reviewed_by: null,
                reviewed_at: null,
                created_at: new Date()
            };
            state.corrections.push(row);
            return rows([row]);
        }
        if (t.startsWith('UPDATE attendance_corrections')) {
            const [id, status, reviewed_by] = params;
            const c = state.corrections.find((x) => x.id === Number(id));
            if (!c) return rows([]);
            c.status = status;
            c.reviewed_by = reviewed_by;
            c.reviewed_at = new Date();
            return rows([c]);
        }
        if (t.includes('FROM attendance_corrections')) {
            if (t.includes('FOR UPDATE') || t.includes('WHERE id = $1')) {
                return rows(state.corrections.filter((c) => c.id === Number(params[0])));
            }
            const [status, emp] = params;
            let list = state.corrections.slice();
            if (status != null) list = list.filter((c) => c.status === status);
            if (emp != null) list = list.filter((c) => c.employee_id === emp);
            list.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
            return rows(list.slice(0, 500));
        }

        // ---------- leave_types ----------
        if (t.includes('FROM leave_types')) {
            if (t.includes("code = 'vacaciones'")) {
                return rows(state.leaveTypes.filter((x) => x.code === 'vacaciones'));
            }
            if (t.includes('WHERE id = $1')) {
                return rows(state.leaveTypes.filter((x) => x.id === Number(params[0])));
            }
            if (t.includes('WHERE code = $1')) {
                return rows(state.leaveTypes.filter((x) => x.code === params[0]));
            }
            return rows(state.leaveTypes.slice());
        }

        // ---------- leave_requests ----------
        if (t.startsWith('INSERT INTO leave_requests')) {
            const [employee_id, leave_type_id, start_date, end_date, days, status, reason] = params;
            const row = {
                id: nextId(),
                employee_id,
                leave_type_id,
                start_date,
                end_date,
                days,
                status,
                approver_id: null,
                reason,
                decided_at: status === 'approved' ? new Date() : null,
                created_at: new Date()
            };
            state.leaveRequests.push(row);
            return rows([row]);
        }
        if (t.startsWith('UPDATE leave_requests')) {
            const row = state.leaveRequests.find((r) => r.id === Number(params[0]));
            if (!row) return rows([]);
            if (t.includes("status = 'cancelled'")) {
                row.status = 'cancelled';
                row.decided_at = new Date();
            } else {
                row.status = params[1];
                row.approver_id = params[2];
                row.decided_at = new Date();
            }
            return rows([row]);
        }
        if (t.includes('FROM leave_requests')) {
            if (t.includes('WHERE id = $1')) {
                return rows(state.leaveRequests.filter((r) => r.id === Number(params[0])));
            }
            const [emp, status] = params;
            let list = state.leaveRequests.slice();
            if (emp != null) list = list.filter((r) => r.employee_id === emp);
            if (status != null) list = list.filter((r) => r.status === status);
            list.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
            return rows(list.slice(0, 500));
        }

        // ---------- leave_balances ----------
        if (t.startsWith('INSERT INTO leave_balances')) {
            const [employee_id, leave_type_id, year, entitled] = params;
            let row = state.leaveBalances.find(
                (b) => b.employee_id === employee_id && b.leave_type_id === leave_type_id && b.year === year
            );
            if (row) {
                row.entitled = entitled;
                row.updated_at = new Date();
            } else {
                row = {
                    id: nextId(),
                    employee_id,
                    leave_type_id,
                    year,
                    entitled,
                    used: 0,
                    carried: 0,
                    updated_at: new Date()
                };
                state.leaveBalances.push(row);
            }
            return rows([row]);
        }
        if (t.startsWith('UPDATE leave_balances')) {
            const [employee_id, leave_type_id, year, delta] = params;
            const row = state.leaveBalances.find(
                (b) => b.employee_id === employee_id && b.leave_type_id === leave_type_id && b.year === year
            );
            if (!row) return rows([]);
            row.used = Number(row.used) + Number(delta);
            row.updated_at = new Date();
            return rows([row]);
        }
        if (t.includes('FROM leave_balances')) {
            if (t.includes('FOR UPDATE')) {
                const [employee_id, leave_type_id, year] = params;
                return rows(
                    state.leaveBalances.filter(
                        (b) => b.employee_id === employee_id && b.leave_type_id === leave_type_id && b.year === year
                    )
                );
            }
            const [emp, year] = params;
            let list = state.leaveBalances.slice();
            if (emp != null) list = list.filter((b) => b.employee_id === emp);
            if (year != null) list = list.filter((b) => b.year === year);
            return rows(list);
        }

        // ---------- work_schedules ----------
        if (t.startsWith('INSERT INTO work_schedules')) {
            const [name, type, weekly_hours, config] = params;
            const row = {
                id: nextId(),
                name,
                type,
                weekly_hours,
                config: typeof config === 'string' ? JSON.parse(config) : config,
                active: true,
                created_at: new Date(),
                updated_at: new Date()
            };
            state.workSchedules.push(row);
            return rows([row]);
        }
        if (t.startsWith('UPDATE work_schedules')) {
            const row = state.workSchedules.find((s) => s.id === Number(params[0]));
            if (!row) return rows([]);
            if (t.includes('active = false')) {
                row.active = false;
            } else {
                const [, name, type, weekly_hours, config, active] = params;
                if (name != null) row.name = name;
                if (type != null) row.type = type;
                if (weekly_hours != null) row.weekly_hours = weekly_hours;
                if (config != null) row.config = typeof config === 'string' ? JSON.parse(config) : config;
                if (active != null) row.active = active;
            }
            row.updated_at = new Date();
            return rows([row]);
        }
        if (t.includes('FROM work_schedules')) {
            if (t.includes('WHERE id = $1')) {
                return rows(state.workSchedules.filter((s) => s.id === Number(params[0])));
            }
            const [active] = params;
            let list = state.workSchedules.slice();
            if (active != null) list = list.filter((s) => s.active === active);
            return rows(list);
        }

        // ---------- employee_schedules ----------
        if (t.startsWith('INSERT INTO employee_schedules')) {
            const [employee_id, schedule_id, effective_from, effective_to] = params;
            if (
                effective_to == null &&
                state.employeeSchedules.some((a) => a.employee_id === employee_id && a.effective_to == null)
            ) {
                uniqueViolation();
            }
            const row = {
                id: nextId(),
                employee_id,
                schedule_id,
                effective_from,
                effective_to: effective_to ?? null,
                created_at: new Date()
            };
            state.employeeSchedules.push(row);
            return rows([row]);
        }
        if (t.startsWith('UPDATE employee_schedules')) {
            const [employee_id, schedule_id, effectiveTo] = params;
            const row = state.employeeSchedules.find(
                (a) => a.employee_id === employee_id && a.schedule_id === schedule_id && a.effective_to == null
            );
            if (!row) return rows([]);
            row.effective_to = effectiveTo ?? new Date().toISOString().slice(0, 10);
            return rows([row]);
        }
        if (t.includes('FROM employee_schedules')) {
            if (t.includes('WHERE schedule_id = $1')) {
                return rows(state.employeeSchedules.filter((a) => a.schedule_id === Number(params[0])));
            }
            return rows(state.employeeSchedules.slice());
        }

        throw new Error(`fake-pool: unmatched SQL: ${t}`);
    }

    const client = { query, release: () => {} } as unknown as PoolClient;
    const pool = {
        query,
        connect: async () => client,
        end: async () => {}
    } as unknown as Pool;

    return { pool, state };
}

export const silentLog = new Proxy({} as never, { get: () => () => {} }) as ServiceLogger;

export function makeConfig(overrides: Record<string, string> = {}) {
    return loadConfig({
        DATABASE_URL: 'postgres://test:test@localhost:5432/test',
        SERVICE_AUTH_TOKEN: 'test-service-token',
        ...overrides
    });
}

export function makePublisher() {
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const publisher: EventPublisher = {
        publish: async (_schema, type, payload) => {
            published.push({ type, payload });
            return true;
        },
        close: async () => {}
    };
    return { publisher, published };
}

export function makeTestApp() {
    const { pool, state } = makeFakeDb();
    const config = makeConfig();
    const { publisher, published } = makePublisher();
    const app: Express = createApp({ pool, config, publisher, log: silentLog });
    return { app, state, published, config };
}

/** Gateway identity headers. employeeId defaults to userId (auth.ts fallback). */
export function asUser(userId: number, role = 'employee', employeeId?: number) {
    const h: Record<string, string> = {
        'X-User-Id': String(userId),
        'X-User-Role': role
    };
    if (employeeId !== undefined) h['X-Employee-Id'] = String(employeeId);
    return h;
}
