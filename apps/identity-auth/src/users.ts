import type { PoolClient } from 'pg';
import { query } from './db.js';
import { hashPassword } from './passwords.js';

export interface DbUser {
    id: number;
    first_name: string;
    last_name: string;
    email: string;
    password: string;
    role: 'admin' | 'hr';
    location: unknown;
    last_login: Date | null;
    logged_out: boolean;
    active: boolean;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
    mfa_secret: string | null;
    mfa_enabled: boolean;
    /** sha256 hashes of one-time recovery codes (plaintext only shown at enrollment). */
    mfa_backup_codes: string[];
}

/** API wire shape — camelCase, matching the legacy monolith contract. */
export interface PublicUser {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    role: string;
    location: unknown;
    lastLogin: Date | null;
    loggedOut: boolean;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export function toPublicUser(u: DbUser): PublicUser {
    return {
        id: u.id,
        firstName: u.first_name,
        lastName: u.last_name,
        email: u.email,
        role: u.role,
        location: u.location,
        lastLogin: u.last_login,
        loggedOut: u.logged_out,
        active: u.active,
        createdAt: u.created_at,
        updatedAt: u.updated_at
    };
}

const SELECT = `SELECT id, first_name, last_name, email, password, role, location,
       last_login, logged_out, active, created_at, updated_at, deleted_at,
       mfa_secret, mfa_enabled, mfa_backup_codes
FROM users`;

export async function findUserByEmail(email: string): Promise<DbUser | null> {
    const { rows } = await query<DbUser>(`${SELECT} WHERE lower(email) = lower($1) AND deleted_at IS NULL`, [email]);
    return rows[0] ?? null;
}

export async function findUserById(id: number, client?: PoolClient): Promise<DbUser | null> {
    const q = client ?? { query: (t: string, p: unknown[]) => query<DbUser>(t, p) };
    const { rows } = await q.query(`${SELECT} WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return (rows[0] as DbUser) ?? null;
}

export interface CreateUserInput {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    role: 'admin' | 'hr';
    location?: unknown;
}

export async function createUser(input: CreateUserInput, client?: PoolClient): Promise<DbUser> {
    const hashed = await hashPassword(input.password);
    const q = client ?? { query: (t: string, p: unknown[]) => query<DbUser>(t, p) };
    const { rows } = await q.query(
        `INSERT INTO users (first_name, last_name, email, password, role, location)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
            input.firstName,
            input.lastName,
            input.email.toLowerCase().trim(),
            hashed,
            input.role,
            input.location != null ? JSON.stringify(input.location) : null
        ]
    );
    return rows[0] as DbUser;
}

const UPDATABLE: Record<string, string> = {
    firstName: 'first_name',
    lastName: 'last_name',
    email: 'email',
    role: 'role',
    location: 'location',
    active: 'active',
    loggedOut: 'logged_out',
    lastLogin: 'last_login'
};

export async function updateUser(
    id: number,
    fields: Record<string, unknown>,
    client?: PoolClient
): Promise<DbUser | null> {
    const updates = { ...fields };
    if (typeof updates['password'] === 'string' && updates['password']) {
        updates['password'] = await hashPassword(updates['password']);
    }
    const keys = Object.keys(updates).filter((k) => (UPDATABLE[k] || k === 'password') && updates[k] !== undefined);
    if (keys.length === 0) return findUserById(id, client);

    const setClause = keys.map((k, i) => `"${UPDATABLE[k] ?? 'password'}" = $${i + 2}`).join(', ');
    const values = keys.map((k) =>
        k === 'location' ? (updates[k] != null ? JSON.stringify(updates[k]) : null) : updates[k]
    );
    const q = client ?? { query: (t: string, p: unknown[]) => query<DbUser>(t, p) };
    const { rows } = await q.query(
        `UPDATE users SET ${setClause}, updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
        [id, ...values]
    );
    return (rows[0] as DbUser) ?? null;
}

export async function softDeleteUser(id: number, client?: PoolClient): Promise<DbUser | null> {
    const q = client ?? { query: (t: string, p: unknown[]) => query<DbUser>(t, p) };
    const { rows } = await q.query(
        `UPDATE users SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
        [id]
    );
    return (rows[0] as DbUser) ?? null;
}

export async function countByRole(role: string, client?: PoolClient): Promise<number> {
    const q = client ?? { query: (t: string, p: unknown[]) => query<{ count: number }>(t, p) };
    const { rows } = await q.query('SELECT COUNT(*)::int AS count FROM users WHERE role = $1 AND deleted_at IS NULL', [
        role
    ]);
    return (rows[0]?.count as number) ?? 0;
}

export interface ListUsersOptions {
    page: number;
    limit: number;
    role?: string;
    q?: string;
}

export async function listUsers(opts: ListUsersOptions): Promise<{ data: DbUser[]; total: number }> {
    const where: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (opts.role) {
        params.push(opts.role);
        where.push(`role = $${params.length}`);
    }
    if (opts.q) {
        params.push(`%${opts.q}%`);
        where.push(
            `(first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length})`
        );
    }
    const whereSql = where.join(' AND ');
    const { rows: countRows } = await query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM users WHERE ${whereSql}`,
        params
    );
    const total = countRows[0]?.total ?? 0;

    params.push(opts.limit, (opts.page - 1) * opts.limit);
    const { rows } = await query<DbUser>(
        `${SELECT} WHERE ${whereSql} ORDER BY id LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return { data: rows, total };
}
