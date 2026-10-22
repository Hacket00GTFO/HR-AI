/**
 * SQL building blocks for the backfill. Pure functions so they are unit-testable
 * without a database.
 */

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Mask the password in a postgres:// URL for logging. */
const redact = (url) => String(url).replace(/(postgres(?:ql)?:\/\/[^:/@]+:)[^@]+(@)/i, '$1***$2');

const pkList = (spec) => spec.pk.map(quoteIdent).join(', ');

/**
 * Keyset-pagination predicate over the (possibly composite) primary key.
 * Produces `(a, b) > ($1, $2)` which Postgres evaluates lexicographically.
 * `paramOffset` is the first $n the cursor values occupy.
 */
const pkCursorWhere = (spec, paramOffset = 1) => {
    const cols = spec.pk.map(quoteIdent).join(', ');
    const params = spec.pk.map((_, i) => `$${paramOffset + i}`).join(', ');
    return spec.pk.length > 1 ? `(${cols}) > (${params})` : `${cols} > ${params}`;
};

/** SELECT the next batch of source rows after `cursor` (keyset order). */
const buildBatchSelect = (spec, batchSize, cursor, sourceTable) => {
    const textCast = new Set(spec.textCast || []);
    const cols = spec.columns
        .map((c) => (textCast.has(c) ? `${quoteIdent(c)}::text AS ${quoteIdent(c)}` : quoteIdent(c)))
        .join(', ');
    const order = spec.pk.map(quoteIdent).join(', ');
    const params = [];
    let where = '';
    if (cursor) {
        where = `WHERE ${pkCursorWhere(spec, 1)}`;
        params.push(...cursor);
    }
    params.push(batchSize);
    const sql = `SELECT ${cols} FROM ${quoteIdent(sourceTable)} ${where} ORDER BY ${order} LIMIT $${params.length}`;
    return { sql, params };
};

/**
 * Multi-row INSERT for `rowCount` rows with an ON CONFLICT (pk) DO NOTHING
 * idempotency guard. Conflict target is the explicit PK so unrelated unique
 * violations (e.g. candidates.email) still surface as errors.
 */
const buildInsert = (spec, rowCount) => {
    const cols = spec.columns.map(quoteIdent).join(', ');
    const width = spec.columns.length;
    const values = [];
    for (let r = 0; r < rowCount; r += 1) {
        const ph = [];
        for (let c = 0; c < width; c += 1) {
            ph.push(`$${r * width + c + 1}`);
        }
        values.push(`(${ph.join(', ')})`);
    }
    const sql =
        `INSERT INTO ${quoteIdent(spec.name)} (${cols}) VALUES ${values.join(', ')} ` +
        `ON CONFLICT (${pkList(spec)}) DO NOTHING`;
    return sql;
};

const rowToValues = (spec, rows) => {
    const values = [];
    for (const row of rows) {
        for (const col of spec.columns) values.push(row[col]);
    }
    return values;
};

const pkCursorOf = (spec, row) => spec.pk.map((col) => row[col]);

/**
 * Whole-table checksum over the mapped column list. row_to_json renders a
 * canonical text form (jsonb key order is normalized; timestamptz is pinned by
 * SET TIME ZONE 'UTC' on the session). hashtextextended is order-independent
 * via sum() so no giant string_agg is needed.
 */
const buildChecksum = (spec, table, columns) => {
    const cols = columns.map(quoteIdent).join(', ');
    return (
        `SELECT count(*)::text AS n, ` +
        `coalesce(sum(hashtextextended(row_to_json(t)::text, 0)), 0)::text AS h ` +
        `FROM (SELECT ${cols} FROM ${quoteIdent(table)}) t`
    );
};

/**
 * Per-row hash page used to locate divergent rows after a checksum mismatch:
 * returns pk columns + hash for the next page after `cursor`.
 */
const buildHashPageSelect = (spec, batchSize, cursor, table, columns) => {
    const cols = columns.map(quoteIdent).join(', ');
    const pkCols = spec.pk.map(quoteIdent).join(', ');
    const params = [];
    let where = '';
    if (cursor) {
        where = `WHERE ${pkCursorWhere(spec, 1)}`;
        params.push(...cursor);
    }
    params.push(batchSize);
    const sql =
        `SELECT ${pkCols}, hashtextextended(row_to_json(t)::text, 0)::text AS h ` +
        `FROM (SELECT ${cols} FROM ${quoteIdent(table)} ${where} ORDER BY ${pkCols} ` +
        `LIMIT $${params.length}) t`;
    return { sql, params };
};

/**
 * Same as buildHashPageSelect but bounded by a pk window `(cursor, end]`
 * instead of a row LIMIT — used to diff the exact pk range the source page
 * covered, so page boundaries can't produce false positives.
 */
const buildHashRangeSelect = (spec, cursor, end, table, columns) => {
    const cols = columns.map(quoteIdent).join(', ');
    const pkCols = spec.pk.map(quoteIdent).join(', ');
    const n = spec.pk.length;
    const params = [];
    let where = '';
    if (cursor) {
        where = `WHERE ${pkCursorWhere(spec, 1)}`;
        params.push(...cursor);
    }
    const off = params.length + 1;
    const endParams = spec.pk.map((_, i) => `$${off + i}`).join(', ');
    const endCond = n > 1 ? `(${pkCols}) <= (${endParams})` : `${pkCols} <= ${endParams}`;
    where = where ? `${where} AND ${endCond}` : `WHERE ${endCond}`;
    params.push(...end);
    const sql =
        `SELECT ${pkCols}, hashtextextended(row_to_json(t)::text, 0)::text AS h ` +
        `FROM (SELECT ${cols} FROM ${quoteIdent(table)} ${where} ORDER BY ${pkCols}) t`;
    return { sql, params };
};

/** setval a serial sequence to max(id); empty table → next nextval() = 1. */
const buildSetval = (spec) => ({
    sql:
        `SELECT setval(pg_get_serial_sequence($1, $2), ` +
        `coalesce((SELECT max(${quoteIdent(spec.pk[0])}) FROM ${quoteIdent(spec.name)}), 1), ` +
        `(SELECT max(${quoteIdent(spec.pk[0])}) FROM ${quoteIdent(spec.name)}) IS NOT NULL) AS v`,
    params: [spec.name, spec.pk[0]]
});

/** Detect whether a source table exists (for `optional` specs). */
const buildTableExists = (table) => ({
    sql: `SELECT to_regclass($1) AS r`,
    params: [`public.${table}`]
});

module.exports = {
    quoteIdent,
    redact,
    pkCursorWhere,
    buildBatchSelect,
    buildInsert,
    rowToValues,
    pkCursorOf,
    buildChecksum,
    buildHashPageSelect,
    buildHashRangeSelect,
    buildSetval,
    buildTableExists
};
