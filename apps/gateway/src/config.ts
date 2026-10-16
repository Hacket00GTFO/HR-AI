import 'dotenv/config';

export interface GatewayConfig {
    port: number;
    nodeEnv: string;
    /** Legacy monolith — catch-all for /api/* and (default) non-/api paths. */
    apiUrl: string;
    identityUrl: string;
    identityJwksUrl: string;
    issuer: string;
    vacanciesUrl?: string;
    candidatesUrl?: string;
    /** Extracted recruitment service — vacancies/candidates/applications/public. */
    recruitmentCoreUrl?: string;
    documentsUrl?: string;
    notificationsUrl?: string;
    aiServiceUrl?: string;
    hrCoreUrl?: string;
    timeAttendanceUrl?: string;
    payrollAdapterUrl?: string;
    hrServicesUrl?: string;
    calendarBridgeUrl?: string;
    staticFallbackUrl?: string;
    redisUrl?: string;
    corsOrigins: string[];
    proxyTimeoutMs: number;
    uploadTimeoutMs: number;
}

export function loadConfig(
    env: NodeJS.ProcessEnv = process.env,
    overrides: Partial<GatewayConfig> = {}
): GatewayConfig {
    const identityUrl = env.IDENTITY_URL || 'http://localhost:3001';
    const corsOrigins = (env.CORS_ORIGIN || '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);

    const cfg: GatewayConfig = {
        port: Number(env.PORT) || 8080,
        nodeEnv: env.NODE_ENV || 'development',
        apiUrl: env.API_URL || 'http://localhost:3000',
        identityUrl,
        identityJwksUrl: env.IDENTITY_JWKS_URL || `${identityUrl}/.well-known/jwks.json`,
        issuer: env.JWT_ISSUER || 'strafor-identity',
        ...(env.VACANCIES_URL ? { vacanciesUrl: env.VACANCIES_URL } : {}),
        ...(env.CANDIDATES_URL ? { candidatesUrl: env.CANDIDATES_URL } : {}),
        ...(env.RECRUITMENT_CORE_URL ? { recruitmentCoreUrl: env.RECRUITMENT_CORE_URL } : {}),
        ...(env.DOCUMENTS_URL ? { documentsUrl: env.DOCUMENTS_URL } : {}),
        ...(env.NOTIFICATIONS_URL ? { notificationsUrl: env.NOTIFICATIONS_URL } : {}),
        ...(env.AI_SERVICE_URL ? { aiServiceUrl: env.AI_SERVICE_URL } : {}),
        ...(env.HR_CORE_URL ? { hrCoreUrl: env.HR_CORE_URL } : {}),
        ...(env.TIME_ATTENDANCE_URL ? { timeAttendanceUrl: env.TIME_ATTENDANCE_URL } : {}),
        ...(env.PAYROLL_ADAPTER_URL ? { payrollAdapterUrl: env.PAYROLL_ADAPTER_URL } : {}),
        ...(env.HR_SERVICES_URL ? { hrServicesUrl: env.HR_SERVICES_URL } : {}),
        ...(env.CALENDAR_BRIDGE_URL ? { calendarBridgeUrl: env.CALENDAR_BRIDGE_URL } : {}),
        ...(env.STATIC_FALLBACK_URL ? { staticFallbackUrl: env.STATIC_FALLBACK_URL } : {}),
        ...(env.REDIS_URL ? { redisUrl: env.REDIS_URL } : {}),
        corsOrigins,
        proxyTimeoutMs: Number(env.PROXY_TIMEOUT_MS) || 10000,
        uploadTimeoutMs: Number(env.UPLOAD_TIMEOUT_MS) || 30000,
        ...overrides
    };
    return cfg;
}
