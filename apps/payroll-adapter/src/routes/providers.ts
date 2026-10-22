import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import type { EventPublisher } from '../events.js';
import { actorOf, requireHR, serviceOrUserAuth } from '../auth.js';
import { writeAudit } from '../db.js';
import { resolveAdapter } from '../adapters/index.js';

export interface ProvidersDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

const idParam = z.coerce.number().int().positive();

const updateSchema = z
    .object({
        enabled: z.boolean().optional(),
        config: z.record(z.string(), z.unknown()).optional()
    })
    .strict()
    .refine((d) => d.enabled !== undefined || d.config !== undefined, {
        message: 'Provide enabled and/or config'
    });

function rowToProvider(r: Record<string, unknown>) {
    return {
        id: Number(r.id),
        name: r.name,
        adapter: r.adapter,
        config: r.config,
        enabled: r.enabled,
        createdAt: r.created_at,
        updatedAt: r.updated_at
    };
}

export function providersRouter(deps: ProvidersDeps): Router {
    const { pool, config } = deps;
    const router = Router();

    router.use(serviceOrUserAuth(config.SERVICE_AUTH_TOKEN), requireHR);

    // GET /v1/payroll/providers — registered provider adapters.
    router.get('/', async (_req, res, next) => {
        try {
            const { rows } = await pool.query(`SELECT * FROM payroll_providers ORDER BY id`);
            res.json(rows.map(rowToProvider));
        } catch (err) {
            next(err);
        }
    });

    // PUT /v1/payroll/providers/:id — enable/disable + config. Config is
    // validated by the target adapter before persisting.
    router.put('/:id(\\d+)', async (req, res, next) => {
        try {
            const parsed = idParam.safeParse(req.params.id);
            if (!parsed.success) throw httpError(400, 'Invalid provider id');
            const id = parsed.data;

            const body = updateSchema.safeParse(req.body);
            if (!body.success) throw httpError(400, 'Invalid provider payload', body.error.issues);

            const { rows: existing } = await pool.query(`SELECT * FROM payroll_providers WHERE id = $1`, [id]);
            const provider = existing[0] as { adapter: string; config: Record<string, unknown> } | undefined;
            if (!provider) throw httpError(404, 'Payroll provider not found');

            const nextConfig = body.data.config ?? provider.config ?? {};
            const adapter = resolveAdapter(provider.adapter, {
                importsDir: config.IMPORTS_DIR,
                exportsDir: config.EXPORTS_DIR,
                pool
            });
            await adapter.validateConfig(nextConfig);

            const sets: string[] = [];
            const params: unknown[] = [id];
            if (body.data.enabled !== undefined) {
                params.push(body.data.enabled);
                sets.push(`enabled = $${params.length}`);
            }
            if (body.data.config !== undefined) {
                params.push(JSON.stringify(nextConfig));
                sets.push(`config = $${params.length}`);
            }
            const { rows } = await pool.query(
                `UPDATE payroll_providers SET ${sets.join(', ')}, updated_at = now()
                 WHERE id = $1 RETURNING *`,
                params
            );
            await writeAudit(pool, {
                actor: actorOf(req),
                action: 'provider.update',
                entity: 'payroll_providers',
                entityId: id,
                metadata: { enabled: body.data.enabled, configKeys: Object.keys(nextConfig) }
            });
            res.json(rowToProvider(rows[0]!));
        } catch (err) {
            next(err);
        }
    });

    return router;
}
