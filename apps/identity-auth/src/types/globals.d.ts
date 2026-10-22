// Express request augmentation.
// `export {}` makes this file a module so `declare module 'express'` acts as a
// proper augmentation of the resolved @types/express typings rather than an
// ambient shadow that would hide them.
export {};

declare module 'express' {
    interface Request {
        /** Set by @strafor/node-common correlationId middleware. */
        correlationId?: string;
        log?: unknown;
    }
}
