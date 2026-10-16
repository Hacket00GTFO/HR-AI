// DSAR execution — real access export and erasure for candidate data.
//
// The monolith covers its own `innovation` candidate tables directly and
// additionally fans out to every service that owns subject data via their
// service-token-only internal endpoints:
//   POST /v1/internal/dsar-export  {subjectKey, requestId, email?, userId?, employeeId?}
//   POST /v1/internal/dsar-erase   same body → {erased: bool, detail}
//
// Fan-out rules: 5s timeout, X-Service-Token + X-Correlation-Id headers
// (callService), never log payload bodies. A down service NEVER fails the
// whole DSAR — its slot is marked {error:'unavailable'} in the export and in
// the erasure audit detail.
//
// subjectKey convention: candidate-domain services key on the subject's
// EMAIL; employee-domain services key on the employee id (resolved from the
// hr-core export or the monolith employees table) — we always pass email +
// userId + employeeId when known so each service can resolve independently.
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const db = require('../db');
const logger = require('./logger');
const { callService } = require('./serviceClient');

const EXPORTS_DIR = process.env.EXPORTS_DIR || path.join(__dirname, '..', '..', '..', 'secure_uploads', 'exports');
const RESUMES_DIR = process.env.RESUMES_DIR || path.join(__dirname, '..', '..', '..', 'secure_uploads', 'resumes');

const DSAR_TIMEOUT_MS = 5000;

// service slot → base URL resolver. Defaults are the compose DNS names; every
// one is overridable per environment (e.g. localhost ports in bare dev).
const DSAR_SERVICES = {
    recruitment: () => process.env.RECRUITMENT_CORE_URL || 'http://recruitment-core:3009',
    hr: () => process.env.HR_CORE_URL || 'http://hr-core:3010',
    time: () => process.env.TIME_ATTENDANCE_URL || 'http://time-attendance:3011',
    services: () => process.env.HR_SERVICES_URL || 'http://hr-services:3014',
    payroll: () => process.env.PAYROLL_ADAPTER_URL || 'http://payroll-adapter:3012'
};

const UNAVAILABLE = Object.freeze({ error: 'unavailable' });

async function resolveCandidate(dsar) {
    if (dsar.candidate_id) {
        const { rows } = await db.query('SELECT * FROM candidates WHERE id = $1', [dsar.candidate_id]);
        if (rows[0]) return rows[0];
    }
    if (dsar.email) {
        const { rows } = await db.query('SELECT * FROM candidates WHERE lower(email) = lower($1)', [dsar.email]);
        if (rows[0]) return rows[0];
    }
    return null;
}

/**
 * Best-effort subject identifiers for the fan-out. The monolith employees
 * table links email → (employee id, identity user id); when the service
 * extraction has drained it the lookup just yields nulls — downstream
 * services then rely on whatever identifiers are present.
 */
async function resolveSubjectIdentifiers(dsar, candidate) {
    const email = dsar.email || (candidate && candidate.email) || null;
    let userId = null;
    let employeeId = null;
    if (email) {
        try {
            const { rows } = await db.query(
                'SELECT id, user_id FROM employees WHERE lower(email) = lower($1) AND deleted_at IS NULL',
                [email]
            );
            if (rows[0]) {
                employeeId = rows[0].id;
                userId = rows[0].user_id ?? null;
            }
        } catch {
            /* employees may be extracted already — best effort */
        }
        if (userId == null) {
            try {
                const { rows } = await db.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
                if (rows[0]) userId = rows[0].id;
            } catch {
                /* best effort — users may live only in strafor_identity */
            }
        }
    }
    return { email, userId, employeeId };
}

/**
 * POST one service's DSAR endpoint. Returns the parsed body, or
 * {error:'unavailable'} on timeout/network/HTTP failure — callers record the
 * marker verbatim and keep going.
 */
async function callDsarEndpoint(service, endpoint, body, correlationId) {
    try {
        return await callService(DSAR_SERVICES[service](), endpoint, {
            method: 'POST',
            body,
            timeout: DSAR_TIMEOUT_MS,
            correlationId
        });
    } catch (err) {
        // Status/code only — response bodies can carry subject PII.
        logger.warn(
            { service, endpoint, code: err && err.code, status: err && err.status },
            'dsar fan-out call failed — marking service unavailable'
        );
        return { ...UNAVAILABLE, service };
    }
}

function dsarBody(identifiers, dsar) {
    const subjectKey = identifiers.email || String(identifiers.employeeId ?? identifiers.userId ?? '');
    if (!subjectKey) return null; // no identifier at all — nothing to resolve
    return {
        subjectKey,
        requestId: dsar.id,
        ...(identifiers.email ? { email: identifiers.email } : {}),
        ...(identifiers.userId != null ? { userId: identifiers.userId } : {}),
        ...(identifiers.employeeId != null ? { employeeId: identifiers.employeeId } : {})
    };
}

function callDsar(service, endpoint, identifiers, dsar, correlationId) {
    const body = dsarBody(identifiers, dsar);
    if (!body) return Promise.resolve({ error: 'unresolved', reason: 'no_subject_identifier', service });
    return callDsarEndpoint(service, endpoint, body, correlationId);
}

/**
 * Export fan-out. hr-core is called first (together with recruitment) so the
 * employee_id it resolves can enrich the downstream employee-domain calls.
 * Every slot is populated — a failed service contributes {error:'unavailable'}.
 */
async function exportFromServices(identifiers, dsar) {
    const correlationId = `dsar-${dsar.id}`;
    const services = {
        recruitment: UNAVAILABLE,
        hr: UNAVAILABLE,
        time: UNAVAILABLE,
        services: UNAVAILABLE,
        payroll: UNAVAILABLE
    };

    const [recruitment, hr] = await Promise.all([
        callDsar('recruitment', '/v1/internal/dsar-export', identifiers, dsar, correlationId),
        callDsar('hr', '/v1/internal/dsar-export', identifiers, dsar, correlationId)
    ]);
    services.recruitment = recruitment;
    services.hr = hr;

    // Enrich: hr-core's export carries the resolved employee id.
    const resolvedEmployeeId = hr && hr.employee && hr.employee.id != null ? hr.employee.id : null;
    if (identifiers.employeeId == null && resolvedEmployeeId != null) {
        identifiers.employeeId = resolvedEmployeeId;
    }

    const [time, hrServices, payroll] = await Promise.all([
        callDsar('time', '/v1/internal/dsar-export', identifiers, dsar, correlationId),
        callDsar('services', '/v1/internal/dsar-export', identifiers, dsar, correlationId),
        callDsar('payroll', '/v1/internal/dsar-export', identifiers, dsar, correlationId)
    ]);
    services.time = time;
    services.services = hrServices;
    services.payroll = payroll;
    return services;
}

/**
 * Erasure fan-out — same sequencing as export so the hr-resolved employee_id
 * reaches time/hr-services/payroll. Runs even when the monolith has no
 * candidate row (employee-domain subjects have no candidate record).
 */
async function eraseInServices(identifiers, dsar) {
    const correlationId = `dsar-${dsar.id}`;
    const results = {
        recruitment: UNAVAILABLE,
        hr: UNAVAILABLE,
        time: UNAVAILABLE,
        services: UNAVAILABLE,
        payroll: UNAVAILABLE
    };

    const [recruitment, hr] = await Promise.all([
        callDsar('recruitment', '/v1/internal/dsar-erase', identifiers, dsar, correlationId),
        callDsar('hr', '/v1/internal/dsar-erase', identifiers, dsar, correlationId)
    ]);
    results.recruitment = recruitment;
    results.hr = hr;

    const resolvedEmployeeId = hr && hr.detail && hr.detail.employeeId != null ? hr.detail.employeeId : null;
    if (identifiers.employeeId == null && resolvedEmployeeId != null) {
        identifiers.employeeId = resolvedEmployeeId;
    }

    const [time, hrServices, payroll] = await Promise.all([
        callDsar('time', '/v1/internal/dsar-erase', identifiers, dsar, correlationId),
        callDsar('services', '/v1/internal/dsar-erase', identifiers, dsar, correlationId),
        callDsar('payroll', '/v1/internal/dsar-erase', identifiers, dsar, correlationId)
    ]);
    results.time = time;
    results.services = hrServices;
    results.payroll = payroll;
    return results;
}

function exportPath(dsarId) {
    return path.join(EXPORTS_DIR, `dsar-${dsarId}.json`);
}

async function buildAccessExport(dsar, candidate, monolith) {
    const identifiers = await resolveSubjectIdentifiers(dsar, candidate);
    const services = await exportFromServices(identifiers, dsar);
    return {
        generated_at: new Date().toISOString(),
        data_controller: process.env.DATA_CONTROLLER || 'StraforAI',
        generated_for: {
            email: identifiers.email,
            userId: identifiers.userId,
            employeeId: identifiers.employeeId,
            candidateId: candidate.id
        },
        request: { id: dsar.id, type: dsar.type, email: dsar.email },
        candidate,
        skills: monolith.skills,
        applications: monolith.applications,
        status_history: monolith.status_history,
        services
    };
}

async function executeAccess(dsar) {
    const candidate = await resolveCandidate(dsar);
    if (!candidate) {
        const err = new Error('No candidate record found for this request');
        err.code = 'not_found';
        throw err;
    }

    const { rows: applications } = await db.query(
        `SELECT a.*, v.title AS vacancy_title
           FROM applications a LEFT JOIN vacancies v ON v.id = a.vacancy_id
          WHERE a.candidate_id = $1 ORDER BY a.applied_at`,
        [candidate.id]
    );
    const { rows: history } = await db.query(
        `SELECT h.* FROM application_status_history h
           JOIN applications a ON a.id = h.application_id
          WHERE a.candidate_id = $1 ORDER BY h.changed_at`,
        [candidate.id]
    );
    const { rows: skills } = await db.query(
        `SELECT s.name FROM candidate_skills cs JOIN skills s ON s.id = cs.skill_id
          WHERE cs.candidate_id = $1`,
        [candidate.id]
    );

    const payload = await buildAccessExport(dsar, candidate, {
        skills: skills.map((s) => s.name),
        applications,
        status_history: history
    });

    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    fs.writeFileSync(exportPath(dsar.id), JSON.stringify(payload, null, 2), { mode: 0o600 });
    return `/api/admin/data-retention/dsar/${dsar.id}/download`;
}

async function executeErasure(dsar) {
    const candidate = await resolveCandidate(dsar);
    const identifiers = await resolveSubjectIdentifiers(dsar, candidate);

    let monolithResult;
    if (candidate) {
        const resumeFile = candidate.resume;
        await db.withTransaction(async (client) => {
            await client.query(
                `UPDATE candidates SET
                    first_name = '[erased]', last_name = '[erased]',
                    email = $2, phone = '', linkedin = NULL,
                    experience = 0, education = '[erased]', location = '[erased]',
                    skills = '', resume = NULL, current_position = NULL
                 WHERE id = $1`,
                [candidate.id, `erased+${candidate.id}@erased.invalid`]
            );
            await client.query(
                `UPDATE applications SET hiring_feedback = NULL, ai_insights = NULL,
                    ai_feedback_analysis = NULL
                 WHERE candidate_id = $1`,
                [candidate.id]
            );
            await client.query('DELETE FROM candidate_skills WHERE candidate_id = $1', [candidate.id]);
            await client.query('DELETE FROM candidate_embeddings WHERE candidate_id = $1', [candidate.id]);
        });

        if (resumeFile) {
            const resolved = path.resolve(RESUMES_DIR, path.basename(resumeFile));
            if (resolved.startsWith(path.resolve(RESUMES_DIR))) {
                fs.rmSync(resolved, { force: true });
            }
        }
        monolithResult = { erased: true, candidate_id: candidate.id };
    } else {
        monolithResult = { erased: false, reason: 'no_matching_candidate' };
    }

    // Cross-service erasure runs even without a monolith candidate — the
    // subject may exist only in employee-domain services. Each service's
    // result (or {error:'unavailable'}) lands here and is persisted in the
    // DSAR audit metadata by the caller.
    const services = await eraseInServices(identifiers, dsar);

    return { ...monolithResult, services };
}

async function execute(dsar) {
    if (dsar.type === 'access') {
        const resultUrl = await executeAccess(dsar);
        return { resultUrl, detail: 'export_generated' };
    }
    const result = await executeErasure(dsar);
    return { resultUrl: null, detail: result };
}

module.exports = { execute, exportPath, buildAccessExport, EXPORTS_DIR, DSAR_SERVICES };
