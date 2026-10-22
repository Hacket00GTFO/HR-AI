/**
 * Batched, idempotent table copy (mode=copy).
 *
 * - Keyset pagination on the source PK (no OFFSET drift; production-scale safe).
 * - Each batch is a single multi-row INSERT … ON CONFLICT (pk) DO NOTHING inside
 *   its own transaction on the target → re-running the script is a no-op for
 *   rows already copied and the job is resumable.
 * - Table order comes from plan.js (FK-safe: parents before children).
 */
const { buildBatchSelect, buildInsert, rowToValues, pkCursorOf, buildSetval, buildTableExists } = require('./db');
const { sourceTable } = require('./plan');

/**
 * @param {object} spec       table spec from plan.js
 * @param {object} src        pg Pool/Client-compatible (query())
 * @param {object} dst        pg Pool/Client-compatible (query())
 * @param {object} opts       { batchSize, log }
 * @returns {Promise<{table:string, copied:number, skipped:boolean}>}
 */
async function copyTable(spec, src, dst, opts = {}) {
    const batchSize = opts.batchSize || 1000;
    const log = opts.log || (() => {});
    const srcTable = sourceTable(spec);

    if (spec.optional) {
        const { sql, params } = buildTableExists(srcTable);
        const { rows } = await src.query(sql, params);
        if (!rows[0] || !rows[0].r) {
            log(`  ${spec.name}: SKIP — source table ${srcTable} not found`);
            return { table: spec.name, copied: 0, skipped: true };
        }
    }

    let cursor = null;
    let copied = 0;
    let batch = 0;
    for (;;) {
        const sel = buildBatchSelect(spec, batchSize, cursor, srcTable);
        const { rows } = await src.query(sel.sql, sel.params);
        if (!rows.length) break;

        // One tx per batch: a failure rolls back only this batch and the
        // ON CONFLICT guard keeps already-committed batches intact on retry.
        await dst.query('BEGIN');
        try {
            const insert = buildInsert(spec, rows.length);
            const res = await dst.query(insert, rowToValues(spec, rows));
            await dst.query('COMMIT');
            const inserted = res.rowCount == null ? rows.length : res.rowCount;
            copied += inserted;
            batch += 1;
            log(
                `  ${spec.name}: batch ${batch} — ${rows.length} read, ` +
                    `${inserted} inserted, ${rows.length - inserted} conflict-skipped ` +
                    `(through ${JSON.stringify(pkCursorOf(spec, rows[rows.length - 1]))})`
            );
        } catch (err) {
            await dst.query('ROLLBACK').catch(() => {});
            throw err;
        }

        cursor = pkCursorOf(spec, rows[rows.length - 1]);
        if (rows.length < batchSize) break;
    }
    log(`  ${spec.name}: done — ${copied} rows copied`);
    return { table: spec.name, copied, skipped: false };
}

/** Point every serial sequence at max(id) so post-cutover inserts don't collide. */
async function fixSequences(specs, dst, log = () => {}) {
    for (const spec of specs) {
        if (!spec.sequence || spec._skipped) continue;
        const { sql, params } = buildSetval(spec);
        const { rows } = await dst.query(sql, params);
        log(`  sequence ${spec.sequence} → ${rows[0] ? rows[0].v : '?'}`);
    }
}

module.exports = { copyTable, fixSequences };
