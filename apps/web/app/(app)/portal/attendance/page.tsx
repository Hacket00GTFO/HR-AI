import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AttendanceClient } from '@/components/portal/attendance-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('portal.attendance');
    return { title: t('title') };
}

export default function PortalAttendancePage() {
    return <AttendanceClient />;
}
