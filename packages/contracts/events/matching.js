const { z } = require('zod');
const { eventEnvelope } = require('./base');

// Emitted by the ai-matching service (apps/ai-matching) after POST /v1/score
// persists a match_scores row. `score` is on the 0-100 scale for backwards
// compatibility with consumers of the legacy AI_model matcher.
const MatchScoreComputed = eventEnvelope(
    'strafor.matching.score_computed',
    1,
    z
        .object({
            candidateId: z.number().int().positive(),
            vacancyId: z.number().int().positive(),
            score: z.number().min(0).max(100),
            modelVersion: z.string().optional(),
            source: z.enum(['rule_based', 'hybrid', 'llm_rerank']).optional(),
            breakdown: z
                .object({
                    skills: z.number().optional(),
                    experience: z.number().optional(),
                    education: z.number().optional(),
                    location: z.number().optional()
                })
                .partial()
                .optional()
        })
        .strict()
);

// Emitted when a candidate/vacancy embedding row is (re)computed and stored
// in candidate_embeddings / vacancy_embeddings.
const EmbeddingUpdated = eventEnvelope(
    'strafor.matching.embedding_updated',
    1,
    z
        .object({
            entity: z.enum(['candidate', 'vacancy']),
            ownerId: z.number().int().positive(),
            modelVersion: z.string()
        })
        .strict()
);

// Emitted by POST /v1/eval/run after an evaluation run completes. `metrics`
// carries the macro-averaged metric set (ndcg_at_*, precision_at_*,
// recall_at_*, mrr, auc) — keys are metric names, values may be null when a
// metric is undefined for the dataset.
const EvalRunCompleted = eventEnvelope(
    'strafor.matching.eval_run_completed',
    1,
    z
        .object({
            dataset: z.string().nullable().optional(),
            datasetVersion: z.string().nullable().optional(),
            scorer: z.string(),
            metrics: z.record(z.number().nullable()),
            modelVersion: z.string().optional(),
            promptVersion: z.string().optional(),
            persisted: z.boolean().optional()
        })
        .strict()
);

module.exports = { MatchScoreComputed, EmbeddingUpdated, EvalRunCompleted };
