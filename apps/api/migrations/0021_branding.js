exports.up = (pgm) => {
    pgm.createTable('branding_config', {
        id: 'id',
        logo_url: { type: 'text' },
        primary_color: { type: 'varchar(7)', default: pgm.func("'#FF6B4A'") },
        secondary_color: { type: 'varchar(7)', default: pgm.func("'#1A1F36'") },
        font_family: { type: 'varchar(100)', default: pgm.func("'Inter'") },
        custom_domain: { type: 'varchar(255)' },
        custom_css: { type: 'text' },
        updated_by: { type: 'integer' },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });

    pgm.sql('ALTER TABLE branding_config ADD CONSTRAINT branding_config_singleton_check ' + 'CHECK (id = 1)');

    pgm.sql('INSERT INTO branding_config (id) VALUES (1) ON CONFLICT DO NOTHING;');
};

exports.down = (pgm) => {
    pgm.dropTable('branding_config');
};
