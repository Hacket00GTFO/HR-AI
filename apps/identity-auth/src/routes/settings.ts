import { Router, type Response } from 'express';
import { logger, httpError } from '@strafor/node-common';
import type { RouteDeps } from './auth.js';
import { validate } from '../middleware/validate.js';
import { verifyServiceToken, requireAdmin, type AuthenticatedRequest } from '../middleware/auth.js';
import * as schema from '../schemas.js';
import { findSettingsByUserId, findGlobalSettings, updateUserSettings, upsertGlobalField } from '../settingsRepo.js';
import { encryptSecrets, maskSecrets } from '../crypto.js';
import { recordAudit } from '../audit.js';
import { publishEvent, buildEvent } from '../events.js';

export function settingsRouter(deps: RouteDeps): Router {
    const router = Router();
    const { config } = deps;

    // ---- GET /v1/settings — caller's own settings row ----
    router.get('/', verifyServiceToken(deps), async (req: AuthenticatedRequest, res: Response) => {
        try {
            const settings = await findSettingsByUserId(Number(req.auth!.sub));
            if (!settings) {
                res.status(404).json({ error: 'Settings not found' });
                return;
            }
            res.json(settings);
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'get settings error');
            res.status(500).json({ error: 'Error fetching settings' });
        }
    });

    // ---- PUT /v1/settings — caller's own settings (company/theme/notifications) ----
    router.put(
        '/',
        verifyServiceToken(deps),
        validate({ body: schema.userSettingsBody }),
        async (req: AuthenticatedRequest, res: Response) => {
            try {
                const body = req.body as { company?: Record<string, unknown>; theme?: string; notifications?: boolean };
                const settings = await updateUserSettings(Number(req.auth!.sub), body);
                await recordAudit({
                    actorId: req.auth!.sub,
                    action: 'settings.update',
                    entity: 'settings',
                    entityId: settings.id,
                    metadata: { changedKeys: Object.keys(body) }
                });
                await publishEvent(
                    config,
                    buildEvent(
                        'strafor.settings.updated',
                        { scope: 'user', updatedBy: Number(req.auth!.sub), changedKeys: Object.keys(body) },
                        req.correlationId as string
                    )
                );
                res.json(settings);
            } catch (err) {
                logger.error({ err: (err as Error).message }, 'update settings error');
                res.status(500).json({ error: 'Error updating settings' });
            }
        }
    );

    // ---- GET /v1/settings/integrations (admin) — secrets masked, never plaintext ----
    // No consumer needs the real values (the api /api-config proxy only reads
    // theme + notifications); any future server-side use must decrypt at the
    // point of use, not through this endpoint.
    router.get('/integrations', requireAdmin(deps), async (req: AuthenticatedRequest, res: Response) => {
        try {
            const row = await findGlobalSettings();
            res.json({
                linkedin: maskSecrets(row?.linkedin ?? null, config.settingsEncryptionKey),
                occ: maskSecrets(row?.occ ?? null, config.settingsEncryptionKey),
                theme: row?.theme ?? 'light',
                notifications: row?.notifications ?? true
            });
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'get integrations error');
            res.status(500).json({ error: 'Error fetching integrations' });
        }
    });

    // ---- PUT /v1/settings/integrations (admin) — secrets encrypted at rest ----
    router.put(
        '/integrations',
        requireAdmin(deps),
        validate({ body: schema.integrationsBody }),
        async (req: AuthenticatedRequest, res: Response) => {
            try {
                const body = req.body as {
                    linkedin?: Record<string, unknown>;
                    occ?: Record<string, unknown>;
                    theme?: string;
                    notifications?: boolean;
                };
                const changed: string[] = [];

                if ((body.linkedin || body.occ) && !config.settingsEncryptionKey) {
                    throw httpError(
                        503,
                        'SETTINGS_ENCRYPTION_KEY is not configured — cannot store integration secrets'
                    );
                }

                if (body.linkedin) {
                    await upsertGlobalField('linkedin', encryptSecrets(body.linkedin, config.settingsEncryptionKey));
                    changed.push('linkedin');
                }
                if (body.occ) {
                    await upsertGlobalField('occ', encryptSecrets(body.occ, config.settingsEncryptionKey));
                    changed.push('occ');
                }
                if (body.theme !== undefined) {
                    await upsertGlobalField('theme', body.theme);
                    changed.push('theme');
                }
                if (body.notifications !== undefined) {
                    await upsertGlobalField('notifications', body.notifications);
                    changed.push('notifications');
                }

                await recordAudit({
                    actorId: req.auth!.sub,
                    action: 'settings.integrations_update',
                    entity: 'settings',
                    metadata: { changedKeys: changed }
                });
                await publishEvent(
                    config,
                    buildEvent(
                        'strafor.settings.updated',
                        { scope: 'linkedin', updatedBy: Number(req.auth!.sub), changedKeys: changed },
                        req.correlationId as string
                    )
                );

                res.json({ message: 'Integration settings updated', changedKeys: changed });
            } catch (err) {
                if ((err as { status?: number }).status) {
                    res.status((err as { status: number }).status).json({ error: (err as Error).message });
                    return;
                }
                logger.error({ err: (err as Error).message }, 'update integrations error');
                res.status(500).json({ error: 'Error updating integrations' });
            }
        }
    );

    return router;
}
