const { z } = require('zod');
const { eventEnvelope } = require('./base');

// Identity service events (apps/identity-auth → RabbitMQ `domain.events`).
// UserRegistered lives in ./user.js (legacy surface); these are the full set
// published by the extracted service.

// POST /v1/auth/register + POST /v1/users — an admin created an account.
const UserRegistered = eventEnvelope(
    'strafor.user.registered',
    1,
    z
        .object({
            userId: z.number().int().positive(),
            email: z.string().email(),
            role: z.enum(['admin', 'hr']),
            registeredBy: z.number().int().positive().optional()
        })
        .strict()
);

// PUT /v1/users/:id — profile fields changed.
// changedKeys only — values are NOT included (may contain PII).
const UserUpdated = eventEnvelope(
    'strafor.user.updated',
    1,
    z
        .object({
            userId: z.number().int().positive(),
            changedKeys: z.array(z.string()).default([]),
            updatedBy: z.number().int().positive().optional()
        })
        .strict()
);

// POST /v1/auth/logout — access-token jti blacklisted, refresh family revoked.
const UserLoggedOut = eventEnvelope(
    'strafor.user.logged_out',
    1,
    z
        .object({
            userId: z.number().int().positive()
        })
        .strict()
);

module.exports = { UserRegistered, UserUpdated, UserLoggedOut };
