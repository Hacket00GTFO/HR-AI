/**
 * 0001_notifications — notifications service schema.
 *
 *   notification_templates   (key, locale) → subject/text/html, seeded en+es
 *   notification_logs        one row per send attempt lineage; idempotent on
 *                            idempotency_key; status: queued|sent|failed|suppressed
 *   notification_preferences per (user_id, channel) opt-out; default = allow
 */
exports.up = (pgm) => {
    pgm.sql(`
        CREATE TABLE notification_templates (
            id BIGSERIAL PRIMARY KEY,
            key VARCHAR(120) NOT NULL,
            locale VARCHAR(8) NOT NULL DEFAULT 'en',
            subject VARCHAR(500) NOT NULL,
            body_text TEXT NOT NULL,
            body_html TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (key, locale)
        );

        CREATE TABLE notification_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            idempotency_key VARCHAR(200) UNIQUE,
            to_email VARCHAR(320) NOT NULL,
            template_key VARCHAR(120) NOT NULL,
            locale VARCHAR(8) NOT NULL DEFAULT 'en',
            payload JSONB NOT NULL DEFAULT '{}',
            status VARCHAR(20) NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'sent', 'failed', 'suppressed')),
            error TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TIMESTAMPTZ,
            sent_at TIMESTAMPTZ,
            correlation_id VARCHAR(128),
            user_id INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX notification_logs_queued_idx
            ON notification_logs (next_attempt_at) WHERE status = 'queued';
        CREATE INDEX notification_logs_created_idx
            ON notification_logs (created_at DESC);

        CREATE TABLE notification_preferences (
            user_id INTEGER NOT NULL,
            channel VARCHAR(20) NOT NULL DEFAULT 'email',
            enabled BOOLEAN NOT NULL DEFAULT true,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (user_id, channel)
        );

        -- Seed templates: en + es for every known key.
        INSERT INTO notification_templates (key, locale, subject, body_text, body_html) VALUES
        ('application.received', 'en',
         'We received your application{{#vacancyTitle}} — {{vacancyTitle}}{{/vacancyTitle}}',
         'Hi {{name}},\n\nThanks for applying{{#vacancyTitle}} to {{vacancyTitle}}{{/vacancyTitle}}. Our team will review your application shortly.\n\n— StraforAI',
         '<p>Hi {{name}},</p><p>Thanks for applying{{#vacancyTitle}} to <strong>{{vacancyTitle}}</strong>{{/vacancyTitle}}. Our team will review your application shortly.</p><p>— StraforAI</p>'),
        ('application.received', 'es',
         'Hemos recibido tu solicitud{{#vacancyTitle}} — {{vacancyTitle}}{{/vacancyTitle}}',
         'Hola {{name}},\n\nGracias por postularte{{#vacancyTitle}} a {{vacancyTitle}}{{/vacancyTitle}}. Nuestro equipo revisará tu solicitud pronto.\n\n— StraforAI',
         '<p>Hola {{name}},</p><p>Gracias por postularte{{#vacancyTitle}} a <strong>{{vacancyTitle}}</strong>{{/vacancyTitle}}. Nuestro equipo revisará tu solicitud pronto.</p><p>— StraforAI</p>'),
        ('application.status_changed', 'en',
         'Update on your application: {{status}}',
         'Hi {{name}},\n\nYour application status changed to: {{status}}.\n\n— StraforAI',
         '<p>Hi {{name}},</p><p>Your application status changed to: <strong>{{status}}</strong>.</p><p>— StraforAI</p>'),
        ('application.status_changed', 'es',
         'Actualización de tu solicitud: {{status}}',
         'Hola {{name}},\n\nEl estado de tu solicitud cambió a: {{status}}.\n\n— StraforAI',
         '<p>Hola {{name}},</p><p>El estado de tu solicitud cambió a: <strong>{{status}}</strong>.</p><p>— StraforAI</p>'),
        ('interview.scheduled', 'en',
         'Interview scheduled{{#vacancyTitle}} — {{vacancyTitle}}{{/vacancyTitle}}',
         'Hi {{name}},\n\nYour interview{{#vacancyTitle}} for {{vacancyTitle}}{{/vacancyTitle}} is scheduled for {{scheduledAt}}.\n\n— StraforAI',
         '<p>Hi {{name}},</p><p>Your interview{{#vacancyTitle}} for <strong>{{vacancyTitle}}</strong>{{/vacancyTitle}} is scheduled for <strong>{{scheduledAt}}</strong>.</p><p>— StraforAI</p>'),
        ('interview.scheduled', 'es',
         'Entrevista programada{{#vacancyTitle}} — {{vacancyTitle}}{{/vacancyTitle}}',
         'Hola {{name}},\n\nTu entrevista{{#vacancyTitle}} para {{vacancyTitle}}{{/vacancyTitle}} está programada para {{scheduledAt}}.\n\n— StraforAI',
         '<p>Hola {{name}},</p><p>Tu entrevista{{#vacancyTitle}} para <strong>{{vacancyTitle}}</strong>{{/vacancyTitle}} está programada para <strong>{{scheduledAt}}</strong>.</p><p>— StraforAI</p>'),
        ('auth.password_reset', 'en',
         'Reset your StraforAI password',
         'Hi {{name}},\n\nUse this link to reset your password: {{resetUrl}}\n\nIf you did not request this, ignore this email.\n\n— StraforAI',
         '<p>Hi {{name}},</p><p>Use this link to reset your password: <a href="{{resetUrl}}">{{resetUrl}}</a></p><p>If you did not request this, ignore this email.</p><p>— StraforAI</p>'),
        ('auth.password_reset', 'es',
         'Restablece tu contraseña de StraforAI',
         'Hola {{name}},\n\nUsa este enlace para restablecer tu contraseña: {{resetUrl}}\n\nSi no lo solicitaste, ignora este correo.\n\n— StraforAI',
         '<p>Hola {{name}},</p><p>Usa este enlace para restablecer tu contraseña: <a href="{{resetUrl}}">{{resetUrl}}</a></p><p>Si no lo solicitaste, ignora este correo.</p><p>— StraforAI</p>'),
        ('candidate.feedback_requested', 'en',
         'We would love your feedback',
         'Hi {{name}},\n\nCould you share feedback about your experience? {{feedbackUrl}}\n\n— StraforAI',
         '<p>Hi {{name}},</p><p>Could you share feedback about your experience? <a href="{{feedbackUrl}}">{{feedbackUrl}}</a></p><p>— StraforAI</p>'),
        ('candidate.feedback_requested', 'es',
         'Nos encantaría conocer tu opinión',
         'Hola {{name}},\n\n¿Podrías compartir tu experiencia? {{feedbackUrl}}\n\n— StraforAI',
         '<p>Hola {{name}},</p><p>¿Podrías compartir tu experiencia? <a href="{{feedbackUrl}}">{{feedbackUrl}}</a></p><p>— StraforAI</p>');
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TABLE notification_preferences;
        DROP TABLE notification_logs;
        DROP TABLE notification_templates;
    `);
};
