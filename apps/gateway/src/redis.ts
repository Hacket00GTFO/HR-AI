import { Redis } from 'ioredis';
import { logger } from '@strafor/node-common';

let redis: Redis | null = null;

export function getRedis(redisUrl?: string): Redis | null {
    if (redis) return redis;
    if (!redisUrl) return null;
    redis = new Redis(redisUrl, {
        lazyConnect: false,
        maxRetriesPerRequest: 2,
        retryStrategy: (times) => Math.min(times * 500, 5000)
    });
    redis.on('error', (err) => logger.error({ err: err.message }, 'redis error'));
    return redis;
}

/** True when the access-token jti has been blacklisted (bl:<jti>). */
export async function isBlacklisted(client: Redis | null, jti: string | undefined): Promise<boolean> {
    if (!client || !jti) return false;
    try {
        return (await client.exists(`bl:${jti}`)) === 1;
    } catch (err) {
        // Fail-open for availability, but log loudly — revocation enforcement
        // degrades while Redis is down.
        logger.error({ err: (err as Error).message }, 'redis blacklist check failed');
        return false;
    }
}

export async function shutdownRedis(): Promise<void> {
    if (redis) {
        const r = redis;
        redis = null;
        r.disconnect();
    }
}

export function _resetRedis(): void {
    redis = null;
}
