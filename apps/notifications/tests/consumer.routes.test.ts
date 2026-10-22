import { describe, expect, it } from 'vitest';
import type { ServiceLogger } from '@strafor/node-common';
import { CONSUMED_EVENT_TYPES, EVENT_ROUTES, deriveIdempotencyKey, type RouteContext } from '../src/consumer.js';

const silentLog = new Proxy({} as never, {
    get: () => () => {}
}) as ServiceLogger;

const HR = 'hr@strafor.local';

const route = (type: string, payload: Record<string, unknown>, hrNotifyEmail?: string) =>
    EVENT_ROUTES[type]?.(payload, { hrNotifyEmail, log: silentLog } satisfies RouteContext);

describe('consumer event routes — coverage', () => {
    it('routes every new domain-event family type', () => {
        for (const type of [
            'strafor.recruitment.application_submitted',
            'strafor.recruitment.candidate_status_changed',
            'strafor.recruitment.vacancy_published',
            'strafor.recruitment.hiring_decision_recorded',
            'strafor.services.ticket_created',
            'strafor.services.ticket_assigned',
            'strafor.services.ticket_resolved',
            'strafor.services.expense_submitted',
            'strafor.services.expense_decided',
            'strafor.services.survey_opened',
            'strafor.services.survey_closed',
            'strafor.payroll.period_status',
            'strafor.payroll.reconciled',
            'strafor.hr.employee_created',
            'strafor.hr.employee_terminated',
            'strafor.attendance.recorded'
        ]) {
            expect(CONSUMED_EVENT_TYPES).toContain(type);
            expect(EVENT_ROUTES[type]).toBeTypeOf('function');
        }
    });
});

describe('recruitment-core canonical family', () => {
    it('application_submitted → candidate email, deduped against the legacy pair', () => {
        const r = route('strafor.recruitment.application_submitted', {
            applicationId: 7,
            candidateId: 3,
            vacancyId: 2,
            email: 'cand@example.com',
            appliedAt: '2026-01-01T00:00:00Z'
        });
        expect(r?.to).toBe('cand@example.com');
        expect(r?.template).toBe('recruitment.application_received');
        // Same key the legacy strafor.application.submitted payload carries —
        // whichever event arrives second is an idempotent replay.
        expect(r?.idempotencyKey).toBe('application:7');
        expect(r?.locale).toBe('en');
    });

    it('application_submitted without a recipient is skipped (ids only)', () => {
        expect(route('strafor.recruitment.application_submitted', { applicationId: 7, candidateId: 3 })).toBeNull();
    });

    it('candidate_status_changed resolves recipientEmail and carries newStatus', () => {
        const r = route('strafor.recruitment.candidate_status_changed', {
            candidateId: 3,
            applicationId: 7,
            previousStatus: 'applied',
            newStatus: 'screening',
            recipientEmail: 'cand@example.com',
            name: 'Ana',
            locale: 'es-MX'
        });
        expect(r?.to).toBe('cand@example.com');
        expect(r?.template).toBe('recruitment.status_changed');
        expect(r?.payload.status).toBe('screening');
        expect(r?.payload.name).toBe('Ana');
        expect(r?.locale).toBe('es');
    });

    it('candidate_status_changed with ids only is skipped', () => {
        expect(
            route('strafor.recruitment.candidate_status_changed', {
                candidateId: 3,
                applicationId: 7,
                newStatus: 'screening'
            })
        ).toBeNull();
    });

    it('vacancy_published → HR mailbox when configured, skip otherwise', () => {
        const payload = { vacancyId: 9, title: 'Backend Dev', department: 'Eng', location: 'CDMX', type: 'Full-time' };
        expect(route('strafor.recruitment.vacancy_published', payload)).toBeNull();
        const r = route('strafor.recruitment.vacancy_published', payload, HR);
        expect(r?.to).toBe(HR);
        expect(r?.template).toBe('recruitment.vacancy_published');
        expect(r?.payload.title).toBe('Backend Dev');
    });

    it('vacancy_published prefers an explicit payload email over the HR mailbox', () => {
        const r = route(
            'strafor.recruitment.vacancy_published',
            { vacancyId: 9, title: 'Dev', recipientEmail: 'digest@example.com' },
            HR
        );
        expect(r?.to).toBe('digest@example.com');
    });

    it('hiring_decision_recorded → candidate, neutral payload (no decision leak)', () => {
        const r = route('strafor.recruitment.hiring_decision_recorded', {
            candidateId: 3,
            applicationId: 7,
            decision: 'hired',
            email: 'cand@example.com'
        });
        expect(r?.to).toBe('cand@example.com');
        expect(r?.template).toBe('recruitment.hiring_decision');
        expect(r?.payload.decision).toBeUndefined();
        expect(r?.payload.feedback).toBeUndefined();
    });

    it('hiring_decision_recorded without recipient is skipped', () => {
        expect(
            route('strafor.recruitment.hiring_decision_recorded', {
                candidateId: 3,
                applicationId: 7,
                decision: 'hired'
            })
        ).toBeNull();
    });
});

describe('hr-services family', () => {
    it('ticket_created → employee confirmation with category/priority/SLA', () => {
        const r = route('strafor.services.ticket_created', {
            ticketId: 11,
            employeeId: 5,
            category: 'it_support',
            priority: 'high',
            status: 'new',
            slaDueAt: '2026-02-01T00:00:00Z',
            employeeEmail: 'emp@example.com'
        });
        expect(r?.to).toBe('emp@example.com');
        expect(r?.template).toBe('services.ticket_created');
        expect(r?.payload.ticketId).toBe(11);
        expect(r?.payload.priority).toBe('high');
        expect(r?.payload.slaDueAt).toBe('2026-02-01T00:00:00Z');
    });

    it('ticket_created without employee email is skipped', () => {
        expect(
            route('strafor.services.ticket_created', { ticketId: 11, employeeId: 5, category: 'it', priority: 'low' })
        ).toBeNull();
    });

    it('ticket_assigned → employee with expected SLA', () => {
        const r = route('strafor.services.ticket_assigned', {
            ticketId: 11,
            employeeId: 5,
            assigneeUserId: 9,
            status: 'assigned',
            slaDueAt: '2026-02-03T00:00:00Z',
            email: 'emp@example.com'
        });
        expect(r?.to).toBe('emp@example.com');
        expect(r?.template).toBe('services.ticket_assigned');
        expect(r?.payload.slaDueAt).toBe('2026-02-03T00:00:00Z');
    });

    it('ticket_resolved → employee', () => {
        const r = route('strafor.services.ticket_resolved', {
            ticketId: 11,
            employeeId: 5,
            status: 'resolved',
            email: 'emp@example.com'
        });
        expect(r?.to).toBe('emp@example.com');
        expect(r?.template).toBe('services.ticket_resolved');
    });

    it('expense_submitted → approver email wins, else HR mailbox, else skip', () => {
        const payload = { reportId: 4, employeeId: 5, total: 1250.5, currency: 'MXN' };
        const approver = route(
            'strafor.services.expense_submitted',
            { ...payload, approverEmail: 'boss@example.com' },
            HR
        );
        expect(approver?.to).toBe('boss@example.com');
        expect(approver?.template).toBe('services.expense_submitted');

        const hrRoute = route('strafor.services.expense_submitted', payload, HR);
        expect(hrRoute?.to).toBe(HR);

        expect(route('strafor.services.expense_submitted', payload)).toBeNull();
    });

    it('expense_decided → employee; es locale localizes the decision label', () => {
        const en = route('strafor.services.expense_decided', {
            reportId: 4,
            employeeId: 5,
            decision: 'approved',
            total: 100,
            currency: 'MXN',
            email: 'emp@example.com'
        });
        expect(en?.to).toBe('emp@example.com');
        expect(en?.template).toBe('services.expense_decided');
        expect(en?.payload.decision).toBe('approved');
        expect(en?.payload.decisionCode).toBe('approved');

        const es = route('strafor.services.expense_decided', {
            reportId: 4,
            employeeId: 5,
            decision: 'rejected',
            email: 'emp@example.com',
            locale: 'es'
        });
        expect(es?.payload.decision).toBe('rechazado');
        expect(es?.payload.decisionCode).toBe('rejected');
        expect(es?.locale).toBe('es');
    });

    it('expense_decided without employee email is skipped', () => {
        expect(
            route('strafor.services.expense_decided', { reportId: 4, employeeId: 5, decision: 'approved' })
        ).toBeNull();
    });

    it('survey_opened → employee with survey type and close date', () => {
        const r = route('strafor.services.survey_opened', {
            surveyId: 2,
            type: 'climate',
            closesAt: '2026-03-01',
            email: 'emp@example.com'
        });
        expect(r?.to).toBe('emp@example.com');
        expect(r?.template).toBe('services.survey_opened');
        expect(r?.payload.surveyType).toBe('climate');
        expect(r?.payload.closesAt).toBe('2026-03-01');
    });

    it('survey_opened with no recipient is skipped', () => {
        expect(route('strafor.services.survey_opened', { surveyId: 2, type: 'nom035' })).toBeNull();
    });

    it('survey_closed → HR mailbox digest with respondent count', () => {
        const r = route('strafor.services.survey_closed', { surveyId: 2, type: 'nom035', respondents: 87 }, HR);
        expect(r?.to).toBe(HR);
        expect(r?.template).toBe('services.survey_closed');
        expect(r?.payload.respondents).toBe(87);
        expect(route('strafor.services.survey_closed', { surveyId: 2, type: 'nom035', respondents: 87 })).toBeNull();
    });
});

describe('payroll-adapter family', () => {
    it('period_status → HR mailbox digest', () => {
        const r = route(
            'strafor.payroll.period_status',
            { periodId: 5, frequency: 'catorcenal', from: 'review', to: 'locked', actor: 'hr@x' },
            HR
        );
        expect(r?.to).toBe(HR);
        expect(r?.template).toBe('payroll.period_status');
        expect(r?.payload.from).toBe('review');
        expect(r?.payload.to).toBe('locked');
        expect(route('strafor.payroll.period_status', { periodId: 5, from: 'a', to: 'b' })).toBeNull();
    });

    it('reconciled → HR mailbox digest', () => {
        const r = route('strafor.payroll.reconciled', { periodId: 5, compared: 120, deltas: 3 }, HR);
        expect(r?.to).toBe(HR);
        expect(r?.template).toBe('payroll.reconciled');
        expect(r?.payload.compared).toBe(120);
        expect(r?.payload.deltas).toBe(3);
        expect(route('strafor.payroll.reconciled', { periodId: 5, compared: 1, deltas: 0 })).toBeNull();
    });
});

describe('hr-core family', () => {
    it('employee_created → welcome email at the work email', () => {
        const r = route('strafor.hr.employee_created', {
            employeeId: 8,
            employeeNumber: 'EMP-008',
            status: 'active',
            hireDate: '2026-02-01',
            workEmail: 'newbie@strafor.local',
            name: 'Luis'
        });
        expect(r?.to).toBe('newbie@strafor.local');
        expect(r?.template).toBe('hr.employee_welcome');
        expect(r?.payload.employeeNumber).toBe('EMP-008');
        expect(r?.payload.hireDate).toBe('2026-02-01');
    });

    it('employee_created without a work email is skipped (no fallback to HR)', () => {
        expect(
            route('strafor.hr.employee_created', { employeeId: 8, employeeNumber: 'EMP-008', status: 'active' }, HR)
        ).toBeNull();
    });

    it('employee_terminated → HR mailbox only', () => {
        const r = route(
            'strafor.hr.employee_terminated',
            { employeeId: 8, employeeNumber: 'EMP-008', status: 'terminated', reason: 'offboarding' },
            HR
        );
        expect(r?.to).toBe(HR);
        expect(r?.template).toBe('hr.employee_terminated');
        expect(r?.payload.reason).toBe('offboarding');
        expect(
            route('strafor.hr.employee_terminated', { employeeId: 8, employeeNumber: 'EMP-008', status: 'terminated' })
        ).toBeNull();
    });
});

describe('time-attendance family', () => {
    const punch = { eventId: 1, employeeId: 8, kind: 'check_in', occurredAt: '2026-01-01T08:00:00Z', source: 'pwa' };

    it('plain punches never produce email, even with an HR mailbox set', () => {
        expect(route('strafor.attendance.recorded', punch, HR)).toBeNull();
        expect(route('strafor.attendance.recorded', { ...punch, anomaly: false }, HR)).toBeNull();
    });

    it('anomaly-flagged events → HR mailbox', () => {
        const r = route(
            'strafor.attendance.recorded',
            { ...punch, anomaly: true, anomalyReason: 'impossible_travel' },
            HR
        );
        expect(r?.to).toBe(HR);
        expect(r?.template).toBe('attendance.anomaly');
        expect(r?.payload.kind).toBe('check_in');
        expect(r?.payload.anomalyReason).toBe('impossible_travel');
    });

    it('anomaly without HR mailbox or payload email is skipped', () => {
        expect(route('strafor.attendance.recorded', { ...punch, anomaly: true })).toBeNull();
    });
});

describe('payload validation + idempotency', () => {
    it('wrongly-typed fields fail the loose contract → skipped', () => {
        expect(route('strafor.services.ticket_created', { ticketId: 'not-a-number', email: 'e@x.com' }, HR)).toBeNull();
    });

    it('unknown fields are tolerated and stripped', () => {
        const r = route('strafor.services.ticket_resolved', {
            ticketId: 1,
            employeeId: 2,
            email: 'e@x.com',
            totallyUnknown: { nested: true }
        });
        expect(r?.to).toBe('e@x.com');
    });

    it('deriveIdempotencyKey: payload key > route key > correlationId > deliveryTag', () => {
        const cid = '11111111-2222-3333-4444-555555555555';
        expect(deriveIdempotencyKey({ correlationId: cid, payload: { idempotencyKey: 'app:1' } }, 42, 'routed:1')).toBe(
            'app:1'
        );
        expect(deriveIdempotencyKey({ correlationId: cid, payload: {} }, 42, 'routed:1')).toBe('routed:1');
        expect(deriveIdempotencyKey({ correlationId: cid, payload: {} }, 42)).toBe(`evt:${cid}`);
        expect(deriveIdempotencyKey({ payload: {} }, 42)).toBe('evt:42');
    });
});
