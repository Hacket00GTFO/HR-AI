// Passthrough template for admin email-template test sends.
// The monolith renders the edited template server-side, then delivers the
// rendered result through this key so the SMTP pipeline is exercised
// end-to-end. {{{bodyHtml}}} is a raw (unescaped) variable by design: the
// content is produced server-side, not by the recipient-facing payload.
exports.up = (pgm) => {
    pgm.sql(`
        INSERT INTO notification_templates (key, locale, subject, body_text, body_html) VALUES
        ('admin.test_send', 'en',
         '[TEST] {{subject}}',
         '{{bodyText}}',
         '{{{bodyHtml}}}'),
        ('admin.test_send', 'es',
         '[PRUEBA] {{subject}}',
         '{{bodyText}}',
         '{{{bodyHtml}}}')
        ON CONFLICT (key, locale) DO NOTHING;
    `);
};

exports.down = (pgm) => {
    pgm.sql(`DELETE FROM notification_templates WHERE key = 'admin.test_send';`);
};
