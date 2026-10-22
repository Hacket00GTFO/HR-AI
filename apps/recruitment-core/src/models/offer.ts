import { withId, type Queryable } from '../db.js';

// Offer lifecycle: draft → sent → accepted | declined | expired.
// 'draft' offers were created without being extended; a decision may still be
// recorded against draft|sent (the candidate answered). Terminal states
// (accepted|declined|expired) reject further decisions with 409.
export const OFFER_STATUSES = new Set(['draft', 'sent', 'accepted', 'declined', 'expired']);
export const OFFER_DECISIONS = new Set(['accepted', 'declined']);
export const TERMINAL_OFFER_STATUSES = new Set(['accepted', 'declined', 'expired']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// Read shape: offer row + the application's candidate/vacancy refs.
const SELECT = `
    SELECT o.*, a.candidate_id, a.vacancy_id
    FROM offers o
    JOIN applications a ON a.id = o.application_id
`;

export interface OfferCreateData {
    application_id: number;
    salary: number;
    salary_currency?: string | null;
    start_date?: Date | string | null;
    terms?: string | null;
    status?: 'draft' | 'sent';
    created_by?: number | null;
}

export async function create(db: Queryable, data: OfferCreateData): Promise<Row> {
    const status = data.status ?? 'sent';
    if (status !== 'draft' && status !== 'sent') {
        const err = new Error(`Invalid offer status: ${status}`) as Error & { status?: number };
        err.status = 400;
        throw err;
    }
    const { rows } = await db.query(
        `INSERT INTO offers
            (application_id, salary, salary_currency, start_date, terms, status, sent_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
            data.application_id,
            data.salary,
            data.salary_currency ?? null,
            data.start_date ?? null,
            data.terms ?? null,
            status,
            status === 'sent' ? new Date() : null,
            data.created_by ?? null
        ]
    );
    const offer = rows[0];
    if (!offer) throw new Error('offer insert returned no row');
    return withId(offer);
}

export async function findById(db: Queryable, id: unknown): Promise<Row | null> {
    const { rows } = await db.query(`${SELECT} WHERE o.id = $1`, [id]);
    return withId(rows[0] || null);
}

export async function findForApplication(db: Queryable, applicationId: unknown): Promise<Row[]> {
    const { rows } = await db.query(`${SELECT} WHERE o.application_id = $1 ORDER BY o.created_at DESC`, [
        applicationId
    ]);
    return rows.map((r) => withId(r));
}

/**
 * Record the candidate's decision inside the caller's transaction. Returns
 * null when the offer does not exist; throws {status:409} when the offer is
 * already terminal (or when `decision` is not accepted|declined → 400).
 */
export async function decide(
    client: Queryable,
    offerId: unknown,
    decision: string,
    reason: string | null
): Promise<Row | null> {
    if (!OFFER_DECISIONS.has(decision)) {
        const err = new Error(`Invalid offer decision: ${decision}`) as Error & { status?: number };
        err.status = 400;
        throw err;
    }
    const { rows: found } = await client.query(
        'SELECT id, status, application_id FROM offers WHERE id = $1 FOR UPDATE',
        [offerId]
    );
    const current = found[0];
    if (!current) return null;
    if (TERMINAL_OFFER_STATUSES.has(current.status)) {
        const err = new Error(`Offer already ${current.status}`) as Error & { status?: number };
        err.status = 409;
        throw err;
    }
    const { rows } = await client.query(
        `UPDATE offers SET status = $2, decision_reason = $3, decided_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [offerId, decision, reason]
    );
    return withId(rows[0] || null);
}
