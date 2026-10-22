// /v1/internal/users-projection — service-token-only maintenance API used to
// keep users_projection (display names) fresh. Mirrors hr-core.
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, makeDeps, makeFakeDb, SVC_HEADERS, HR_HEADERS } from './helpers.js';

describe('POST /v1/internal/users-projection', () => {
    let db: ReturnType<typeof makeFakeDb>;
    let app: ReturnType<typeof makeApp>;

    beforeEach(() => {
        db = makeFakeDb();
        app = makeApp(makeDeps({ pool: db.pool }));
    });

    it('rejects missing service token (401)', async () => {
        const res = await request(app)
            .post('/v1/internal/users-projection')
            .send({ users: [{ id: 1 }] });
        expect(res.status).toBe(401);
    });

    it('rejects user identity headers — services only (401)', async () => {
        const res = await request(app)
            .post('/v1/internal/users-projection')
            .set(HR_HEADERS)
            .send({ users: [{ id: 1 }] });
        expect(res.status).toBe(401);
    });

    it('upserts projection rows for a valid service caller', async () => {
        const res = await request(app)
            .post('/v1/internal/users-projection')
            .set(SVC_HEADERS)
            .send({
                users: [
                    { id: 7, firstName: 'Ana', lastName: 'Garcia', email: 'ana@x.com' },
                    { id: 8, firstName: 'Bob' }
                ]
            });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ upserted: 2 });
        const inserts = db.client.calls.filter((c) => c.sql.toLowerCase().includes('insert into users_projection'));
        expect(inserts).toHaveLength(2);
        expect(inserts[0]?.params).toEqual([7, 'Ana', 'Garcia', 'ana@x.com']);
        expect(inserts[1]?.params).toEqual([8, 'Bob', null, null]);
    });

    it('validates the payload shape (400)', async () => {
        for (const body of [
            {},
            { users: [] },
            { users: [{ id: 'x' }] },
            { users: [{ id: 1, email: 'not-an-email' }] },
            { users: [{ id: 1 }], extra: true }
        ]) {
            const res = await request(app).post('/v1/internal/users-projection').set(SVC_HEADERS).send(body);
            expect(res.status).toBe(400);
        }
    });
});

describe('DELETE /v1/internal/users-projection/:id', () => {
    it('204 on delete, 404 when the row is absent, 401 without token', async () => {
        const present = makeFakeDb([['delete from users_projection', []]]);
        // Fake returns rowCount from rows.length — patch delete to report 1.
        present.client.query.mockImplementation(async (sql: string) => {
            if (sql.toLowerCase().includes('delete from users_projection')) {
                return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });
        const app = makeApp(makeDeps({ pool: present.pool }));

        const res = await request(app).delete('/v1/internal/users-projection/7').set(SVC_HEADERS);
        expect(res.status).toBe(204);

        const missing = makeFakeDb();
        const app2 = makeApp(makeDeps({ pool: missing.pool }));
        const res404 = await request(app2).delete('/v1/internal/users-projection/7').set(SVC_HEADERS);
        expect(res404.status).toBe(404);

        const res401 = await request(app2).delete('/v1/internal/users-projection/7');
        expect(res401.status).toBe(401);
    });
});
