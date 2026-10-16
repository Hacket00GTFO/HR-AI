// Employee endpoint tests — stubbed pool, no live database (same approach
// as apps/api/tests). Asserts the allowlist never leaks client keys into
// SQL, role gating (admin → 403), sensitive-field stripping, and events.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { ADMIN, HR, SERVICE, testApp } from './helpers.js';

const EMPLOYEE_ROW = {
    id: 7,
    user_id: 42,
    employee_number: 'EMP-007',
    first_name: 'Ana',
    last_name: 'Lopez',
    email: 'ana@strafor.local',
    phone: null,
    department: 'Engineering',
    department_id: null,
    position: 'Engineer',
    employment_type: 'full_time',
    hire_date: '2024-01-15',
    termination_date: null,
    status: 'active',
    salary: '85000.00',
    currency: 'MXN',
    location: 'CDMX',
    manager_id: null,
    rfc: 'LOLA900101ABC',
    curp: 'LOLA900101MDFPNS01',
    nss: '12345678901',
    legal_entity: 'Strafor MX',
    site: 'HQ',
    user_first_name: 'Ana',
    user_last_name: 'Lopez',
    created_at: '2024-01-15T00:00:00Z',
    updated_at: '2024-01-15T00:00:00Z'
};

const lastSql = (stub: { calls: Array<{ text: string; params: unknown[] }> }) => stub.calls.at(-1)!;

describe('GET /v1/employees — allowlisted filters', () => {
    it('?q= performs an ILIKE search on allowlisted columns, not a column lookup', async () => {
        const { app, stub } = testApp();
        const res = await request(app).get('/v1/employees?q=ana').set(HR);
        expect(res.status).toBe(200);
        const { text, params } = lastSql(stub);
        expect(text).toContain('ILIKE');
        expect(text).not.toMatch(/\be\.q\s*=/);
        expect(params).toEqual(['%ana%']);
    });

    it('ignores non-allowlisted filter keys (would-be injection)', async () => {
        const { app, stub } = testApp();
        const res = await request(app).get('/v1/employees?password_hash=x&role=admin;DROP&salary=1').set(HR);
        expect(res.status).toBe(200);
        const { text, params } = lastSql(stub);
        expect(text).not.toContain('password_hash');
        expect(text).not.toContain('role');
        expect(text).not.toContain('salary');
        expect(params).toEqual([]);
        expect(text).toContain('e.deleted_at IS NULL');
    });

    it('applies allowlisted equality filters', async () => {
        const { app, stub } = testApp();
        const res = await request(app).get('/v1/employees?status=active&site=HQ&legalEntity=Strafor MX').set(HR);
        expect(res.status).toBe(200);
        const { text, params } = lastSql(stub);
        expect(text).toContain('e.status = $1');
        expect(text).toContain('e.site = $2');
        expect(text).toContain('e.legal_entity = $3');
        expect(params).toEqual(['active', 'HQ', 'Strafor MX']);
    });
});

describe('auth & governance', () => {
    it('rejects missing credentials', async () => {
        const { app } = testApp();
        const res = await request(app).get('/v1/employees');
        expect(res.status).toBe(401);
    });

    it('admin gets 403 — platform admins never see employee records', async () => {
        const { app, stub } = testApp();
        const res = await request(app).get('/v1/employees').set(ADMIN);
        expect(res.status).toBe(403);
        expect(stub.calls).toHaveLength(0); // rejected before any SQL
    });

    it('service token is accepted for internal callers', async () => {
        const { app } = testApp(() => ({ rows: [] }));
        const res = await request(app).get('/v1/employees').set(SERVICE);
        expect(res.status).toBe(200);
    });

    it('sensitive fields (rfc/curp/nss/salary) are returned to hr but stripped for service callers', async () => {
        const { app } = testApp(() => ({ rows: [EMPLOYEE_ROW] }));
        const hrList = await request(app).get('/v1/employees').set(HR);
        expect(hrList.status).toBe(200);
        expect(hrList.body[0].rfc).toBe('LOLA900101ABC');
        expect(hrList.body[0].salary).toBe(85000);

        const svcList = await request(app).get('/v1/employees').set(SERVICE);
        expect(svcList.status).toBe(200);
        expect(svcList.body[0]).not.toHaveProperty('rfc');
        expect(svcList.body[0]).not.toHaveProperty('curp');
        expect(svcList.body[0]).not.toHaveProperty('nss');
        expect(svcList.body[0]).not.toHaveProperty('salary');
    });
});

describe('employee CRUD', () => {
    it('POST /v1/employees creates and publishes strafor.hr.employee_created', async () => {
        const { app, publisher, stub } = testApp((text) => {
            if (text.includes('INSERT INTO employees')) return { rows: [EMPLOYEE_ROW] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/employees').set(HR).send({
            employeeNumber: 'EMP-007',
            firstName: 'Ana',
            lastName: 'Lopez',
            email: 'ana@strafor.local',
            hireDate: '2024-01-15',
            userId: 42,
            rfc: 'LOLA900101ABC'
        });
        expect(res.status).toBe(201);
        expect(res.body.employeeNumber).toBe('EMP-007');
        expect(res.body.rfc).toBe('LOLA900101ABC'); // hr sees sensitive fields
        const insert = stub.calls.find((c) => c.text.includes('INSERT INTO employees'))!;
        expect(insert.text).toContain('employee_number');
        expect(insert.text).toContain('rfc');
        expect(insert.params).toContain('EMP-007');
        expect(publisher.published).toEqual([
            {
                type: 'strafor.hr.employee_created',
                payload: expect.objectContaining({ employeeId: 7, employeeNumber: 'EMP-007', userId: 42 })
            }
        ]);
    });

    it('POST rejects unknown keys (strict schema)', async () => {
        const { app, stub } = testApp();
        const res = await request(app).post('/v1/employees').set(HR).send({
            employeeNumber: 'E-1',
            firstName: 'A',
            lastName: 'B',
            email: 'a@b.co',
            hireDate: '2024-01-01',
            isAdmin: true // not in schema → rejected, never reaches SQL
        });
        expect(res.status).toBe(400);
        expect(stub.calls).toHaveLength(0);
    });

    it('GET /v1/employees/:id returns 404 when missing', async () => {
        const { app } = testApp();
        const res = await request(app).get('/v1/employees/999').set(HR);
        expect(res.status).toBe(404);
    });

    it('PUT /v1/employees/:id only updates whitelisted columns', async () => {
        const { app, stub, publisher } = testApp((text) => {
            if (text.includes('UPDATE employees')) return { rows: [{ ...EMPLOYEE_ROW, status: 'on_leave' }] };
            return { rows: [] };
        });
        const res = await request(app).put('/v1/employees/7').set(HR).send({ status: 'on_leave' });
        expect(res.status).toBe(200);
        const upd = stub.calls.find((c) => c.text.includes('UPDATE employees'))!;
        expect(upd.text).toContain('status = $2');
        expect(upd.text).toContain('WHERE id = $1 AND deleted_at IS NULL');
        expect(upd.params).toEqual([7, 'on_leave']);
        expect(res.body.status).toBe('on_leave');
        expect(publisher.published[0]?.type).toBe('strafor.hr.employee_updated');
        expect(publisher.published[0]?.payload.changedFields).toEqual(['status']);
    });

    it('DELETE /v1/employees/:id soft-deletes and publishes strafor.hr.employee_terminated', async () => {
        const { app, stub, publisher } = testApp((text) => {
            if (text.includes('UPDATE employees SET deleted_at')) {
                return { rows: [{ id: 7, employee_number: 'EMP-007', status: 'resigned' }] };
            }
            return { rows: [] };
        });
        const res = await request(app).delete('/v1/employees/7').set(HR);
        expect(res.status).toBe(204);
        expect(stub.calls[0]!.text).toContain('deleted_at = now()');
        expect(publisher.published).toEqual([
            {
                type: 'strafor.hr.employee_terminated',
                payload: expect.objectContaining({ employeeId: 7, status: 'resigned', reason: 'manual' })
            }
        ]);
    });
});

describe('employee document links', () => {
    it('POST /v1/employees/:id/documents links a documents-resumes UUID', async () => {
        const docId = '9c8b7a6d-1234-4abc-9def-0123456789ab';
        const { app } = testApp((text) => {
            if (text.includes('INSERT INTO employee_documents')) {
                return {
                    rows: [
                        {
                            id: 3,
                            document_id: docId,
                            kind: 'contract',
                            uploaded_by: 2,
                            created_at: '2024-01-15T00:00:00Z'
                        }
                    ]
                };
            }
            return { rows: [] };
        });
        const res = await request(app)
            .post('/v1/employees/7/documents')
            .set(HR)
            .send({ documentId: docId, kind: 'contract' });
        expect(res.status).toBe(201);
        expect(res.body.documentId).toBe(docId);
    });
});
