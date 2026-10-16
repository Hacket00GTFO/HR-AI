// Exponential backoff helper — delay = baseMs * 2^(attempt-1).
// `sleep` is injectable so tests never wait on real timers.

export interface RetryOptions {
    /** Extra attempts after the first failure (0 = no retries). */
    retries: number;
    baseMs: number;
    sleep?: (ms: number) => Promise<void>;
    /** Return false to give up immediately on non-transient errors. */
    retryable?: (err: unknown) => boolean;
    onRetry?: (attempt: number, err: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
    const sleep = opts.sleep ?? defaultSleep;
    let attempt = 0;
    for (;;) {
        try {
            return await fn();
        } catch (err) {
            const canRetry = attempt < opts.retries && (opts.retryable ? opts.retryable(err) : true);
            if (!canRetry) throw err;
            attempt += 1;
            opts.onRetry?.(attempt, err);
            await sleep(opts.baseMs * 2 ** (attempt - 1));
        }
    }
}
