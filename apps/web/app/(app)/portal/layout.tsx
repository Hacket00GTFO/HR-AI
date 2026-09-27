import { PortalNav } from '@/components/portal/portal-nav';

// Employee self-service portal section: adds the portal section tabs under
// the shared AppShell chrome (which stays responsible for primary nav).
export default function PortalLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-6">
            <PortalNav />
            {children}
        </div>
    );
}
