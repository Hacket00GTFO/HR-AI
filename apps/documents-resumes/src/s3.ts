import {
    CreateBucketCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadBucketCommand,
    PutObjectCommand,
    S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from './config.js';

export function createS3Client(config: ServiceConfig): S3Client {
    const protocol = config.MINIO_USE_SSL ? 'https' : 'http';
    return new S3Client({
        endpoint: `${protocol}://${config.MINIO_ENDPOINT}:${config.MINIO_PORT}`,
        region: 'us-east-1', // MinIO ignores region but the SDK requires one
        forcePathStyle: true, // required for MinIO
        credentials: {
            accessKeyId: config.MINIO_ACCESS_KEY,
            secretAccessKey: config.MINIO_SECRET_KEY
        }
    });
}

/** Verify the bucket exists; create it when MINIO_AUTOCREATE is on. */
export async function ensureBucket(
    client: S3Client,
    bucket: string,
    autocreate: boolean,
    log: ServiceLogger
): Promise<void> {
    try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        return;
    } catch (err) {
        if (!autocreate) throw err;
        log.warn({ bucket }, 'S3 bucket missing — creating (MINIO_AUTOCREATE=true)');
    }
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
}

export async function putObject(
    client: S3Client,
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string
): Promise<void> {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function getObjectBuffer(client: S3Client, bucket: string, key: string): Promise<Buffer> {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!out.Body) throw new Error(`S3 object ${key} has no body`);
    return Buffer.from(await out.Body.transformToByteArray());
}

export async function deleteObject(client: S3Client, bucket: string, key: string): Promise<void> {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Presign a GET URL. When MINIO_PUBLIC_ENDPOINT is set the signature is
 * generated against a client configured with the public host so the URL is
 * valid for browsers outside the cluster.
 */
export async function presignGetUrl(
    config: ServiceConfig,
    bucket: string,
    key: string,
    downloadName: string
): Promise<string> {
    const client = config.MINIO_PUBLIC_ENDPOINT
        ? new S3Client({
              endpoint: config.MINIO_PUBLIC_ENDPOINT,
              region: 'us-east-1',
              forcePathStyle: true,
              credentials: {
                  accessKeyId: config.MINIO_ACCESS_KEY,
                  secretAccessKey: config.MINIO_SECRET_KEY
              }
          })
        : createS3Client(config);
    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${downloadName}"`
    });
    return getSignedUrl(client, command, { expiresIn: config.PRESIGN_EXPIRES_SECONDS });
}
