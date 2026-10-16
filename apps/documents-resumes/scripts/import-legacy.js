/**
 * import-legacy.js — one-shot migration of the monolith's on-disk resume
 * storage into this service (S3 + `documents` rows).
 *
 *   LEGACY_RESUMES_DIR=<path> DATABASE_URL=... MINIO_*=... node scripts/import-legacy.js
 *
 * For every *.pdf / *.docx file found:
 *   1. sha256-hash the content; skip files already imported (dedupe)
 *   2. upload to S3 under documents/<uuid>/<safe-name>
 *   3. insert a `documents` row (status 'uploaded') + enqueue a parse job
 *
 * Writes a filename → documentId map to
 * infra/seed-data/legacy-resume-map.json (override with IMPORT_MAP_OUT) for
 * the candidates service to link owner_candidate_id later.
 *
 * Read-only on LEGACY_RESUMES_DIR — never mutates the source files.
 */
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const ALLOWED_EXT = new Set(['.pdf', '.docx']);
const MIME_BY_EXT = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

const LEGACY_DIR =
    process.env.LEGACY_RESUMES_DIR || path.join(__dirname, '..', '..', '..', 'secure_uploads', 'resumes');
const MAP_OUT =
    process.env.IMPORT_MAP_OUT ||
    path.join(__dirname, '..', '..', '..', 'infra', 'seed-data', 'legacy-resume-map.json');

function sanitizeFilename(name, ext) {
    const base = path
        .basename(name)
        .replace(/[^A-Za-z0-9._ -]/g, '_')
        .replace(/^\.+/, '')
        .trim();
    const limited = base.slice(0, 200) || `document${ext}`;
    return limited.toLowerCase().endsWith(ext) ? limited : `${limited}${ext}`;
}

async function main() {
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is required');
        process.exit(1);
    }
    if (!fs.existsSync(LEGACY_DIR)) {
        console.error(`LEGACY_RESUMES_DIR does not exist: ${LEGACY_DIR}`);
        process.exit(1);
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const protocol = process.env.MINIO_USE_SSL === 'true' ? 'https' : 'http';
    const bucket = process.env.MINIO_BUCKET || 'strafor-documents';
    const s3 = new S3Client({
        endpoint: `${protocol}://${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || 9000}`,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: {
            accessKeyId: process.env.MINIO_ACCESS_KEY || '',
            secretAccessKey: process.env.MINIO_SECRET_KEY || ''
        }
    });

    try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
        if (process.env.MINIO_AUTOCREATE === 'true') {
            await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        } else {
            throw new Error(`S3 bucket ${bucket} is not reachable`);
        }
    }

    const files = fs.readdirSync(LEGACY_DIR).filter((f) => ALLOWED_EXT.has(path.extname(f).toLowerCase()));
    console.log(`Found ${files.length} legacy resume file(s) in ${LEGACY_DIR}`);

    const map = {};
    for (const file of files) {
        const filePath = path.join(LEGACY_DIR, file);
        const buffer = fs.readFileSync(filePath);
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

        const existing = await pool.query('SELECT id FROM documents WHERE sha256 = $1 AND deleted_at IS NULL', [
            sha256
        ]);
        if (existing.rows[0]) {
            map[file] = { documentId: existing.rows[0].id, deduplicated: true };
            console.log(`skip (dup) ${file} -> ${existing.rows[0].id}`);
            continue;
        }

        const ext = path.extname(file).toLowerCase();
        const safeName = sanitizeFilename(file, ext);
        const id = crypto.randomUUID();
        const s3Key = `documents/${id}/${safeName}`;
        await s3.send(
            new PutObjectCommand({
                Bucket: bucket,
                Key: s3Key,
                Body: buffer,
                ContentType: MIME_BY_EXT[ext]
            })
        );
        await pool.query(
            `INSERT INTO documents
                (id, owner_candidate_id, kind, original_name, mime, size_bytes, sha256, s3_key, status)
             VALUES ($1, NULL, 'resume', $2, $3, $4, $5, $6, 'uploaded')`,
            [id, safeName, MIME_BY_EXT[ext], buffer.length, sha256, s3Key]
        );
        await pool.query('INSERT INTO jobs (type, payload) VALUES ($1, $2)', [
            'parse',
            JSON.stringify({ documentId: id })
        ]);
        map[file] = { documentId: id, deduplicated: false };
        console.log(`imported ${file} -> ${id}`);
    }

    fs.mkdirSync(path.dirname(MAP_OUT), { recursive: true });
    fs.writeFileSync(MAP_OUT, JSON.stringify(map, null, 4) + '\n');
    console.log(`Wrote ${Object.keys(map).length} mapping(s) to ${MAP_OUT}`);

    await pool.end();
}

main().catch((err) => {
    console.error('Import failed:', err);
    process.exit(1);
});
