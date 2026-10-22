import { Router } from 'express';
import { httpError } from '@strafor/node-common';
import * as Interview from '../models/interview.js';
import { serviceOrHrAuth } from '../auth.js';
import { validate } from '../validate.js';
import * as schemas from '../schemas.js';
import type { ServiceDeps } from '../deps.js';

// Interview record routes — /v1/interviews/:id. The vacancy-scoped list/create
// endpoints live in routes/vacancies.ts (GET/POST /v1/vacancies/:id/interviews).
// HR only (or service token): interview rows carry candidate display refs.
export function interviewsRouter(deps: ServiceDeps): Router {
    const { pool, config } = deps;
    const hr = serviceOrHrAuth(config.SERVICE_AUTH_TOKEN);
    const router = Router();

    // GET /v1/interviews/:id — interview detail (HR only).
    router.get('/:id', hr, validate({ params: schemas.idParam }), async (req, res, next) => {
        try {
            const interview = await Interview.findById(pool, req.params.id);
            if (!interview) {
                throw httpError(404, 'Interview not found');
            }
            res.json(interview);
        } catch (err) {
            next(err);
        }
    });

    // PUT /v1/interviews/:id — partial update (HR only): reschedule
    // (scheduled_at/duration_minutes), cancel or mark done (status), attach
    // the scorecard (criteria ratings 1-5 + notes), edit location/notes.
    router.put(
        '/:id',
        hr,
        validate({ params: schemas.idParam, body: schemas.interviewUpdateBody }),
        async (req, res, next) => {
            try {
                const updated = await Interview.updateById(pool, req.params.id, req.body);
                if (!updated) {
                    throw httpError(404, 'Interview not found');
                }
                res.json(updated);
            } catch (err) {
                next(err);
            }
        }
    );

    return router;
}
