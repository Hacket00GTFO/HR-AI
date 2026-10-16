import { createHash } from 'node:crypto';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import { providerMode, type ServiceConfig } from './config.js';
import { createClientCredentialsTokenProvider, type TokenProvider } from './token.js';

// ---------------------------------------------------------------------------
// Provider abstraction — the routes only ever talk to CalendarProvider, so
// 'stub' (deterministic, no credentials) and 'm365' (Microsoft Graph) are
// interchangeable.
// ---------------------------------------------------------------------------

export interface BusyInterval {
    start: string; // ISO 8601
    end: string;
}

export interface FreeBusyResult {
    email: string;
    busy: BusyInterval[];
}

export interface CreateEventInput {
    organizerEmail: string;
    attendees: string[];
    subject: string;
    start: string; // ISO 8601
    end: string;
    /** true → Teams online meeting; non-empty string → physical location. */
    locationOrTeams: boolean | string;
    body?: string;
}

export interface CreatedEvent {
    providerEventId: string;
    joinUrl: string | null;
}

export interface CalendarProvider {
    readonly mode: 'm365' | 'stub';
    getFreeBusy(emails: string[], start: Date, end: Date): Promise<FreeBusyResult[]>;
    createEvent(input: CreateEventInput): Promise<CreatedEvent>;
    cancelEvent(organizerEmail: string, providerEventId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Stub provider — deterministic fake free/busy + fake `stub-<n>` event ids.
// Determinism: busy blocks are derived purely from a SHA-256 seed of
// `${email}|${yyyy-mm-dd(start)}`, so the same query always yields the same
// answer (test-friendly, reproducible interview slots).
// ---------------------------------------------------------------------------

/** mulberry32 — small deterministic PRNG from a 32-bit seed. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function seedFor(email: string, day: string): number {
    const digest = createHash('sha256').update(`${email.toLowerCase()}|${day}`).digest();
    return digest.readUInt32BE(0);
}

const SLOT_MS = 15 * 60_000; // blocks snap to a 15-minute grid

export function stubBusyIntervals(email: string, start: Date, end: Date): BusyInterval[] {
    const day = start.toISOString().slice(0, 10);
    const rand = mulberry32(seedFor(email, day));
    const windowMs = end.getTime() - start.getTime();
    const blockCount = 1 + Math.floor(rand() * 3); // 1–3 busy blocks
    const blocks: BusyInterval[] = [];
    for (let i = 0; i < blockCount; i++) {
        const maxOffsetSlots = Math.max(1, Math.floor((windowMs * 0.7) / SLOT_MS));
        const offset = Math.floor(rand() * maxOffsetSlots) * SLOT_MS;
        const duration = (1 + Math.floor(rand() * 4)) * SLOT_MS; // 15–60 min
        const bStart = start.getTime() + offset;
        const bEnd = Math.min(bStart + duration, end.getTime());
        if (bEnd > bStart) {
            blocks.push({ start: new Date(bStart).toISOString(), end: new Date(bEnd).toISOString() });
        }
    }
    // Sort + merge any overlaps into clean disjoint intervals.
    blocks.sort((a, b) => a.start.localeCompare(b.start));
    const merged: BusyInterval[] = [];
    for (const b of blocks) {
        const last = merged[merged.length - 1];
        if (last && b.start <= last.end) {
            if (b.end > last.end) last.end = b.end;
        } else {
            merged.push({ ...b });
        }
    }
    return merged;
}

export function createStubProvider(): CalendarProvider {
    let counter = 0;
    return {
        mode: 'stub',
        async getFreeBusy(emails, start, end) {
            return emails.map((email) => ({ email, busy: stubBusyIntervals(email, start, end) }));
        },
        async createEvent(input) {
            counter += 1;
            const providerEventId = `stub-${counter}`;
            return {
                providerEventId,
                joinUrl: input.locationOrTeams === true ? `https://teams.stub.local/join/${providerEventId}` : null
            };
        },
        async cancelEvent() {
            // Nothing upstream to cancel — stub events exist only locally.
        }
    };
}

// ---------------------------------------------------------------------------
// M365 provider — Microsoft Graph v1.0 with an in-process client-credentials
// token. Required app role: Calendars.ReadWrite (application permission).
// ---------------------------------------------------------------------------

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Graph returns {dateTime, timeZone} without an offset — normalise to ISO. */
function graphDateTimeToIso(dt: { dateTime?: unknown; timeZone?: unknown } | undefined): string {
    const raw = typeof dt?.dateTime === 'string' ? dt.dateTime : '';
    const suffix = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw) ? '' : 'Z';
    return new Date(raw + suffix).toISOString();
}

export interface M365ProviderOptions {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    log?: ServiceLogger | undefined;
    /** Injectable for tests. */
    fetchImpl?: typeof fetch;
    /** Injectable clock for the token cache. */
    now?: () => number;
    tokenProvider?: TokenProvider;
}

export function createM365Provider(opts: M365ProviderOptions): CalendarProvider {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const log = opts.log;
    const tokens =
        opts.tokenProvider ??
        createClientCredentialsTokenProvider({
            tenantId: opts.tenantId,
            clientId: opts.clientId,
            clientSecret: opts.clientSecret,
            fetchImpl,
            ...(opts.now ? { now: opts.now } : {}),
            ...(log ? { log } : {})
        });

    /**
     * Authenticated Graph call. Errors are reduced to {op, status} — the
     * response body and URL (which embeds the organizer mailbox) are never
     * logged or re-thrown.
     */
    async function graph(op: string, path: string, init: { method: string; body?: unknown }): Promise<unknown> {
        const token = await tokens.getToken();
        const request: RequestInit = {
            method: init.method,
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json'
            }
        };
        if (init.body !== undefined) request.body = JSON.stringify(init.body);
        let res: Response;
        try {
            res = await fetchImpl(`${GRAPH_BASE}${path}`, request);
        } catch {
            throw httpError(502, 'Calendar provider unreachable');
        }
        if (!res.ok) {
            log?.warn({ op, status: res.status }, 'graph request failed');
            throw httpError(502, 'Calendar provider request failed');
        }
        if (res.status === 204) return null;
        return res.json();
    }

    const mailbox = (email: string) => `/users/${encodeURIComponent(email)}`;

    return {
        mode: 'm365',

        async getFreeBusy(emails, start, end) {
            // getSchedule is invoked in the context of any mailbox (the first
            // schedule's owner); application permissions make it arbitrary.
            const data = (await graph('getSchedule', `${mailbox(emails[0] ?? '')}/calendar/getSchedule`, {
                method: 'POST',
                body: {
                    schedules: emails,
                    startTime: { dateTime: start.toISOString(), timeZone: 'UTC' },
                    endTime: { dateTime: end.toISOString(), timeZone: 'UTC' },
                    availabilityViewInterval: 30
                }
            })) as {
                value?: Array<{
                    scheduleId?: string;
                    scheduleItems?: Array<{ status?: string; start?: unknown; end?: unknown }>;
                }>;
            };
            const byEmail = new Map<string, BusyInterval[]>();
            for (const schedule of data.value ?? []) {
                const items = (schedule.scheduleItems ?? [])
                    .filter((i) => i.status && i.status !== 'free')
                    .map((i) => ({
                        start: graphDateTimeToIso(i.start as { dateTime?: unknown; timeZone?: unknown }),
                        end: graphDateTimeToIso(i.end as { dateTime?: unknown; timeZone?: unknown })
                    }))
                    .filter((i) => i.end > i.start);
                if (typeof schedule.scheduleId === 'string') {
                    byEmail.set(schedule.scheduleId, items);
                }
            }
            return emails.map((email) => ({ email, busy: byEmail.get(email) ?? [] }));
        },

        async createEvent(input) {
            const teams = input.locationOrTeams === true;
            const location =
                typeof input.locationOrTeams === 'string' && input.locationOrTeams.trim()
                    ? { displayName: input.locationOrTeams.slice(0, 255) }
                    : undefined;
            const data = (await graph('createEvent', `${mailbox(input.organizerEmail)}/events`, {
                method: 'POST',
                body: {
                    subject: input.subject,
                    ...(input.body !== undefined ? { body: { contentType: 'HTML', content: input.body } } : {}),
                    start: { dateTime: input.start, timeZone: 'UTC' },
                    end: { dateTime: input.end, timeZone: 'UTC' },
                    attendees: input.attendees.map((address) => ({
                        emailAddress: { address },
                        type: 'required'
                    })),
                    isOnlineMeeting: teams,
                    ...(teams ? { onlineMeetingProvider: 'teamsForBusiness' } : {}),
                    ...(location ? { location } : {})
                }
            })) as { id?: unknown; onlineMeeting?: { joinUrl?: unknown } | null };
            if (typeof data.id !== 'string' || !data.id) {
                throw httpError(502, 'Calendar provider returned no event id');
            }
            const joinUrl =
                data.onlineMeeting && typeof data.onlineMeeting.joinUrl === 'string'
                    ? data.onlineMeeting.joinUrl
                    : null;
            return { providerEventId: data.id, joinUrl };
        },

        async cancelEvent(organizerEmail, providerEventId) {
            // DELETE cancels the meeting and notifies attendees.
            await graph('cancelEvent', `${mailbox(organizerEmail)}/events/${encodeURIComponent(providerEventId)}`, {
                method: 'DELETE'
            });
        }
    };
}

export interface ProviderFactoryOptions {
    fetchImpl?: typeof fetch;
    now?: () => number;
    log?: ServiceLogger;
}

/** Pick the provider from config: full M365 credentials → Graph, else stub. */
export function createProvider(config: ServiceConfig, opts: ProviderFactoryOptions = {}): CalendarProvider {
    if (providerMode(config) === 'm365') {
        return createM365Provider({
            tenantId: config.M365_TENANT_ID as string,
            clientId: config.M365_CLIENT_ID as string,
            clientSecret: config.M365_CLIENT_SECRET as string,
            log: opts.log,
            ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
            ...(opts.now ? { now: opts.now } : {})
        });
    }
    return createStubProvider();
}

/** Mask a configured secret for display: first 4 chars + ellipsis. */
export function maskSecret(value: string | undefined): string | null {
    if (!value) return null;
    return `${value.slice(0, 4)}…`;
}
