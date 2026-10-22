import { Router, type Response } from 'express';
import { logger } from '@strafor/node-common';
import type { RouteDeps } from './auth.js';
import { validate } from '../middleware/validate.js';
import { verifyServiceToken, requireAdmin, requireSelfOrAdmin, type AuthenticatedRequest } from '../middleware/auth.js';
import * as schema from '../schemas.js';
import {
    listUsers,
    findUserById,
    findUserByEmail,
    createUser,
    updateUser,
    softDeleteUser,
    countByRole,
    toPublicUser
} from '../users.js';
import { recordAudit } from '../audit.js';
import { publishEvent, buildEvent } from '../events.js';
import { revokeAllForUser } from '../refreshTokens.js';
import { withTransaction } from '../db.js';
import { recordOutboxEvent, type UserLifecyclePayload } from '../outbox.js';

/** strafor.identity.* payload — display fields for downstream projections. */
function lifecyclePayload(user: {
    id: number;
    email: string;
    first_name: string;
    last_name: string;
    role: string;
}): UserLifecyclePayload {
    return {
        userId: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role
    };
}

export function usersRouter(deps: RouteDeps): Router {
    const router = Router();
    const { config } = deps;

    // ---- GET /v1/users (admin, paginated ?page&limit&role&q) ----
    router.get(
        '/',
        requireAdmin(deps),
        validate({ query: schema.listUsersQuery }),
        async (req: AuthenticatedRequest, res: Response) => {
            try {
                const { page, limit, role, q } = req.query as unknown as {
                    page: number;
                    limit: number;
                    role?: string;
                    q?: string;
                };
                const { data, total } = await listUsers({
                    page,
                    limit,
                    ...(role ? { role } : {}),
                    ...(q ? { q } : {})
                });
                res.json({
                    data: data.map(toPublicUser),
                    pagination: {
                        page,
                        limit,
                        total,
                        totalPages: Math.max(1, Math.ceil(total / limit))
                    }
                });
            } catch (err) {
                logger.error({ err: (err as Error).message }, 'list users error');
                res.status(500).json({ error: 'Error fetching users' });
            }
        }
    );

    // ---- POST /v1/users (admin) ----
    router.post(
        '/',
        requireAdmin(deps),
        validate({ body: schema.userCreateBody }),
        async (req: AuthenticatedRequest, res: Response) => {
            try {
                const { firstName, lastName, email, password, role, location } = req.body;
                if (role === 'hr' && (!location || !location.country || !location.city)) {
                    res.status(400).json({
                        error: 'Missing location information',
                        details: 'Country and city are required for HR accounts'
                    });
                    return;
                }
                if (await findUserByEmail(email)) {
                    res.status(400).json({ error: 'Email already registered' });
                    return;
                }
                const user = await withTransaction(async (client) => {
                    const created = await createUser(
                        {
                            firstName,
                            lastName,
                            email,
                            password,
                            role,
                            ...(role === 'hr' ? { location } : {})
                        },
                        client
                    );
                    // Outbox row commits with the user row — relay publishes
                    // strafor.identity.user_created post-commit.
                    await recordOutboxEvent(client, {
                        aggregateType: 'user',
                        aggregateId: created.id,
                        eventType: 'strafor.identity.user_created',
                        payload: lifecyclePayload(created),
                        correlationId: req.correlationId as string
                    });
                    return created;
                });
                await recordAudit({
                    actorId: req.auth!.sub,
                    action: 'user.create',
                    entity: 'users',
                    entityId: user.id,
                    metadata: { role }
                });
                await publishEvent(
                    config,
                    buildEvent(
                        'strafor.user.registered',
                        { userId: user.id, email: user.email, role: user.role, registeredBy: Number(req.auth!.sub) },
                        req.correlationId as string
                    )
                );
                res.status(201).json(toPublicUser(user));
            } catch (err) {
                logger.error({ err: (err as Error).message }, 'create user error');
                res.status(500).json({ error: 'Error creating user' });
            }
        }
    );

    // ---- GET /v1/users/:id (admin or self) ----
    router.get(
        '/:id',
        verifyServiceToken(deps),
        validate({ params: schema.idParam }),
        requireSelfOrAdmin(),
        async (req: AuthenticatedRequest, res: Response) => {
            try {
                const user = await findUserById(Number(req.params['id']));
                if (!user) {
                    res.status(404).json({ error: 'User not found' });
                    return;
                }
                res.json(toPublicUser(user));
            } catch (err) {
                logger.error({ err: (err as Error).message }, 'get user error');
                res.status(500).json({ error: 'Error fetching user' });
            }
        }
    );

    // ---- PUT /v1/users/:id (admin: all fields; self: firstName/lastName/location) ----
    router.put(
        '/:id',
        verifyServiceToken(deps),
        validate({ params: schema.idParam }),
        requireSelfOrAdmin(),
        validate({ body: schema.userUpdateBody }),
        async (req: AuthenticatedRequest, res: Response) => {
            try {
                const id = Number(req.params['id']);
                const existing = await findUserById(id);
                if (!existing) {
                    res.status(404).json({ error: 'User not found' });
                    return;
                }

                const isAdmin = req.auth!.role === 'admin';
                const body = req.body as Record<string, unknown>;

                if (!isAdmin) {
                    const forbidden = Object.keys(body).filter((k) => !schema.SELF_UPDATE_FIELDS.has(k));
                    if (forbidden.length > 0) {
                        res.status(403).json({
                            error: 'Access denied',
                            details: `Fields not self-editable: ${forbidden.join(', ')}`
                        });
                        return;
                    }
                }

                if (body['email'] && String(body['email']).toLowerCase() !== existing.email) {
                    const clash = await findUserByEmail(String(body['email']));
                    if (clash && clash.id !== id) {
                        res.status(400).json({ error: 'Email already in use' });
                        return;
                    }
                }

                const updated = await withTransaction(async (client) => {
                    const row = await updateUser(id, body, client);
                    if (!row) return row;
                    await recordOutboxEvent(client, {
                        aggregateType: 'user',
                        aggregateId: row.id,
                        eventType: 'strafor.identity.user_updated',
                        payload: lifecyclePayload(row),
                        correlationId: req.correlationId as string
                    });
                    return row;
                });
                await recordAudit({
                    actorId: req.auth!.sub,
                    action: 'user.update',
                    entity: 'users',
                    entityId: id,
                    metadata: { changedKeys: Object.keys(body) }
                });
                await publishEvent(
                    config,
                    buildEvent(
                        'strafor.user.updated',
                        { userId: id, changedKeys: Object.keys(body), updatedBy: Number(req.auth!.sub) },
                        req.correlationId as string
                    )
                );
                res.json(toPublicUser(updated!));
            } catch (err) {
                logger.error({ err: (err as Error).message }, 'update user error');
                res.status(500).json({ error: 'Error updating user' });
            }
        }
    );

    // ---- DELETE /v1/users/:id (admin only, soft delete) ----
    router.delete(
        '/:id',
        requireAdmin(deps),
        validate({ params: schema.idParam }),
        async (req: AuthenticatedRequest, res: Response) => {
            try {
                const id = Number(req.params['id']);
                const existing = await findUserById(id);
                if (!existing) {
                    res.status(404).json({ error: 'User not found' });
                    return;
                }
                if (existing.role === 'admin' && (await countByRole('admin')) <= 1) {
                    res.status(400).json({ error: 'Cannot delete the last admin account' });
                    return;
                }
                if (id === Number(req.auth!.sub)) {
                    res.status(400).json({ error: 'Cannot delete your own account' });
                    return;
                }
                await withTransaction(async (client) => {
                    await softDeleteUser(id, client);
                    await revokeAllForUser(id, client);
                    // Pre-delete row carries the last known display fields for
                    // downstream projections (consumers may erase by userId/email).
                    await recordOutboxEvent(client, {
                        aggregateType: 'user',
                        aggregateId: existing.id,
                        eventType: 'strafor.identity.user_deleted',
                        payload: lifecyclePayload(existing),
                        correlationId: req.correlationId as string
                    });
                });
                await recordAudit({
                    actorId: req.auth!.sub,
                    action: 'user.delete',
                    entity: 'users',
                    entityId: id,
                    metadata: { role: existing.role }
                });
                res.json({ message: 'User deleted successfully' });
            } catch (err) {
                logger.error({ err: (err as Error).message }, 'delete user error');
                res.status(500).json({ error: 'Error deleting user' });
            }
        }
    );

    return router;
}
