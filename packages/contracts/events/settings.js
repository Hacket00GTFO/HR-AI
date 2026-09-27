const { z } = require('zod');
const { eventEnvelope } = require('./base');

// POST /api/settings/* — company profile or integration config changed.
const SettingsUpdated = eventEnvelope('strafor.settings.updated', 1, z.object({
    scope: z.enum(['company', 'linkedin', 'occ', 'user']),
    updatedBy: z.number().int().positive(),
    // Keys that changed — values are NOT included (they may contain secrets).
    changedKeys: z.array(z.string()).default([])
}).strict());

module.exports = { SettingsUpdated };
