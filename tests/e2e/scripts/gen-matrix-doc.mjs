// Fold tests/e2e/.results/*.jsonl into docs/security/role-matrix.md.
//
//   pnpm --filter @strafor/e2e-tests test
//   node scripts/gen-matrix-doc.mjs
//
// Output: one section per suite, one table per case — personas as columns.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(E2E_DIR, '..', '..');
const RESULTS_DIR = path.join(E2E_DIR, '.results');
const OUT = path.join(REPO_ROOT, 'docs', 'security', 'role-matrix.md');

const PERSONA_ORDER = ['anon', 'admin', 'hr', 'manager', 'employee', 'candidate', 'service'];
const VERDICT_MARK = { ok: '✓', tolerated: '△', fail: '✗', error: '!' };

function loadRows() {
    if (!fs.existsSync(RESULTS_DIR)) return [];
    const rows = [];
    for (const f of fs.readdirSync(RESULTS_DIR).sort()) {
        if (!f.endsWith('.jsonl')) continue;
        for (const line of fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                rows.push(JSON.parse(line));
            } catch {
                /* ignore partial lines */
            }
        }
    }
    return rows;
}

const rows = loadRows();
if (rows.length === 0) {
    console.error(`no results under ${RESULTS_DIR} — run the suite first`);
    process.exit(1);
}

const bySuite = new Map();
for (const r of rows) {
    if (!bySuite.has(r.suite)) bySuite.set(r.suite, []);
    bySuite.get(r.suite).push(r);
}

const lines = [
    '# Cross-service role matrix',
    '',
    `Generated from ${rows.length} recorded checks — \`tests/e2e/.results/*.jsonl\`.`,
    'Do not edit by hand; regenerate with `pnpm --filter @strafor/e2e-tests matrix:doc`.',
    '',
    'Marks: ✓ expected status · △ tolerated deviation · ✗ unexpected status · ! transport error.',
    ''
];

for (const [suite, suiteRows] of bySuite) {
    lines.push(`## ${suite}`);
    lines.push('');
    const byCase = new Map();
    for (const r of suiteRows) {
        if (!byCase.has(r.caseId)) byCase.set(r.caseId, []);
        byCase.get(r.caseId).push(r);
    }
    for (const [caseId, caseRows] of byCase) {
        const first = caseRows[0];
        lines.push(`### \`${caseId}\` — ${first.method} ${first.path} (${first.via} → ${first.service})`);
        lines.push('');
        lines.push(`Guard: ${first.guard}`);
        lines.push('');
        lines.push('| Persona | Expected | Actual | Result |');
        lines.push('|---|---|---|---|');
        for (const r of caseRows.sort((a, b) => PERSONA_ORDER.indexOf(a.persona) - PERSONA_ORDER.indexOf(b.persona))) {
            const mark = VERDICT_MARK[r.verdict] ?? '?';
            const note = r.note ? ` — ${r.note}` : '';
            lines.push(`| ${r.persona} | ${r.expected.join('/')} | ${r.actual} | ${mark}${note} |`);
        }
        lines.push('');
    }
}

lines.push('## Summary');
lines.push('');
const counts = { ok: 0, tolerated: 0, fail: 0, error: 0 };
for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
lines.push(`- total checks: ${rows.length}`);
lines.push(`- ok: ${counts.ok} · tolerated: ${counts.tolerated} · fail: ${counts.fail} · error: ${counts.error}`);
lines.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'));
console.log(`wrote ${OUT} — ${rows.length} checks, ${counts.fail} fail(s)`);
process.exit(counts.fail > 0 ? 1 : 0);
