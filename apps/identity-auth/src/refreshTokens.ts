import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import { generateRefreshToken, hashToken } from './tokens.js';

export interface RefreshTokenRow {
    id: string;
    user_id: number;
    family_id: string;
    token_hash: string;
    expires_at: Date;
    revoked_at: Date | null;
    replaced_by: string | null;
    user_agent: string | null;
    ip: string | null;
    created_at: Date;
}

export interface RefreshContext {
    userAgent?: string;
    ip?: string;
}

/** Insert a fresh refresh token in a new family (login / register). */
export async function issueRefreshToken(
    userId: number,
    ttlDays: number,
    ctx: RefreshContext,
    familyId?: string,
    client?: PoolClient
): Promise<{ token: string; familyId: string }> {
    const token = generateRefreshToken();
    const family = familyId ?? crypto.randomUUID();
    const q = client ?? { query: (t: string, p: unknown[]) => query(t, p) };
    await q.query(
        `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
         VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5, $6)`,
        [userId, family, hashToken(token), String(ttlDays), ctx.userAgent ?? null, ctx.ip ?? null]
    );
    return { token, familyId: family };
}

export type RotateResult =
    { ok: true; token: string; userId: number } | { ok: false; reason: 'invalid' | 'expired' | 'reused' };

/**
 * Rotate a refresh token. Reuse of a revoked token revokes the ENTIRE family
 * (a stolen-token signal) and reports 'reused'.
 */
export async function rotateRefreshToken(
    presentedToken: string,
    ttlDays: number,
    ctx: RefreshContext
): Promise<RotateResult> {
    return withTransaction(async (client) => {
        const { rows } = await client.query(`SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`, [
            hashToken(presentedToken)
        ]);
        const row = rows[0] as RefreshTokenRow | undefined;
        if (!row) return { ok: false, reason: 'invalid' } as const;

        if (row.revoked_at) {
            // Reuse detection: kill the whole family.
            await client.query(
                `UPDATE refresh_tokens SET revoked_at = now()
                 WHERE family_id = $1 AND revoked_at IS NULL`,
                [row.family_id]
            );
            return { ok: false, reason: 'reused' } as const;
        }
        if (new Date(row.expires_at).getTime() <= Date.now()) {
            return { ok: false, reason: 'expired' } as const;
        }

        const next = generateRefreshToken();
        const { rows: inserted } = await client.query(
            `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
             VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5, $6)
             RETURNING id`,
            [row.user_id, row.family_id, hashToken(next), String(ttlDays), ctx.userAgent ?? null, ctx.ip ?? null]
        );
        await client.query(`UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1`, [
            row.id,
            (inserted[0] as { id: string }).id
        ]);
        return { ok: true, token: next, userId: row.user_id } as const;
    });
}

/** Revoke every live refresh token for a user (logout, password change, reset). */
export async function revokeAllForUser(userId: number, client?: PoolClient): Promise<void> {
    const q = client ?? { query: (t: string, p: unknown[]) => query(t, p) };
    await q.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

/** Revoke a single family (used when the caller presents a refresh token at logout). */
export async function revokeFamilyByToken(presentedToken: string): Promise<void> {
    await query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)
           AND revoked_at IS NULL`,
        [hashToken(presentedToken)]
    );
}
