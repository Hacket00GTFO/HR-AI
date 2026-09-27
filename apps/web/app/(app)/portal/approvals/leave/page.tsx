import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ApprovalsLeaveClient } from '@/components/portal/approvals-leave-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('portal.approvals.leave');
    return { title: t('title') };
}

// Pending leave requests queue — approve/reject (hr/manager reviewers).
export default function PortalApprovalsLeavePage() {
    return <ApprovalsLeaveClient />;
}
