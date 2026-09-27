import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ExpensesClient } from '@/components/portal/expenses-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('portal.expenses');
    return { title: t('title') };
}

export default function PortalExpensesPage() {
    return <ExpensesClient />;
}
