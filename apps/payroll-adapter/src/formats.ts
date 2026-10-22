/**
 * Mexican payroll file formats — CLABE interbancaria dispersion files and a
 * pragmatic fixed-width representation of IMSS SUA movement records.
 *
 * Pure functions only (no I/O) so adapters and routes stay testable.
 */

// ---------------------------------------------------------------------------
// Generic fixed-width helpers
// ---------------------------------------------------------------------------

/** Left-pad/truncate a numeric-ish field (zero-filled by default). */
export function padLeft(value: string | number, width: number, ch = '0'): string {
    const s = String(value);
    return s.length >= width ? s.slice(0, width) : ch.repeat(width - s.length) + s;
}

/** Right-pad/truncate an alphanumeric field (space-filled by default). */
export function padRight(value: string | number, width: number, ch = ' '): string {
    const s = String(value);
    return s.length >= width ? s.slice(0, width) : s + ch.repeat(width - s.length);
}

// ---------------------------------------------------------------------------
// CLABE — Clave Bancaria Estandarizada (ABM): 18 digits, last is a mod-10
// verification digit over the first 17 with cyclic weights 3,7,1.
// ---------------------------------------------------------------------------

const CLABE_WEIGHTS = [3, 7, 1] as const;

export function isValidClabe(clabe: string | null | undefined): clabe is string {
    if (typeof clabe !== 'string' || !/^\d{18}$/.test(clabe)) return false;
    let sum = 0;
    for (let i = 0; i < 17; i++) {
        sum += (Number(clabe[i]) * CLABE_WEIGHTS[i % 3]!) % 10;
    }
    const check = (10 - (sum % 10)) % 10;
    return check === Number(clabe[17]);
}

// ---------------------------------------------------------------------------
// Bank dispersion file — CLABE-interbancaria style layout.
//
// Pragmatic fixed-width layout (documented here; not bank-proprietary):
//
//   Header  '01' | empresa RFC (13, space-padded right)
//                | fecha AAAAMMDD (8)
//                | record count (6, zero-filled)
//                | total in centavos (15, zero-filled)          → 44 chars
//
//   Detail  '02' | CLABE (18 digits)
//                | amount in centavos (15, zero-filled)
//                | employee ref (30, space-padded right)         → 65 chars
//
//   Trailer '03' | record count (6, zero-filled)
//                | total in centavos (15, zero-filled)          → 23 chars
// ---------------------------------------------------------------------------

export const DISPERSION_HEADER_LEN = 44;
export const DISPERSION_DETAIL_LEN = 65;
export const DISPERSION_TRAILER_LEN = 23;

export interface DispersionRecord {
    /** 18-digit CLABE — validated by callers via isValidClabe. */
    clabe: string;
    /** Amount to transfer, in centavos (integer). */
    amountCents: number;
    /** Employee/reference string shown to the bank (≤30 chars). */
    ref: string;
}

export interface DispersionFile {
    text: string;
    count: number;
    totalCents: number;
}

export function buildDispersionFile(opts: {
    rfc: string;
    /** AAAAMMDD */
    fecha: string;
    records: DispersionRecord[];
}): DispersionFile {
    const totalCents = opts.records.reduce((acc, r) => acc + r.amountCents, 0);
    const count = opts.records.length;
    const lines = [
        '01' + padRight(opts.rfc, 13) + opts.fecha + padLeft(count, 6) + padLeft(totalCents, 15),
        ...opts.records.map((r) => '02' + r.clabe + padLeft(r.amountCents, 15) + padRight(r.ref, 30)),
        '03' + padLeft(count, 6) + padLeft(totalCents, 15)
    ];
    return { text: lines.join('\n') + '\n', count, totalCents };
}

// ---------------------------------------------------------------------------
// SUA movements — IMSS Sistema Único de Autodeterminación. The real SUA batch
// file is proprietary/binary; this is the documented fixed-width text
// projection used by the sua_file adapter (IDSE-style movement types):
//
//    1- 2  movement type: '02' alta/reingreso | '07' baja | '08' modif. salario
//    3-13  NSS — número de seguridad social (11 digits)
//   14-33  employee ref (20, space-padded right) — provider-side key
//   34-44  SBC diario in centavos (11 digits, zero-filled)
//   45-52  movement date AAAAMMDD
//                                                                 → 52 chars
//
// Lines that are blank or start with '#' are ignored.
// ---------------------------------------------------------------------------

export const SUA_LINE_LEN = 52;

export type SuaMovementType = '02' | '07' | '08';

export const SUA_MOVEMENT_LABELS: Record<SuaMovementType, string> = {
    '02': 'alta',
    '07': 'baja',
    '08': 'modificacion_salario'
};

export interface SuaMovement {
    movement: SuaMovementType;
    /** 11-digit NSS. */
    nss: string;
    /** Free-form provider employee reference (≤20 chars). */
    employeeRef: string;
    /** Salario base de cotización diario, in centavos. */
    sbcCents: number;
    /** AAAAMMDD */
    fecha: string;
}

/** Parse one SUA movement line. Throws Error with the offending line number. */
export function parseSuaLine(line: string, lineNo: number): SuaMovement {
    const fail = (msg: string): never => {
        throw new Error(`SUA line ${lineNo}: ${msg}`);
    };
    if (line.length < SUA_LINE_LEN) fail(`record too short (${line.length} < ${SUA_LINE_LEN})`);

    const movement = line.slice(0, 2);
    if (movement !== '02' && movement !== '07' && movement !== '08') {
        fail(`unknown movement type '${movement}'`);
    }
    const nss = line.slice(2, 13).trim();
    if (!/^\d{11}$/.test(nss)) fail(`invalid NSS '${nss}' (expected 11 digits)`);

    const employeeRef = line.slice(13, 33).trim();

    const sbcRaw = line.slice(33, 44);
    if (!/^\d{11}$/.test(sbcRaw)) fail(`invalid SBC field '${sbcRaw}' (expected 11 digits)`);

    const fecha = line.slice(44, 52);
    if (!/^\d{8}$/.test(fecha)) fail(`invalid movement date '${fecha}' (expected AAAAMMDD)`);

    return {
        movement: movement as SuaMovementType,
        nss,
        employeeRef,
        sbcCents: Number(sbcRaw),
        fecha
    };
}

/** Serialize a movement to its 52-char fixed-width record. */
export function formatSuaLine(m: SuaMovement): string {
    return m.movement + padLeft(m.nss, 11) + padRight(m.employeeRef, 20) + padLeft(m.sbcCents, 11) + m.fecha;
}

/** Parse a whole SUA movements file, skipping blank lines and '#' comments. */
export function parseSuaFile(text: string): SuaMovement[] {
    const out: SuaMovement[] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.trim() || line.startsWith('#')) continue;
        out.push(parseSuaLine(line, i + 1));
    }
    return out;
}
