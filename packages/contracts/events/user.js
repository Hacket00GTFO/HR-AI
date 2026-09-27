const { z } = require('zod');
const { eventEnvelope } = require('./base');

// POST /api/auth/register — an admin created an HR/admin account.
const UserRegistered = eventEnvelope('strafor.user.registered', 1, z.object({
    userId: z.number().int().positive(),
    email: z.string().email(),
    role: z.enum(['admin', 'hr']),
    registeredBy: z.number().int().positive().optional()
}).strict());

module.exports = { UserRegistered };
