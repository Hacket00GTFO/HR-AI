import type { Queryable } from '../db.js';

// Skills normalization helpers — dual-write layer (ported from the monolith's
// models/Skill.js).
//
// The canonical store is skills + candidate_skills / vacancy_skills. The raw
// text columns (candidates.skills CSV, vacancies.skills_required text[]) are
// still written because the frontend reads them. ai-matching normalizes
// through its own canonical_skills taxonomy.
//
// All functions take a Queryable (transaction client opened by the caller).

export function parseCsv(csv: unknown): string[] {
    return String(csv || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

export function parseList(list: unknown): string[] {
    const arr = Array.isArray(list) ? list : parseCsv(list);
    return arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

export async function upsertSkill(client: Queryable, name: string): Promise<number> {
    await client.query('INSERT INTO skills (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
    const { rows } = await client.query('SELECT id FROM skills WHERE name = $1', [name]);
    if (!rows[0]) throw new Error(`skill upsert returned no id for ${name}`);
    return rows[0].id;
}

// Recompute a candidate's skill links from the CSV skills string.
export async function syncCandidateSkills(client: Queryable, candidateId: number, csvSkills: unknown) {
    const names = [...new Set(parseCsv(csvSkills))];
    await client.query('DELETE FROM candidate_skills WHERE candidate_id = $1', [candidateId]);
    for (const name of names) {
        const skillId = await upsertSkill(client, name);
        await client.query(
            'INSERT INTO candidate_skills (candidate_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [candidateId, skillId]
        );
    }
    return names;
}

// Recompute a vacancy's skill links from a skills array (all marked required —
// the legacy schema has no optional/required distinction).
export async function syncVacancySkills(client: Queryable, vacancyId: number, skillsList: unknown) {
    const names = [...new Set(parseList(skillsList))];
    await client.query('DELETE FROM vacancy_skills WHERE vacancy_id = $1', [vacancyId]);
    for (const name of names) {
        const skillId = await upsertSkill(client, name);
        await client.query(
            'INSERT INTO vacancy_skills (vacancy_id, skill_id, required) VALUES ($1, $2, TRUE) ON CONFLICT DO NOTHING',
            [vacancyId, skillId]
        );
    }
    return names;
}

export async function namesForCandidate(db: Queryable, candidateId: number): Promise<string[]> {
    const { rows } = await db.query(
        `SELECT s.name FROM candidate_skills cs
         JOIN skills s ON s.id = cs.skill_id
         WHERE cs.candidate_id = $1 ORDER BY s.name`,
        [candidateId]
    );
    return rows.map((r) => r.name);
}

export async function namesForVacancy(db: Queryable, vacancyId: number): Promise<string[]> {
    const { rows } = await db.query(
        `SELECT s.name FROM vacancy_skills vs
         JOIN skills s ON s.id = vs.skill_id
         WHERE vs.vacancy_id = $1 ORDER BY s.name`,
        [vacancyId]
    );
    return rows.map((r) => r.name);
}
