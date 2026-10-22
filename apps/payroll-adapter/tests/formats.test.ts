// Pure format helpers: CLABE checksum, SUA fixed-width records, dispersion file.
import { describe, expect, it } from 'vitest';
import {
    DISPERSION_DETAIL_LEN,
    DISPERSION_HEADER_LEN,
    DISPERSION_TRAILER_LEN,
    SUA_LINE_LEN,
    buildDispersionFile,
    formatSuaLine,
    isValidClabe,
    parseSuaFile,
    parseSuaLine,
    padLeft,
    padRight
} from '../src/formats.js';

// CLABE whose check digit was verified against the mod-10 (3,7,1) algorithm.
const VALID_CLABE = '012345678901234568';

const suaLine = (movement: string, nss: string, ref: string, sbcCents: number, fecha: string) =>
    movement + padLeft(nss, 11) + padRight(ref, 20) + padLeft(sbcCents, 11) + fecha;

describe('isValidClabe', () => {
    it('accepts a well-formed CLABE', () => {
        expect(isValidClabe(VALID_CLABE)).toBe(true);
        expect(isValidClabe('111111111111111115')).toBe(true);
    });

    it('rejects a bad check digit', () => {
        expect(isValidClabe('012345678901234567')).toBe(false);
        expect(isValidClabe('012345678901234560')).toBe(false);
    });

    it('rejects malformed values', () => {
        expect(isValidClabe('0123456789012345')).toBe(false); // 16 digits
        expect(isValidClabe('01234567890123456A')).toBe(false); // non-digit
        expect(isValidClabe('')).toBe(false);
        expect(isValidClabe(null)).toBe(false);
        expect(isValidClabe(undefined)).toBe(false);
    });
});

describe('SUA fixed-width records', () => {
    it('parses a movement line into its fields', () => {
        const line = suaLine('08', '12345678901', 'EMP-42', 75050, '20250114');
        expect(line).toHaveLength(SUA_LINE_LEN);
        expect(parseSuaLine(line, 1)).toEqual({
            movement: '08',
            nss: '12345678901',
            employeeRef: 'EMP-42',
            sbcCents: 75050,
            fecha: '20250114'
        });
    });

    it('round-trips through formatSuaLine', () => {
        const m = { movement: '02' as const, nss: '12345678901', employeeRef: 'E1', sbcCents: 100, fecha: '20250101' };
        expect(parseSuaLine(formatSuaLine(m), 1)).toEqual(m);
    });

    it('rejects unknown movement types and malformed fields with line numbers', () => {
        expect(() => parseSuaLine(suaLine('99', '12345678901', 'E', 1, '20250101'), 3)).toThrow(/line 3.*movement/);
        expect(() => parseSuaLine(suaLine('02', '1234567890A', 'E', 1, '20250101'), 1)).toThrow(/NSS/);
        expect(() => parseSuaLine(suaLine('02', '12345678901', 'E', 1, '2025-101'), 1)).toThrow(/date/);
        expect(() => parseSuaLine('short', 1)).toThrow(/too short/);
    });

    it('parseSuaFile skips blanks and comments', () => {
        const text = [
            '# batch SUA demo',
            '',
            suaLine('02', '12345678901', 'A', 50000, '20250101'),
            suaLine('07', '10987654321', 'B', 0, '20250110')
        ].join('\n');
        const movements = parseSuaFile(text);
        expect(movements).toHaveLength(2);
        expect(movements[0]!.movement).toBe('02');
        expect(movements[1]!.movement).toBe('07');
    });
});

describe('buildDispersionFile', () => {
    const records = [
        { clabe: VALID_CLABE, amountCents: 1208000, ref: 'emp-7' },
        { clabe: '111111111111111115', amountCents: 9950, ref: 'emp-8' }
    ];

    it('emits header, detail and trailer records with fixed lengths', () => {
        const { text, count, totalCents } = buildDispersionFile({
            rfc: 'XAXX010101000',
            fecha: '20250131',
            records
        });
        const lines = text.trimEnd().split('\n');
        expect(lines).toHaveLength(4); // header + 2 details + trailer
        expect(count).toBe(2);
        expect(totalCents).toBe(1217950);

        const [header, d1, d2, trailer] = lines as [string, string, string, string];
        expect(header).toHaveLength(DISPERSION_HEADER_LEN); // 44
        expect(header.startsWith('01XAXX010101000')).toBe(true);
        expect(header.slice(15, 23)).toBe('20250131');
        expect(header.slice(23, 29)).toBe('000002'); // count
        expect(header.slice(29, 44)).toBe('000000001217950'); // total cents

        expect(d1).toHaveLength(DISPERSION_DETAIL_LEN); // 65
        expect(d1.startsWith('02' + VALID_CLABE)).toBe(true);
        expect(d1.slice(20, 35)).toBe('000000001208000');
        expect(d1.slice(35, 65)).toBe('emp-7'.padEnd(30));

        expect(d2.slice(20, 35)).toBe('000000000009950');

        expect(trailer).toHaveLength(DISPERSION_TRAILER_LEN); // 23
        expect(trailer).toBe('03' + '000002' + '000000001217950');
    });

    it('zero-pads a short RFC in the header', () => {
        const { text } = buildDispersionFile({ rfc: 'AAA000101XX1', fecha: '20250131', records: [] });
        const header = text.split('\n')[0]!;
        expect(header.slice(2, 15)).toBe('AAA000101XX1 ');
        expect(header.slice(15, 23)).toBe('20250131');
    });
});
