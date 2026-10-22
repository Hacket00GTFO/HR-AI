import { query } from './db.js';

export interface DbSettings {
    id: number;
    user_id: number | null;
    company: Record<string, unknown> | null;
    linkedin: Record<string, unknown> | null;
    occ: Record<string, unknown> | null;
    theme: string | null;
    notifications: boolean | null;
    created_at: Date;
    updated_at: Date;
}

export async function findSettingsByUserId(userId: number): Promise<DbSettings | null> {
    const { rows } = await query<DbSettings>('SELECT * FROM settings WHERE user_id = $1', [userId]);
    return rows[0] ?? null;
}

export async function findGlobalSettings(): Promise<DbSettings | null> {
    const { rows } = await query<DbSettings>('SELECT * FROM settings WHERE user_id IS NULL ORDER BY id LIMIT 1');
    return rows[0] ?? null;
}

export async function upsertCompany(userId: number, company: Record<string, unknown>): Promise<DbSettings> {
    const { rows } = await query<DbSettings>(
        `INSERT INTO settings (user_id, company)
         VALUES ($1, $2)
         ON CONFLICT (user_id) WHERE user_id IS NOT NULL
         DO UPDATE SET company = EXCLUDED.company, updated_at = now()
         RETURNING *`,
        [userId, JSON.stringify(company)]
    );
    return rows[0] as DbSettings;
}

export async function updateUserSettings(
    userId: number,
    fields: { company?: Record<string, unknown>; theme?: string; notifications?: boolean }
): Promise<DbSettings> {
    const { rows } = await query<DbSettings>(
        `INSERT INTO settings (user_id, company, theme, notifications)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) WHERE user_id IS NOT NULL
         DO UPDATE SET
             company = COALESCE(EXCLUDED.company, settings.company),
             theme = COALESCE(EXCLUDED.theme, settings.theme),
             notifications = COALESCE(EXCLUDED.notifications, settings.notifications),
             updated_at = now()
         RETURNING *`,
        [
            userId,
            fields.company !== undefined ? JSON.stringify(fields.company) : null,
            fields.theme ?? null,
            fields.notifications ?? null
        ]
    );
    return rows[0] as DbSettings;
}

/**
 * Upsert a field on the single global row (user_id IS NULL).
 * `value` should already have its secrets encrypted by the caller.
 */
export async function upsertGlobalField(
    field: 'linkedin' | 'occ' | 'theme' | 'notifications',
    value: unknown
): Promise<DbSettings> {
    const { rows } = await query<DbSettings>(
        `WITH existing AS (SELECT id FROM settings WHERE user_id IS NULL ORDER BY id LIMIT 1),
         upd AS (
             UPDATE settings SET ${field} = $1, updated_at = now()
             WHERE id = (SELECT id FROM existing)
             RETURNING *
         ),
         ins AS (
             INSERT INTO settings (user_id, ${field})
             SELECT NULL, $1 WHERE NOT EXISTS (SELECT 1 FROM upd)
             RETURNING *
         )
         SELECT * FROM upd UNION ALL SELECT * FROM ins`,
        [typeof value === 'object' && value !== null ? JSON.stringify(value) : value]
    );
    return rows[0] as DbSettings;
}
