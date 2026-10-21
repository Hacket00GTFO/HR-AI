import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/lib/auth';

export default async function IndexPage() {
    const store = await cookies();
    redirect(store.get(SESSION_COOKIE)?.value ? '/dashboard' : '/login');
}
