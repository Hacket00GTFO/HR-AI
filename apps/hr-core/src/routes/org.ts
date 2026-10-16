import { Router } from 'express';
import type { Pool } from 'pg';
import type { ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import type { EventPublisher } from '../events.js';
import { requireHR, serviceOrUserAuth } from '../auth.js';
import { buildTree } from './departments.js';

export interface OrgDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

export function orgRouter(deps: OrgDeps): Router {
    const { pool, config } = deps;
    const router = Router();

    router.use(serviceOrUserAuth(config.SERVICE_AUTH_TOKEN), requireHR);

    // GET /v1/org/tree — full nested org structure with head + headcount.
    router.get('/tree', async (_req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT d.*,
                        h.first_name AS head_first_name,
                        h.last_name  AS head_last_name,
                        (SELECT count(*) FROM employees e
                          WHERE e.department_id = d.id AND e.deleted_at IS NULL)::int AS employee_count
                 FROM departments d
                 LEFT JOIN employees h ON h.id = d.head_employee_id AND h.deleted_at IS NULL
                 WHERE d.deleted_at IS NULL
                 ORDER BY d.name`
            );
            res.json({ departments: buildTree(rows) });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
