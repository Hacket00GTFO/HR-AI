const db = require('../db');

// Skills normalization helpers — dual-write layer.
//
// The canonical store is skills + candidate_skills / vacancy_skills. The raw
// text columns (candidates.skills CSV, vacancies.skills_required text[]) are
// still written by the models because the frontend reads them. The
// ai-matching service normalizes through its own canonical_skills taxonomy;
// once nothing reads the raw columns they can be dropped and these helpers
// become the only write path.
//
// All functions take a pg Client (inside a transaction opened by the caller).

function parseCsv(csv) {
    return String(csv || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

function parseList(list) {
    const arr = Array.isArray(list) ? list : parseCsv(list);
    return arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

async function upsertSkill(client, name) {
    await client.query('INSERT INTO skills (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
    const { rows } = await client.query('SELECT id FROM skills WHERE name = $1', [name]);
    return rows[0].id;
}

// Recompute a candidate's skill links from the CSV skills string.
async function syncCandidateSkills(client, candidateId, csvSkills) {
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
async function syncVacancySkills(client, vacancyId, skillsList) {
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

async function namesForCandidate(candidateId) {
    const { rows } = await db.query(
        `SELECT s.name FROM candidate_skills cs
         JOIN skills s ON s.id = cs.skill_id
         WHERE cs.candidate_id = $1 ORDER BY s.name`,
        [candidateId]
    );
    return rows.map((r) => r.name);
}

async function namesForVacancy(vacancyId) {
    const { rows } = await db.query(
        `SELECT s.name FROM vacancy_skills vs
         JOIN skills s ON s.id = vs.skill_id
         WHERE vs.vacancy_id = $1 ORDER BY s.name`,
        [vacancyId]
    );
    return rows.map((r) => r.name);
}

module.exports = {
    parseCsv,
    parseList,
    upsertSkill,
    syncCandidateSkills,
    syncVacancySkills,
    namesForCandidate,
    namesForVacancy
};
