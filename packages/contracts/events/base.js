// Shared event envelope. Every StraforAI domain event is:
//   { type, version, occurredAt, correlationId, payload }
// - type:          reverse-domain event name, e.g. "strafor.vacancy.published"
// - version:       schema version of payload (bump on breaking changes)
// - occurredAt:    ISO-8601 timestamp of when the fact happened
// - correlationId: propagated X-Correlation-Id / trace id (see @strafor/node-common)
const { z } = require('zod');

const eventEnvelope = (type, version, payloadSchema) =>
    z.object({
        type: z.literal(type),
        version: z.literal(version),
        occurredAt: z.string().datetime({ offset: true }),
        correlationId: z.string().uuid(),
        payload: payloadSchema
    }).strict();

module.exports = { eventEnvelope };
