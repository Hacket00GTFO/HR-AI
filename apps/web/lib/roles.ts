// Client-side role model. The backend enforces authorization on every call —
// this is only used to decide which navigation a session should see.
export const APP_ROLES = ['admin', 'hr', 'manager', 'employee', 'candidate'] as const;
export type AppRole = (typeof APP_ROLES)[number];

/**
 * Normalize a raw session/JWT role claim into a known AppRole.
 * Unknown, missing or tampered values return null → minimal navigation.
 */
export function normalizeRole(role: string | null | undefined): AppRole | null {
    if (!role) return null;
    const r = role.trim().toLowerCase();
    return (APP_ROLES as readonly string[]).includes(r) ? (r as AppRole) : null;
}
