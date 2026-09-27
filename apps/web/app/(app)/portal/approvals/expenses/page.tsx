import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ApprovalsExpensesClient } from '@/components/portal/approvals-expenses-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('portal.approvals.expenses');
    return { title: t('title') };
}

// Pending expense reports queue — approve/reject with line-item review (hr).
export default function PortalApprovalsExpensesPage() {
    return <ApprovalsExpensesClient />;
}
