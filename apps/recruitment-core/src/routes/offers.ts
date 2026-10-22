import { Router } from 'express';
import { httpError } from '@strafor/node-common';
import { withTransaction } from '../db.js';
import * as Offer from '../models/offer.js';
import * as Application from '../models/application.js';
import { enqueueEvent, flushOutbox } from '../events.js';
import { serviceOrHrAuth } from '../auth.js';
import { validate } from '../validate.js';
import * as schemas from '../schemas.js';
import { offerDecidedPayload } from '../payloads.js';
import type { ServiceDeps } from '../deps.js';

// Offer routes — /v1/offers/:id. Offer creation lives on the application
// resource (POST /v1/applications/:id/offer, routes/applications.ts).
// HR only (or service token): offers carry compensation data.
export function offersRouter(deps: ServiceDeps): Router {
    const { pool, config, publisher, log } = deps;
    const hr = serviceOrHrAuth(config.SERVICE_AUTH_TOKEN);
    const router = Router();

    // GET /v1/offers/:id — offer detail (HR only).
    router.get('/:id', hr, validate({ params: schemas.idParam }), async (req, res, next) => {
        try {
            const offer = await Offer.findById(pool, req.params.id);
            if (!offer) {
                throw httpError(404, 'Offer not found');
            }
            res.json(offer);
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/offers/:id/decision — record the candidate's answer
    // (accepted|declined + optional reason). Terminal offers → 409.
    // On 'accepted' the application's status moves to 'accepted' (the
    // canonical hiring status — the applications enum has no 'hired').
    router.post(
        '/:id/decision',
        hr,
        validate({ params: schemas.idParam, body: schemas.offerDecisionBody }),
        async (req, res, next) => {
            try {
                const { decision, reason } = req.body;
                const decidedBy = req.user?.userId ?? null;

                const offer = await withTransaction(pool, async (client) => {
                    const updated = await Offer.decide(client, req.params.id, decision, reason ?? null);
                    if (!updated) return null;

                    const application = await Application.findById(client, updated.application_id);
                    if (decision === 'accepted' && application) {
                        await Application.updateStatus(pool, application.id, 'accepted', {
                            changedBy: decidedBy,
                            note: 'Offer accepted',
                            client
                        });
                    }
                    await enqueueEvent(
                        client,
                        'strafor.recruitment.offer_decided',
                        offerDecidedPayload(updated, application, decidedBy),
                        req.correlationId
                    );
                    return updated;
                });

                if (!offer) {
                    throw httpError(404, 'Offer not found');
                }
                await flushOutbox(pool, publisher, log).catch(() => 0);
                res.json(offer);
            } catch (err) {
                next(err);
            }
        }
    );

    return router;
}
