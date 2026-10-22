import { Router } from 'express';
import { httpError } from '@strafor/node-common';
import * as Application from '../models/application.js';
import * as Offer from '../models/offer.js';
import { serviceOrHrAuth } from '../auth.js';
import { validate } from '../validate.js';
import * as schemas from '../schemas.js';
import type { ServiceDeps } from '../deps.js';

// Application-scoped routes — /v1/applications/:id. HR only (or service
// token): application detail carries candidate PII + the cover letter.
export function applicationsRouter(deps: ServiceDeps): Router {
    const { pool, config } = deps;
    const hr = serviceOrHrAuth(config.SERVICE_AUTH_TOKEN);
    const router = Router();

    // GET /v1/applications/:id — application detail with the nested candidate
    // (HR only). Includes cover_letter — the only surface that exposes it.
    router.get('/:id', hr, validate({ params: schemas.idParam }), async (req, res, next) => {
        try {
            const application = await Application.findDetailById(pool, req.params.id);
            if (!application) {
                throw httpError(404, 'Application not found');
            }
            res.json(application);
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/applications/:id/offer — create + extend an offer (HR only).
    // Body: { salary, salary_currency?, start_date?, terms?, status? } —
    // status defaults to 'sent'; 'draft' parks the offer without sending.
    // A second live (draft|sent) offer on the same application → 409
    // (partial unique index offers_application_live_uidx).
    router.post(
        '/:id/offer',
        hr,
        validate({ params: schemas.idParam, body: schemas.offerCreateBody }),
        async (req, res, next) => {
            try {
                const application = await Application.findById(pool, req.params.id);
                if (!application) {
                    throw httpError(404, 'Application not found');
                }
                const offer = await Offer.create(pool, {
                    application_id: application.id,
                    salary: req.body.salary,
                    salary_currency: req.body.salary_currency ?? null,
                    start_date: req.body.start_date ?? null,
                    terms: req.body.terms ?? null,
                    status: req.body.status ?? 'sent',
                    created_by: req.user?.userId ?? null
                });
                res.status(201).json(offer);
            } catch (err) {
                const e = err as { code?: string };
                if (e && e.code === '23505') {
                    return next(httpError(409, 'A live offer already exists for this application'));
                }
                next(err);
            }
        }
    );

    return router;
}
