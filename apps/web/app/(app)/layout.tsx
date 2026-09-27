import { AppShell } from '@/components/app-shell';
import { getSessionUser } from '@/lib/session';
import { normalizeRole } from '@/lib/roles';

// Authenticated section: middleware guarantees a session cookie exists here.
// The role is resolved once on the server (user cookie → JWT payload fallback)
// and handed to the client nav — gating is UX only, services enforce access.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
    const user = await getSessionUser();
    const role = normalizeRole(user?.role);

    return (
        <AppShell user={user} role={role}>
            {children}
        </AppShell>
    );
}
