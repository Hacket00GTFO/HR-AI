/**
 * 0014_email_templates — email template editor feature.
 *
 * Stores editable email templates plus a full version history so changes can
 * be audited and rolled back. Seed templates are inserted idempotently.
 */
exports.up = (pgm) => {
    // ---- email_templates ----
    pgm.createTable('email_templates', {
        id: 'id',
        name: { type: 'varchar(120)', notNull: true, unique: true },
        subject: { type: 'varchar(255)', notNull: true },
        html_body: { type: 'text', notNull: true },
        text_body: { type: 'text' },
        variables: { type: 'jsonb', default: pgm.func("'{}'::jsonb") },
        locale: { type: 'varchar(5)', default: "'en'" },
        version: { type: 'integer', default: 1 },
        updated_by: { type: 'integer' },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });

    // ---- email_template_versions ----
    pgm.createTable('email_template_versions', {
        id: 'bigserial',
        template_id: {
            type: 'integer',
            notNull: true,
            references: 'email_templates(id)'
        },
        version: { type: 'integer', notNull: true },
        subject: { type: 'varchar(255)' },
        html_body: { type: 'text' },
        text_body: { type: 'text' },
        changed_by: { type: 'integer' },
        changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });
    pgm.createIndex('email_template_versions', ['template_id', 'version']);

    // ---- seed initial templates ----
    pgm.sql(`
        INSERT INTO email_templates (name, subject, html_body, variables, locale) VALUES
            ('welcome', 'Welcome to StraforAI', '<h1>Welcome {{name}}</h1><p>Your account is ready.</p>', '["name"]', 'en'),
            ('application_received', 'Application Received', '<h1>Hi {{candidateName}}</h1><p>We received your application for {{vacancyTitle}}.</p>', '["candidateName","vacancyTitle"]', 'en'),
            ('interview_scheduled', 'Interview Scheduled', '<h1>Hi {{candidateName}}</h1><p>Your interview for {{vacancyTitle}} is scheduled for {{interviewDate}}.</p>', '["candidateName","vacancyTitle","interviewDate"]', 'en'),
            ('password_reset', 'Reset Your Password', '<h1>Reset Password</h1><p>Click <a href="{{resetUrl}}">here</a> to reset your password.</p>', '["resetUrl"]', 'en')
        ON CONFLICT (name) DO NOTHING;
    `);
};

exports.down = (pgm) => {
    pgm.dropTable('email_template_versions', { ifExists: true });
    pgm.dropTable('email_templates', { ifExists: true });
};
