import { apiUrl } from './api';
import { vacancyListSchema, type Vacancy } from './schemas';

// Server-side vacancies fetch for the public careers pages. Revalidates every
// 60s so the list is cached but not stale.
export async function fetchVacancies(): Promise<{ data: Vacancy[] | null; error: boolean }> {
    try {
        const res = await fetch(apiUrl('vacancies'), {
            headers: { Accept: 'application/json' },
            next: { revalidate: 60 }
        });
        if (!res.ok) return { data: null, error: true };
        const parsed = vacancyListSchema.safeParse(await res.json());
        return parsed.success ? { data: parsed.data, error: false } : { data: null, error: true };
    } catch {
        return { data: null, error: true };
    }
}
