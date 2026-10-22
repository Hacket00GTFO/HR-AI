/**
 * Verification (mode=verify).
 *
 * Per table: row count + order-independent row-hash checksum over the mapped
 * column list, source vs target. On mismatch, a keyset-paginated per-row hash
 * diff lists the first divergent primary keys (bounded).
 *
 * Timestamptz rendering is pinned with SET TIME ZONE 'UTC' on both sessions so
 * row_to_json() text is comparable across connections.
 */
const { buildChecksum, buildHashPageSelect, buildHashRangeSelect, buildTableExists, pkCursorOf } = require('./db');
const { sourceTable, verifyColumns } = require('./plan');

const DIFF_LIMIT = 50;
const HASH_PAGE = 5000;

async function checksum(client, spec, table) {
    const { rows } = await client.query(buildChecksum(spec, table, verifyColumns(spec)));
    return { count: BigInt(rows[0].n), hash: BigInt(rows[0].h) };
}

async function hashPage(client, spec, cursor, table) {
    const sel = buildHashPageSelect(spec, HASH_PAGE, cursor, table, verifyColumns(spec));
    const { rows } = await client.query(sel.sql, sel.params);
    return rows;
}

async function hashRange(client, spec, cursor, end, table) {
    const sel = buildHashRangeSelect(spec, cursor, end, table, verifyColumns(spec));
    const { rows } = await client.query(sel.sql, sel.params);
    return rows;
}

const pkKey = (spec, row) => JSON.stringify(pkCursorOf(spec, row));

/**
 * Collect up to `limit` divergent keys (different hash, or present on only one
 * side). The source is paged by pk; for each source page the target is read
 * over the SAME pk window `(cursor, pageEnd]`, so page boundaries can never
 * produce false "missing" hits. After the source is exhausted, a final window
 * `(cursor, ∞)` catches trailing extra rows on the target.
 */
async function findDivergent(spec, src, dst, limit = DIFF_LIMIT) {
    const diffs = [];
    const push = (k, issue) => diffs.push({ pk: k, issue });
    let cursor = null;
    for (;;) {
        const sRows = await hashPage(src, spec, cursor, sourceTable(spec));
        const end = sRows.length ? pkCursorOf(spec, sRows[sRows.length - 1]) : null;
        const dRows = end
            ? await hashRange(dst, spec, cursor, end, spec.name)
            : await hashPage(dst, spec, cursor, spec.name);
        if (!sRows.length && !dRows.length) break;
        const sMap = new Map(sRows.map((r) => [pkKey(spec, r), r.h]));
        const dMap = new Map(dRows.map((r) => [pkKey(spec, r), r.h]));
        for (const [k, h] of sMap) {
            if (!dMap.has(k)) push(k, 'missing on target');
            else if (dMap.get(k) !== h) push(k, 'hash mismatch');
        }
        for (const k of dMap.keys()) {
            if (!sMap.has(k)) push(k, 'extra on target');
        }
        if (diffs.length >= limit) return diffs.slice(0, limit);
        if (!sRows.length) break; // source exhausted — the dst page above was the tail
        cursor = end;
        if (sRows.length < HASH_PAGE) {
            // Last source page consumed; one more dst window (cursor, ∞) catches
            // trailing extras beyond the source's max pk.
            const tail = await hashPage(dst, spec, cursor, spec.name);
            for (const r of tail) push(pkKey(spec, r), 'extra on target');
            break;
        }
    }
    return diffs.slice(0, limit);
}

/**
 * @returns {Promise<{table:string, ok:boolean, skipped?:boolean, detail:string}>}
 */
async function verifyTable(spec, src, dst, opts = {}) {
    const log = opts.log || (() => {});
    const srcTable = sourceTable(spec);

    if (spec.optional) {
        const { sql, params } = buildTableExists(srcTable);
        const { rows } = await src.query(sql, params);
        if (!rows[0] || !rows[0].r) {
            log(`  ${spec.name}: SKIP — source table ${srcTable} not found`);
            return { table: spec.name, ok: true, skipped: true, detail: 'source table absent' };
        }
    }

    const [s, d] = await Promise.all([checksum(src, spec, srcTable), checksum(dst, spec, spec.name)]);
    if (s.count === d.count && s.hash === d.hash) {
        const detail = `${s.count} rows, checksum ok`;
        log(`  ${spec.name}: OK (${detail})`);
        return { table: spec.name, ok: true, detail };
    }

    const diffs = await findDivergent(spec, src, dst, opts.diffLimit || DIFF_LIMIT);
    const detail =
        `count src=${s.count} dst=${d.count}; checksum src=${s.hash} dst=${d.hash}` +
        (diffs.length ? `; first diffs: ${diffs.map((x) => `${x.pk}(${x.issue})`).join(', ')}` : '');
    log(`  ${spec.name}: MISMATCH — ${detail}`);
    return { table: spec.name, ok: false, detail };
}

/** Run SET TIME ZONE 'UTC' so checksums are comparable across sessions. */
async function pinUtc(client) {
    await client.query(`SET TIME ZONE 'UTC'`);
}

module.exports = { verifyTable, findDivergent, pinUtc };
