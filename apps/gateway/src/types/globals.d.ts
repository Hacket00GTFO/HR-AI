// Express request augmentation — `export {}` makes this file a module so the
// declaration merges with the resolved @types/express typings.
export {};

declare module 'express' {
    interface Request {
        /** Set by @strafor/node-common correlationId middleware. */
        correlationId?: string;
        log?: unknown;
    }
}
