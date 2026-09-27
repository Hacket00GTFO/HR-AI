import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLogger } = require('../logger');
const { correlationId, CORRELATION_HEADER } = require('../correlationId');
const { httpError, errorHandler } = require('../errors');
const { requireEnv } = require('../config');
const { z } = require('zod');

function captureStream() {
    const lines = [];
    const stream = new Writable({
        write(chunk, _enc, cb) {
            lines.push(chunk.toString());
            cb();
        }
    });
    return { stream, lines };
}

function mockReqRes(headers = {}) {
    const req = {
        headers,
        get(name) { return this.headers[name.toLowerCase()]; }
    };
    const res = {
        headers: {},
        statusCode: 200,
        body: null,
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
    return { req, res };
}

describe('createLogger', () => {
    it('emits JSON with level, service and timestamp', () => {
        const { stream, lines } = captureStream();
        const log = createLogger({ level: 'info' }, stream);
        log.info('hello');
        const entry = JSON.parse(lines[0]);
        expect(entry.level).toBe('info');
        expect(entry.msg).toBe('hello');
        expect(entry.service).toBeDefined();
        expect(entry.time).toBeDefined();
    });

    it('masks sensitive keys instead of dropping them', () => {
        const { stream, lines } = captureStream();
        const log = createLogger({ level: 'info' }, stream);
        log.info({ password: 'hunter2', email: 'a@b.com', safe: 'ok' }, 'redact me');
        const entry = JSON.parse(lines[0]);
        expect(entry.password).toBe('[REDACTED]');
        expect(entry.email).toBe('[REDACTED]');
        expect(entry.safe).toBe('ok');
    });
});

describe('correlationId middleware', () => {
    it('generates a UUID when no inbound header is present', () => {
        const { req, res } = mockReqRes();
        let called = false;
        correlationId(req, res, () => { called = true; });
        expect(called).toBe(true);
        expect(req.correlationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.headers['x-correlation-id']).toBe(req.correlationId);
        expect(req.log).toBeDefined();
    });

    it('honors a valid inbound X-Correlation-Id', () => {
        const { req, res } = mockReqRes({ [CORRELATION_HEADER]: 'trace-abc-123' });
        correlationId(req, res, () => {});
        expect(req.correlationId).toBe('trace-abc-123');
        expect(res.headers['x-correlation-id']).toBe('trace-abc-123');
    });

    it('strips control characters from inbound ids', () => {
        const { req } = mockReqRes({ [CORRELATION_HEADER]: 'bad\nid\u001b[31m' });
        correlationId(req, { setHeader() {} }, () => {});
        expect(req.correlationId).toBe('badid[31m');
    });

    it('falls back to a UUID for empty or oversize inbound ids', () => {
        const { req: r1 } = mockReqRes({ [CORRELATION_HEADER]: '\n\u0007  ' });
        correlationId(r1, { setHeader() {} }, () => {});
        expect(r1.correlationId).toMatch(/^[0-9a-f-]{36}$/);

        const { req: r2 } = mockReqRes({ [CORRELATION_HEADER]: 'x'.repeat(200) });
        correlationId(r2, { setHeader() {} }, () => {});
        expect(r2.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe('error helpers', () => {
    it('httpError carries status and details', () => {
        const err = httpError(422, 'Invalid input', { field: 'email' });
        expect(err.status).toBe(422);
        expect(err.details).toEqual({ field: 'email' });
    });

    it('errorHandler emits { error, details } honoring err.status', () => {
        const { req, res } = mockReqRes();
        errorHandler(httpError(400, 'Bad body', { issues: 2 }), req, res, () => {});
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: 'Bad body', details: { issues: 2 } });
    });

    it('errorHandler maps unknown errors to 500', () => {
        const { req, res } = mockReqRes();
        errorHandler(new Error('boom'), req, res, () => {});
        expect(res.statusCode).toBe(500);
        expect(res.body.error).toBeDefined();
        expect(res.body.details).toBeUndefined();
    });
});

describe('requireEnv', () => {
    it('returns parsed env when all required vars are present', () => {
        const env = requireEnv({ DATABASE_URL: z.string().min(1), PORT: z.coerce.number() }, {
            DATABASE_URL: 'postgres://x', PORT: '3000'
        });
        expect(env.DATABASE_URL).toBe('postgres://x');
        expect(env.PORT).toBe(3000);
    });

    it('throws listing every missing variable', () => {
        expect(() => requireEnv({ A: z.string(), B: z.string() }, {}))
            .toThrow(/A[\s\S]*B/);
    });
});
