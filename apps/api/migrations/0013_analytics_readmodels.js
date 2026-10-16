exports.up = (pgm) => {
    pgm.createTable('analytics_daily', {
        date: { type: 'date', notNull: true },
        metric: { type: 'varchar(50)', notNull: true },
        value: { type: 'integer', notNull: true, default: 0 },
        dimensions: { type: 'jsonb', default: '{}' }
    });

    pgm.addConstraint('analytics_daily', 'analytics_daily_pkey', {
        primaryKey: ['date', 'metric']
    });

    pgm.createTable('analytics_funnel', {
        date: { type: 'date', notNull: true },
        stage: { type: 'varchar(50)', notNull: true },
        count: { type: 'integer', notNull: true, default: 0 }
    });

    pgm.addConstraint('analytics_funnel', 'analytics_funnel_pkey', {
        primaryKey: ['date', 'stage']
    });
};

exports.down = (pgm) => {
    pgm.dropTable('analytics_funnel');
    pgm.dropTable('analytics_daily');
};
