// Test fixture builders — no external deps.

/** Minimal but well-formed single-page PDF containing `text`. */
export function makePdf(text: string): Buffer {
    const escaped = text.replace(/[\\()]/g, (c) => `\\${c}`);
    const objects: Record<number, string> = {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        4: '',
        5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    };
    const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
    objects[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let i = 1; i <= 5; i++) {
        offsets[i] = Buffer.byteLength(out, 'latin1');
        out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefStart = Buffer.byteLength(out, 'latin1');
    out += 'xref\n0 6\n0000000000 65535 f \n';
    for (let i = 1; i <= 5; i++) {
        out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

// --- minimal store-only ZIP writer (enough for a valid .docx) ---

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (const b of buf) crc = (CRC_TABLE[(crc ^ b) & 0xff] as number) ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

export function makeZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
    const chunks: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(0, 8); // method: stored
        local.writeUInt16LE(0, 10); // mod time
        local.writeUInt16LE(0, 12); // mod date
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28); // extra len
        chunks.push(local, nameBuf, data);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(data.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([cd, nameBuf]));

        offset += 30 + nameBuf.length + data.length;
    }

    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);

    return Buffer.concat([...chunks, cdBuf, eocd]);
}

/** Minimal valid DOCX (word/document.xml with a single paragraph). */
export function makeDocx(text: string): Buffer {
    const xml = (s: string) => Buffer.from(s, 'utf8');
    return makeZip([
        {
            name: '[Content_Types].xml',
            data: xml(
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
                    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
                    '<Default Extension="xml" ContentType="application/xml"/>' +
                    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
                    '</Types>'
            )
        },
        {
            name: '_rels/.rels',
            data: xml(
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
                    '</Relationships>'
            )
        },
        {
            name: 'word/document.xml',
            data: xml(
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
                    `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
            )
        }
    ]);
}
