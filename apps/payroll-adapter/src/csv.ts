/**
 * Minimal CSV helpers — enough for payroll import/export without pulling in a
 * dependency. Handles quoted fields, embedded commas/quotes/newlines on parse,
 * and escapes on write. Not a general-purpose CSV engine.
 */

/** Serialize rows of scalar values to CSV (header + rows). */
export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
    const esc = (v: string | number | null | undefined): string => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.map(esc).join(',')];
    for (const row of rows) lines.push(row.map(esc).join(','));
    return lines.join('\n') + '\n';
}

/** Parse CSV text into an array of records keyed by the header row. */
export function parseCsv(text: string): Array<Record<string, string>> {
    const rows: string[][] = [];
    let field = '';
    let row: string[] = [];
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field);
            field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            field = '';
            if (row.length > 1 || row[0] !== '') rows.push(row);
            row = [];
        } else {
            field += c;
        }
    }
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);

    if (rows.length === 0) return [];
    const header = rows[0]!.map((h) => h.trim());
    return rows.slice(1).map((r) => {
        const rec: Record<string, string> = {};
        header.forEach((h, idx) => {
            rec[h] = r[idx] ?? '';
        });
        return rec;
    });
}
