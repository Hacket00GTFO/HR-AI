const { eventEnvelope } = require('./base');
const { VacancyPublished, VacancyUpdated } = require('./vacancy');
const { ApplicationSubmitted } = require('./application');
const { CandidateStatusChanged, HiringDecisionRecorded } = require('./candidate');
const { ResumeUploaded, ResumeParsed } = require('./resume');
const { MatchScoreComputed, EmbeddingUpdated } = require('./matching');
const { UserRegistered } = require('./user');
const { UserUpdated, UserLoggedOut } = require('./identity');
const { SettingsUpdated } = require('./settings');
const { NotificationRequested, NotificationSent, NotificationFailed } = require('./notification');
const {
    RecruitmentVacancyPublished,
    RecruitmentVacancyUpdated,
    RecruitmentVacancyClosed,
    RecruitmentApplicationSubmitted,
    RecruitmentCandidateStatusChanged,
    RecruitmentHiringDecisionRecorded,
    RecruitmentOfferDecided
} = require('./recruitment');
const { InterviewScheduled } = require('./interview');
// Document-domain events share the ResumeUploaded/ResumeParsed schema names
// with the legacy monolith resume events (different `strafor.document.*` type
// strings) — export them under Document* aliases to keep the flat registry
// unambiguous. Services can also deep-import './document' for the originals.
const { ResumeUploaded: DocumentResumeUploaded, ResumeParsed: DocumentResumeParsed } = require('./document');
const { EmployeeCreated, EmployeeUpdated, EmployeeTerminated } = require('./hr');

const events = {
    VacancyPublished,
    VacancyUpdated,
    ApplicationSubmitted,
    CandidateStatusChanged,
    HiringDecisionRecorded,
    ResumeUploaded,
    ResumeParsed,
    MatchScoreComputed,
    EmbeddingUpdated,
    UserRegistered,
    UserUpdated,
    UserLoggedOut,
    SettingsUpdated,
    NotificationRequested,
    NotificationSent,
    NotificationFailed,
    DocumentResumeUploaded,
    DocumentResumeParsed,
    RecruitmentVacancyPublished,
    RecruitmentVacancyUpdated,
    RecruitmentVacancyClosed,
    RecruitmentApplicationSubmitted,
    RecruitmentCandidateStatusChanged,
    RecruitmentHiringDecisionRecorded,
    RecruitmentOfferDecided,
    InterviewScheduled,
    EmployeeCreated,
    EmployeeUpdated,
    EmployeeTerminated
};

// type string -> schema, for bus consumers that route by event type.
const EVENT_TYPES = Object.fromEntries(Object.values(events).map((schema) => [schema.shape.type.value, schema]));

module.exports = { eventEnvelope, events, EVENT_TYPES, ...events };
