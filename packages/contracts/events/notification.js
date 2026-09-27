const { z } = require('zod');
const { eventEnvelope } = require('./base');

const notificationBase = {
    notificationId: z.string().min(1),
    channel: z.enum(['email', 'webhook', 'in_app']),
    recipient: z.string().min(1),
    template: z.string().optional()
};

// Raised by any service (or consumed off the bus) to request a templated
// notification — the notifications service maps it to a queued send.
const NotificationRequested = eventEnvelope(
    'strafor.notification.requested',
    1,
    z
        .object({
            channel: z.enum(['email', 'webhook', 'in_app']).default('email'),
            recipient: z.string().min(1),
            template: z.string().min(1),
            payload: z.record(z.string(), z.unknown()).default({}),
            locale: z.enum(['en', 'es']).default('en'),
            idempotencyKey: z.string().min(1).optional()
        })
        .strict()
);

// Emitted by the notifications service once the message was handed to SMTP.
const NotificationSent = eventEnvelope(
    'strafor.notification.sent',
    1,
    z
        .object({
            ...notificationBase,
            sentAt: z.string().datetime({ offset: true })
        })
        .strict()
);

const NotificationFailed = eventEnvelope(
    'strafor.notification.failed',
    1,
    z
        .object({
            ...notificationBase,
            reason: z.string().min(1),
            retryable: z.boolean().default(false)
        })
        .strict()
);

module.exports = { NotificationRequested, NotificationSent, NotificationFailed };
