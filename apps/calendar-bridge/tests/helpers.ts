// Shared test scaffolding: a stubbed pg Pool (no live DB — same pattern as
// apps/hr-services tests), in-memory calendar_events/integration_audit/
// outbox emulation, a recording event publisher and a silent logger.
import { vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { ServiceLogger } from '@strafor/node-common';
import type { EventPublisher } from '../src/events.js';
import { loadConfig, type ServiceConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createProvider, type CalendarProvider } from '../src/provider.js';
import type { Express } from 'express';

export const HR = { 'X-User-Id': '2', 'X-User-Role': 'hr' };
export const ADMIN = { 'X-User-Id': '1', 'X-User-Role': 'admin' };
export const SERVICE = { 'X-Service-Token': 'test-service-token' };
export const EMPLOYEE = { 'X-User-Id': '10', 'X-User-Role': 'employee' };

export const silentLog = new Proxy({} as never, {
    get: () => () => {}
}) as ServiceLogger;

type SqlResult = { rows?: Record<string, unknown>[]; rowCount?: number };
export type SqlHandler = (text: string, params: unknown[]) => SqlResult | undefined;

export interface StubPool {
    pool: Pool;
    calls: Array<{ text: string; params: unknown[] }>;
    audit: Array<{ actor: string; action: string; external_ref: string | null }>;
    events: Array<Record<string, unknown>>;
    queryTexts(): string[];
}

/**
 * Minimal Pool stand-in. `connect()` returns a client whose query delegates
 * to the same handler, so transactional paths (BEGIN/COMMIT/ROLLBACK) are
 * recorded in `calls` too.
 *
 * Emulated tables:
 *   - calendar_events: INSERT … RETURNING id assigns sequential ids and
 *     stores the row keyed by the INSERT param order used in
 *     routes/calendar.ts; SELECTs by external_ref and by id/provider_event_id
 *     are served from memory; cancel UPDATEs mutate status.
 *   - integration_audit: INSERTs are captured for assertions.
 *   - outbox_events: INSERTs are captured and served back to flushOutbox's
 *     pending SELECT so publish assertions work end-to-end.
 */
export function stubPool(handler?: SqlHandler): StubPool {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const audit: StubPool['audit'] = [];
    const events: Array<Record<string, unknown>> = [];
    const outboxRows: Array<Record<string, unknown>> = [];
    let nextEventId = 1;
    let nextOutboxId = 1;

    function result(rows: Record<string, unknown>[], rowCount?: number): QueryResult {
        return {
            rows,
            rowCount: rowCount ?? rows.length,
            command: '',
            oid: 0,
            fields: []
        } as unknown as QueryResult;
    }

    const query = vi.fn(async (text: string, params: unknown[] = []): Promise<QueryResult> => {
        calls.push({ text, params });

        // Readiness probe.
        if (text.trim() === 'SELECT 1') return result([{ '?column?': 1 }]);

        // calendar_events — idempotent external_ref lookup (scheduled only).
        if (text.includes('FROM calendar_events') && text.includes("status = 'scheduled'")) {
            return result(events.filter((e) => e.external_ref === params[0] && e.status === 'scheduled'));
        }
        // calendar_events — lookup by internal id OR provider event id.
        if (text.includes('FROM calendar_events') && text.includes('provider_event_id = $1')) {
            return result(
                events.filter((e) => String(e.id) === String(params[0]) || e.provider_event_id === params[0])
            );
        }
        // calendar_events — lookup by external_ref (any status).
        if (text.includes('FROM calendar_events') && text.includes('external_ref = $1')) {
            return result(events.filter((e) => e.external_ref === params[0]));
        }
        // calendar_events — insert (param order mirrors the route).
        if (text.includes('INSERT INTO calendar_events')) {
            const row = {
                id: nextEventId++,
                provider: params[0],
                provider_event_id: params[1],
                subject_hash: params[2],
                organizer_email: params[3],
                attendee_count: params[4],
                external_ref: params[5],
                start_at: params[6],
                end_at: params[7],
                online: params[8],
                join_url: params[9],
                status: 'scheduled'
            };
            events.push(row);
            return result([{ id: row.id }]);
        }
        if (text.includes('UPDATE calendar_events SET status')) {
            const row = events.find((e) => e.id === Number(params[0]));
            if (row) row.status = 'cancelled';
            return result([], row ? 1 : 0);
        }

        // integration_audit — captured for assertions.
        if (text.includes('INSERT INTO integration_audit')) {
            audit.push({
                actor: params[0] as string,
                action: params[1] as string,
                external_ref: (params[2] as string | null) ?? null
            });
            return result([{ id: audit.length }]);
        }

        // Outbox emulation.
        if (text.includes('INSERT INTO outbox_events')) {
            const row = {
                id: nextOutboxId++,
                type: params[0],
                payload: typeof params[1] === 'string' ? JSON.parse(params[1] as string) : params[1],
                correlation_id: params[2] ?? null
            };
            outboxRows.push(row);
            return result([{ id: row.id }]);
        }
        if (text.includes('FROM outbox_events') && text.includes('published_at IS NULL')) {
            return result([...outboxRows]);
        }
        if (text.includes('UPDATE outbox_events')) {
            return result([], outboxRows.length);
        }

        const out = handler ? await handler(text, params) : undefined;
        return result(out?.rows ?? [], out?.rowCount);
    });

    const client = {
        query: (t: string, p?: unknown[]) => query(t, p),
        release: vi.fn()
    } as unknown as PoolClient;
    const pool = {
        query,
        connect: vi.fn(async () => client),
        end: vi.fn(async () => {})
    } as unknown as Pool;
    return { pool, calls, audit, events, queryTexts: () => calls.map((c) => c.text) };
}

export interface RecordingPublisher extends EventPublisher {
    published: Array<{ type: string; payload: Record<string, unknown> }>;
}

export function recordingPublisher(): RecordingPublisher {
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    return {
        published,
        publish: vi.fn(async (_schema: unknown, type: string, payload: Record<string, unknown>) => {
            published.push({ type, payload });
            return true;
        }) as RecordingPublisher['publish'],
        close: vi.fn(async () => {})
    };
}

/** Default config is stub mode — pass M365_* overrides for real-mode tests. */
export function testConfig(overrides: Record<string, string> = {}): ServiceConfig {
    return loadConfig({
        DATABASE_URL: 'postgres://test:test@localhost:5432/strafor_integrations',
        SERVICE_AUTH_TOKEN: 'test-service-token',
        ...overrides
    });
}

export interface TestApp {
    app: Express;
    stub: StubPool;
    publisher: RecordingPublisher;
    provider: CalendarProvider;
}

export function testApp(
    opts: {
        handler?: SqlHandler;
        provider?: CalendarProvider;
        config?: ServiceConfig;
        log?: ServiceLogger;
    } = {}
): TestApp {
    const stub = stubPool(opts.handler);
    const publisher = recordingPublisher();
    const config = opts.config ?? testConfig();
    const log = opts.log ?? silentLog;
    const provider = opts.provider ?? createProvider(config, { log });
    const app = createApp({ pool: stub.pool, config, publisher, log, provider });
    return { app, stub, publisher, provider };
}
