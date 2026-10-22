#!/usr/bin/env node
/**
 * backfill-recruitment — copy recruitment tables from the monolith DB
 * (`innovation`) to the recruitment-core DB (`strafor_recruitment`).
 *
 * Usage:
 *   node run.js --mode=copy   [--batch=1000] [--truncate] [--tables=a,b] [--skip=x] [--dry-run]
 *   node run.js --mode=verify [--tables=a,b] [--diff-limit=50] [--dry-run]
 *
 * Connection strings (CLI flag wins over env over default):
 *   --source=…  or SOURCE_DATABASE_URL  (default postgres://…@db:5432/innovation)
 *   --target=…  or TARGET_DATABASE_URL  (default postgres://…@db:5432/strafor_recruitment)
 *   POSTGRES_USER / POSTGRES_PASSWORD feed the default URLs when set.
 *
 * Modes:
 *   copy   — batched keyset-paginated INSERT … ON CONFLICT (pk) DO NOTHING;
 *            idempotent and resumable (re-run skips existing rows). Per-batch
 *            transactions; table order is FK-safe (plan.js). --truncate wipes
 *            the target tables first (TRUNCATE … RESTART IDENTITY CASCADE).
 *   verify — per-table row count + order-independent row-hash checksum, source
 *            vs target; lists divergent PKs on mismatch; exits non-zero.
 *
 * Dry run prints the plan (and source counts when reachable) and exits 0.
 */
const { Pool } = require('pg');
const { TABLES, TARGET_ONLY, byName, sourceTable } = require('./lib/plan');
const { redact, quoteIdent } = require('./lib/db');
const { copyTable, fixSequences } = require('./lib/copy');
const { verifyTable, pinUtc } = require('./lib/verify');

const log = (msg) => console.log(`[backfill] ${msg}`);

function parseArgs(argv) {
    const opts = {
        mode: 'copy',
        batch: 1000,
        dryRun: false,
        truncate: false,
        tables: null,
        skip: new Set(),
        diffLimit: 50,
        source: null,
        target: null,
        help: false
    };
    for (const arg of argv) {
        if (arg === '--dry-run') opts.dryRun = true;
        else if (arg === '--truncate') opts.truncate = true;
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else if (arg.startsWith('--mode=')) opts.mode = arg.slice(7);
        else if (arg.startsWith('--batch=')) opts.batch = parseInt(arg.slice(8), 10);
        else if (arg.startsWith('--tables=')) opts.tables = arg.slice(9).split(',').filter(Boolean);
        else if (arg.startsWith('--skip=')) opts.skip = new Set(arg.slice(7).split(',').filter(Boolean));
        else if (arg.startsWith('--diff-limit=')) opts.diffLimit = parseInt(arg.slice(13), 10);
        else if (arg.startsWith('--source=')) opts.source = arg.slice(9);
        else if (arg.startsWith('--target=')) opts.target = arg.slice(9);
        else throw new Error(`Unknown argument: ${arg} (try --help)`);
    }
    if (!opts.batch || opts.batch < 1) throw new Error('--batch must be a positive integer');
    return opts;
}

function defaultUrls() {
    const user = process.env.POSTGRES_USER || 'strafor';
    const pass = process.env.POSTGRES_PASSWORD || 'strafor';
    return {
        source: `postgres://${user}:${pass}@db:5432/innovation`,
        target: `postgres://${user}:${pass}@db:5432/strafor_recruitment`
    };
}

function resolvePlan(opts) {
    let specs = TABLES.slice();
    if (opts.tables) {
        for (const name of opts.tables) {
            if (!byName.has(name)) throw new Error(`Unknown table in --tables: ${name}`);
        }
        const wanted = new Set(opts.tables);
        specs = specs.filter((s) => wanted.has(s.name));
    }
    specs = specs.filter((s) => !opts.skip.has(s.name) && !opts.skip.has(sourceTable(s)));
    return specs;
}

function printPlan(opts, specs, counts) {
    log(`mode=${opts.mode} batch=${opts.batch} dry-run=${opts.dryRun}`);
    log(`source: ${redact(opts.source)}`);
    log(`target: ${redact(opts.target)}`);
    if (opts.truncate) log('  (--truncate) target tables will be TRUNCATEd first');
    log('plan (FK-safe order):');
    specs.forEach((spec, i) => {
        const src = sourceTable(spec);
        const cnt = counts && counts[spec.name] != null ? ` — ${counts[spec.name]} source rows` : '';
        const seq = spec.sequence ? ` seq:${spec.sequence}` : '';
        const opt = spec.optional ? ' optional' : '';
        log(
            `  ${i + 1}. ${src} → ${spec.name} (${spec.columns.length} cols, pk:${spec.pk.join(',')}${seq}${opt})${cnt}`
        );
    });
    log(`never copied (target-owned): ${TARGET_ONLY.join(', ')}`);
}

async function sourceCounts(src, specs) {
    const counts = {};
    for (const spec of specs) {
        try {
            const { rows } = await src.query(`SELECT count(*)::text AS n FROM ${quoteIdent(sourceTable(spec))}`);
            counts[spec.name] = rows[0].n;
        } catch {
            counts[spec.name] = 'n/a';
        }
    }
    return counts;
}

async function runCopy(specs, srcPool, dstPool, opts) {
    const dst = await dstPool.connect();
    try {
        if (opts.truncate) {
            const names = specs.map((s) => quoteIdent(s.name)).join(', ');
            log(`truncating target tables: ${names}`);
            await dst.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
        }
    } finally {
        dst.release();
    }

    const results = [];
    for (const spec of specs) {
        log(`copying ${sourceTable(spec)} → ${spec.name}`);
        const dstClient = await dstPool.connect();
        try {
            results.push(await copyTable(spec, srcPool, dstClient, { batchSize: opts.batch, log }));
        } finally {
            dstClient.release();
        }
    }

    log('resetting sequences on target:');
    const seqClient = await dstPool.connect();
    try {
        const done = specs.filter((s, i) => !results[i].skipped);
        await fixSequences(done, seqClient, log);
    } finally {
        seqClient.release();
    }

    const total = results.reduce((a, r) => a + r.copied, 0);
    log(
        `summary: ${results.map((r) => `${r.table}=${r.skipped ? 'skipped' : r.copied}`).join(' ')} | total=${total} rows`
    );
    return results;
}

async function runVerify(specs, srcPool, dstPool, opts) {
    const src = await srcPool.connect();
    const dst = await dstPool.connect();
    const results = [];
    try {
        await Promise.all([pinUtc(src), pinUtc(dst)]);
        for (const spec of specs) {
            results.push(await verifyTable(spec, src, dst, { log, diffLimit: opts.diffLimit }));
        }
    } finally {
        src.release();
        dst.release();
    }
    const failed = results.filter((r) => !r.ok);
    log(`summary: ${results.map((r) => `${r.table}=${r.skipped ? 'skipped' : r.ok ? 'ok' : 'MISMATCH'}`).join(' ')}`);
    if (failed.length) {
        log(`verify FAILED for: ${failed.map((r) => r.table).join(', ')}`);
        return 1;
    }
    log('verify PASSED');
    return 0;
}

const HELP = `backfill-recruitment — innovation → strafor_recruitment data copy

  --mode=copy|verify   operation (default: copy)
  --dry-run            print the plan (with source counts when reachable) and exit
  --batch=N            rows per batch (default 1000)
  --truncate           TRUNCATE target tables before copying (fresh load)
  --tables=a,b         only these tables
  --skip=a,b           skip these tables
  --diff-limit=N       max divergent PKs listed per table in verify (default 50)
  --source=URL         source DATABASE_URL (or SOURCE_DATABASE_URL env)
  --target=URL         target DATABASE_URL (or TARGET_DATABASE_URL env)
`;

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        process.stdout.write(HELP);
        return 0;
    }
    if (opts.mode !== 'copy' && opts.mode !== 'verify') {
        throw new Error(`Unknown --mode=${opts.mode} (expected copy|verify)`);
    }

    const defs = defaultUrls();
    opts.source = opts.source || process.env.SOURCE_DATABASE_URL || defs.source;
    opts.target = opts.target || process.env.TARGET_DATABASE_URL || defs.target;

    const specs = resolvePlan(opts);

    if (opts.dryRun) {
        // Try to enrich the plan with live source counts; fall back to the
        // static plan when the source is unreachable.
        let counts = null;
        const probe = new Pool({ connectionString: opts.source, connectionTimeoutMillis: 3000, max: 1 });
        try {
            counts = await sourceCounts(probe, specs);
        } catch (err) {
            log(`note: source unreachable for counts (${err.message})`);
        } finally {
            await probe.end().catch(() => {});
        }
        printPlan(opts, specs, counts);
        log('dry-run: no changes made.');
        return 0;
    }

    printPlan(opts, specs, null);
    const srcPool = new Pool({ connectionString: opts.source, max: 2 });
    const dstPool = new Pool({ connectionString: opts.target, max: 2 });
    try {
        if (opts.mode === 'copy') {
            await runCopy(specs, srcPool, dstPool, opts);
            return 0;
        }
        return await runVerify(specs, srcPool, dstPool, opts);
    } finally {
        await srcPool.end().catch(() => {});
        await dstPool.end().catch(() => {});
    }
}

if (require.main === module) {
    main()
        .then((code) => process.exit(code))
        .catch((err) => {
            console.error(`[backfill] ERROR: ${err.message}`);
            process.exit(1);
        });
}

module.exports = { parseArgs, defaultUrls, resolvePlan };
