// Shared fakes for the pg client used by the unit tests — no real database.
// Implements just enough of the SQL surface the script emits:
//   - to_regclass() existence probe
//   - keyset-paginated SELECT (… > ($n…)) ORDER BY pk) LIMIT $m
//   - multi-row INSERT … ON CONFLICT (pk) DO NOTHING inside BEGIN/COMMIT
//   - checksum SELECT (count + sum of row hashes)
//   - per-row hash page (… LIMIT) and hash range (pk window (cursor, end])
//   - setval / TRUNCATE (recorded as calls)

const tableOf = (sql) => {
    const m = sql.match(/FROM "(\w+)"/);
    return m ? m[1] : null;
};

const cmpTuple = (a, b) => {
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] === b[i]) continue;
        return a[i] < b[i] ? -1 : 1;
    }
    return 0;
};

const afterCursor = (rows, pk, cursor) => {
    if (!cursor) return rows;
    return rows.filter(
        (r) =>
            cmpTuple(
                pk.map((c) => r[c]),
                cursor
            ) > 0
    );
};

const sortByPk = (rows, pk) =>
    rows.slice().sort((a, b) =>
        cmpTuple(
            pk.map((c) => a[c]),
            pk.map((c) => b[c])
        )
    );

const rowHash = (row, cols) => {
    // Deterministic, cheap stand-in for hashtextextended: any value change on a
    // mapped column changes the hash.
    const s = JSON.stringify(cols.map((c) => row[c] ?? null));
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 1e15;
    return String(h);
};

const parseCols = (sql) => {
    const m = sql.match(/SELECT (.+?) FROM/);
    return m[1].split(',').map((c) => c.trim().replace(/"/g, ''));
};

/**
 * Fake "queryable" bound to a spec (pk + mapped columns) and a fixture row set.
 * `calls` records every statement for assertions.
 */
export function makeFakeDb(spec, fixtureRows, opts = {}) {
    const calls = [];
    const rows = sortByPk(fixtureRows.slice(), spec.pk);
    const exists = opts.exists !== false;
    const table = opts.table || spec.name;
    const cols = spec.verifyColumns || spec.columns;

    const query = async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes('to_regclass')) {
            return { rows: [{ r: exists ? `public.${table}` : null }] };
        }
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET TIME ZONE')) {
            return { rows: [] };
        }
        if (sql.includes('count(*)::text AS n')) {
            const t = tableOf(sql);
            const tRows = t === table ? rows : [];
            const h = tRows.reduce((a, r) => a + Number(rowHash(r, cols)), 0);
            return { rows: [{ n: String(tRows.length), h: String(h) }] };
        }
        if (sql.includes('hashtextextended') && sql.includes('LIMIT')) {
            // hash page: params = [...cursor?, limit]
            const limit = params[params.length - 1];
            const cursor = params.length > 1 ? params.slice(0, spec.pk.length) : null;
            const page = afterCursor(rows, spec.pk, cursor).slice(0, limit);
            return { rows: page.map((r) => ({ ...pick(r, spec.pk), h: rowHash(r, cols) })) };
        }
        if (sql.includes('hashtextextended') && sql.includes('<=')) {
            // hash range: params = [...cursor?, ...end]
            const end = params.slice(params.length - spec.pk.length);
            const cursor = params.length > spec.pk.length ? params.slice(0, spec.pk.length) : null;
            const page = afterCursor(rows, spec.pk, cursor).filter(
                (r) =>
                    cmpTuple(
                        spec.pk.map((c) => r[c]),
                        end
                    ) <= 0
            );
            return { rows: page.map((r) => ({ ...pick(r, spec.pk), h: rowHash(r, cols) })) };
        }
        if (sql.startsWith('SELECT') && sql.includes('LIMIT')) {
            const limit = params[params.length - 1];
            const cursor = params.length > 1 ? params.slice(0, spec.pk.length) : null;
            return { rows: afterCursor(rows, spec.pk, cursor).slice(0, limit) };
        }
        if (sql.startsWith('SELECT')) {
            return { rows };
        }
        return { rows: [] };
    };
    return { query, calls, rows };
}

const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c]]));

/**
 * Fake writable target for copyTable: applies ON CONFLICT (pk) DO NOTHING by
 * tracking existing pk keys.
 */
export function makeFakeTarget(spec, existingRows = []) {
    const calls = [];
    const store = new Map(existingRows.map((r) => [JSON.stringify(spec.pk.map((c) => r[c])), r]));
    const query = async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.startsWith('INSERT INTO')) {
            const width = spec.columns.length;
            let inserted = 0;
            for (let off = 0; off < params.length; off += width) {
                const row = {};
                spec.columns.forEach((c, i) => {
                    row[c] = params[off + i];
                });
                const key = JSON.stringify(spec.pk.map((c) => row[c]));
                if (!store.has(key)) {
                    store.set(key, row);
                    inserted += 1;
                }
            }
            return { rows: [], rowCount: inserted };
        }
        if (sql.includes('setval')) return { rows: [{ v: '1' }] };
        return { rows: [] };
    };
    return { query, calls, store };
}
