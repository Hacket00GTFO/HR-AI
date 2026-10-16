import type { Redis } from 'ioredis';
import type { Store } from 'express-rate-limit';
import { logger } from '@strafor/node-common';

interface IncrementResult {
    totalHits: number;
    resetTime: Date;
}

/**
 * Minimal express-rate-limit Store backed by Redis INCR + PEXPIRE.
 * Keys are namespaced per limiter instance via `prefix`.
 */
export class RedisRateLimitStore implements Store {
    private windowMs = 60000;

    constructor(
        private readonly client: Redis,
        /** Key namespace — part of the express-rate-limit Store contract. */
        public readonly prefix: string
    ) {}

    init(options: { windowMs: number }): void {
        this.windowMs = options.windowMs;
    }

    async increment(key: string): Promise<IncrementResult> {
        const k = `${this.prefix}${key}`;
        const results = await this.client.multi().incr(k).pttl(k).exec();
        const hits = Number(results?.[0]?.[1] ?? 1);
        const pttl = Number(results?.[1]?.[1] ?? -1);
        if (pttl < 0) {
            await this.client.pexpire(k, this.windowMs);
        }
        return {
            totalHits: hits,
            resetTime: new Date(Date.now() + (pttl > 0 ? pttl : this.windowMs))
        };
    }

    async decrement(key: string): Promise<void> {
        try {
            await this.client.decr(`${this.prefix}${key}`);
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'rate-limit decrement failed');
        }
    }

    async resetKey(key: string): Promise<void> {
        await this.client.del(`${this.prefix}${key}`);
    }
}
