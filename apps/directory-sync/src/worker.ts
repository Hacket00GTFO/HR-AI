// Interval worker: runs the sync cycle on boot, then re-schedules itself
// SYNC_INTERVAL_MS after the previous run FINISHES (never overlaps).
import type { ServiceLogger } from '@strafor/node-common';

export interface WorkerState {
    running: boolean;
    lastFinishedAt: number | null;
    cycles: number;
}

export interface Worker {
    state: WorkerState;
    start(): void;
    stop(): void;
}

export function createWorker(opts: { intervalMs: number; run: () => Promise<unknown>; log: ServiceLogger }): Worker {
    const state: WorkerState = { running: false, lastFinishedAt: null, cycles: 0 };
    let timer: NodeJS.Timeout | null = null;
    let stopped = false;

    const tick = async (): Promise<void> => {
        if (stopped) return;
        state.running = true;
        try {
            await opts.run();
        } catch (err) {
            // runSyncCycle swallows step errors; this is a last-resort guard.
            opts.log.error({ err: err instanceof Error ? err.message : String(err) }, 'sync cycle crashed');
        } finally {
            state.running = false;
            state.lastFinishedAt = Date.now();
            state.cycles += 1;
            if (!stopped) {
                timer = setTimeout(() => void tick(), opts.intervalMs);
                timer.unref();
            }
        }
    };

    return {
        state,
        start() {
            stopped = false;
            void tick();
        },
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
        }
    };
}
