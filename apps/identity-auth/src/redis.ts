import { Redis } from 'ioredis';
import { logger } from '@strafor/node-common';

let redis: Redis | null = null;
let unavailable = false;

/** Lazily create the client; returns null when REDIS_URL is unset. */
export function getRedis(redisUrl?: string): Redis | null {
    if (redis) return redis;
    if (!redisUrl) return null;
    redis = new Redis(redisUrl, {
        lazyConnect: false,
        maxRetriesPerRequest: 2,
        retryStrategy: (times) => Math.min(times * 500, 5000)
    });
    redis.on('error', (err) => {
        unavailable = true;
        logger.error({ err: err.message }, 'redis error');
    });
    redis.on('connect', () => {
        unavailable = false;
    });
    return redis;
}

const BL_PREFIX = 'bl:';

/** Blacklist an access-token jti for its remaining lifetime (seconds). */
export async function blacklistJti(client: Redis | null, jti: string, ttlSeconds: number): Promise<void> {
    if (!client || ttlSeconds <= 0) return;
    await client.set(`${BL_PREFIX}${jti}`, '1', 'EX', Math.ceil(ttlSeconds));
}

/** True when the jti has been blacklisted (logged out / revoked). */
export async function isBlacklisted(client: Redis | null, jti: string): Promise<boolean> {
    if (!client || unavailable) return false;
    try {
        return (await client.exists(`${BL_PREFIX}${jti}`)) === 1;
    } catch (err) {
        // Fail-closed is safer for revocation: if Redis is down we cannot
        // prove the token is still valid — treat as blacklisted upstream.
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

/** Test hook. */
export function _resetRedis(): void {
    redis = null;
    unavailable = false;
}
