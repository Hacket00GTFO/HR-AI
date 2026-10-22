// Result recording for the role-matrix suite.
//
// Every check() appends one JSONL row to tests/e2e/.results/<suite>.jsonl.
// scripts/gen-matrix-doc.mjs folds them into docs/security/role-matrix.md.
// Vitest runs test files in separate workers, so rows go through the fs.
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS_DIR } from './env.js';
import type { Persona } from './token.js';

export interface ResultRow {
    suite: string;
    caseId: string;
    service: string;
    via: 'gateway' | 'direct';
    method: string;
    path: string;
    guard: string;
    persona: Persona;
    expected: number[];
    tolerated: number[];
    actual: number;
    verdict: 'ok' | 'tolerated' | 'fail' | 'error';
    note: string;
}

/** Reset a suite's result file — call once per suite before running cases. */
export function resetResults(suite: string): void {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(fileFor(suite), '');
}

export function record(row: ResultRow): void {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.appendFileSync(fileFor(row.suite), JSON.stringify(row) + '\n');
}

export function loadResults(): ResultRow[] {
    if (!fs.existsSync(RESULTS_DIR)) return [];
    const rows: ResultRow[] = [];
    for (const f of fs.readdirSync(RESULTS_DIR)) {
        if (!f.endsWith('.jsonl')) continue;
        for (const line of fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                rows.push(JSON.parse(line) as ResultRow);
            } catch {
                /* ignore partial lines */
            }
        }
    }
    return rows;
}

function fileFor(suite: string): string {
    return path.join(RESULTS_DIR, `${suite}.jsonl`);
}
