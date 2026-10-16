import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { presignGetUrl } from '../src/s3.js';

const env = {
    DATABASE_URL: 'postgres://postgres:dev@localhost:55433/strafor_documents',
    MINIO_ENDPOINT: 'localhost',
    MINIO_PORT: '59000',
    MINIO_ACCESS_KEY: 'dev',
    MINIO_SECRET_KEY: 'devdevdev',
    MINIO_BUCKET: 'strafor-documents',
    PRESIGN_EXPIRES_SECONDS: '900'
};

describe('presignGetUrl', () => {
    it('generates an offline presigned GET URL (15 min)', async () => {
        const config = loadConfig(env);
        const url = await presignGetUrl(config, 'strafor-documents', 'documents/abc-123/cv.pdf', 'cv.pdf');
        expect(url).toContain('http://localhost:59000/strafor-documents/documents/abc-123/cv.pdf');
        expect(url).toContain('X-Amz-Expires=900');
        expect(url).toContain('X-Amz-Signature=');
        expect(url).toContain('response-content-disposition=attachment');
    });

    it('uses MINIO_PUBLIC_ENDPOINT when configured', async () => {
        const config = loadConfig({
            ...env,
            MINIO_ENDPOINT: 'minio',
            MINIO_PORT: '9000',
            MINIO_PUBLIC_ENDPOINT: 'http://localhost:59000'
        });
        const url = await presignGetUrl(config, 'b', 'k.pdf', 'k.pdf');
        expect(url).toContain('http://localhost:59000/');
        expect(url).not.toContain('minio:9000');
    });
});
