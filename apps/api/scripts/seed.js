require('dotenv').config();
const bcrypt = require('bcryptjs');
const { faker } = require('@faker-js/faker');
const db = require('../db');
const logger = require('../utils/logger');

/**
 * Reproducible demo seed (faker.seed(42)) for local dev / AI evaluation:
 *   - 1 admin + 2 HR users (passwords from env, see below)
 *   - ~15 vacancies across departments (owned by the HR users)
 *   - ~80 candidates with realistic skills
 *   - applications spread across all statuses, with status history
 *
 * Idempotent: exits early when any user already exists.
 *
 *   ADMIN_PASSWORD / HR_PASSWORD env vars control the seeded credentials
 *   (defaults are dev-only values — change them anywhere real).
 */

faker.seed(42);

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@strafor.dev').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin1234!';
const HR_PASSWORD = process.env.HR_PASSWORD || 'HrUser1234!';

const DEPARTMENTS = ['Engineering', 'Data', 'Product', 'Design', 'Sales', 'HR'];
const TYPES = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship'];
const LEVELS = ['Entry Level', 'Mid Level', 'Senior Level', 'Executive'];
const STATUSES = ['pending', 'pending', 'interview', 'accepted', 'rejected'];
const SKILL_POOL = [
    'javascript',
    'typescript',
    'node.js',
    'react',
    'python',
    'java',
    'sql',
    'postgresql',
    'mongodb',
    'docker',
    'kubernetes',
    'aws',
    'azure',
    'git',
    'ci/cd',
    'graphql',
    'rest apis',
    'machine learning',
    'pandas',
    'tensorflow',
    'figma',
    'ux research',
    'product management',
    'agile',
    'scrum',
    'excel',
    'communication',
    'leadership',
    'recruiting',
    'negotiation'
];
const EDUCATION = ['High School', 'Associate', 'Bachelor', 'Master', 'PhD'];

const pick = (arr) => arr[faker.number.int({ min: 0, max: arr.length - 1 })];
const pickN = (arr, n) => faker.helpers.arrayElements(arr, n);

async function insertUser(client, { firstName, lastName, email, password, role, location }) {
    const hashed = await bcrypt.hash(password, 10);
    const { rows } = await client.query(
        `INSERT INTO users (first_name, last_name, email, password, role, location)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [firstName, lastName, email, hashed, role, location ? JSON.stringify(location) : null]
    );
    return rows[0].id;
}

async function upsertSkill(client, name) {
    await client.query('INSERT INTO skills (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
    const { rows } = await client.query('SELECT id FROM skills WHERE name = $1', [name]);
    return rows[0].id;
}

async function seed() {
    const { rows: existing } = await db.query('SELECT COUNT(*)::int AS n FROM users');
    if (existing[0].n > 0) {
        console.log('Seed skipped — users table is not empty.');
        return;
    }

    await db.withTransaction(async (client) => {
        const adminId = await insertUser(client, {
            firstName: 'Admin',
            lastName: 'User',
            email: ADMIN_EMAIL,
            password: ADMIN_PASSWORD,
            role: 'admin',
            location: null
        });
        const hrIds = [];
        for (const [i, country, city] of [
            [1, 'Mexico', 'Guadalajara'],
            [2, 'United States', 'Austin']
        ]) {
            hrIds.push(
                await insertUser(client, {
                    firstName: faker.person.firstName(),
                    lastName: faker.person.lastName(),
                    email: `hr${i}@strafor.dev`,
                    password: HR_PASSWORD,
                    role: 'hr',
                    location: { country, city }
                })
            );
        }

        // Vacancies
        const vacancyIds = [];
        for (let i = 0; i < 15; i++) {
            const skills = pickN(SKILL_POOL, faker.number.int({ min: 3, max: 6 }));
            const min = faker.number.int({ min: 30, max: 90 }) * 1000;
            const { rows } = await client.query(
                `INSERT INTO vacancies (title, company, location, type, description, requirements,
                    responsibilities, skills_required, experience_level, salary_min, salary_max,
                    salary_currency, benefits, remote_option, status, created_by_user_id, department)
                 VALUES ($1,'Tech Mahindra',$2,$3,$4,$5,$6,$7,$8,$9,$10,'MXN',$11,$12,'Active',$13,$14)
                 RETURNING id`,
                [
                    `${pick(['Senior', 'Mid', 'Junior', 'Lead', ''])} ${faker.person.jobTitle()}`.trim(),
                    faker.location.city(),
                    pick(TYPES),
                    faker.lorem.paragraph(),
                    faker.lorem.paragraph(),
                    faker.lorem.paragraph(),
                    skills,
                    pick(LEVELS),
                    min,
                    min + faker.number.int({ min: 10, max: 40 }) * 1000,
                    pickN(['Health insurance', 'Remote work', 'Bonus', 'Stock options', 'Gym'], 2),
                    faker.datatype.boolean(),
                    pick(hrIds),
                    pick(DEPARTMENTS)
                ]
            );
            const vacancyId = rows[0].id;
            vacancyIds.push(vacancyId);
            for (const name of skills) {
                const skillId = await upsertSkill(client, name);
                await client.query(
                    'INSERT INTO vacancy_skills (vacancy_id, skill_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
                    [vacancyId, skillId]
                );
            }
        }

        // Candidates + applications
        for (let i = 0; i < 80; i++) {
            const skills = pickN(SKILL_POOL, faker.number.int({ min: 2, max: 8 }));
            const { rows } = await client.query(
                `INSERT INTO candidates (first_name, last_name, email, phone, linkedin, experience,
                    education, location, skills, current_position)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
                [
                    faker.person.firstName(),
                    faker.person.lastName(),
                    faker.internet.email().toLowerCase(),
                    faker.phone.number(),
                    `https://linkedin.com/in/${faker.internet.username().toLowerCase()}`,
                    faker.number.int({ min: 0, max: 20 }),
                    pick(EDUCATION),
                    `${faker.location.city()}, ${faker.location.country()}`,
                    skills.join(', '),
                    faker.person.jobTitle()
                ]
            );
            const candidateId = rows[0].id;
            for (const name of skills) {
                const skillId = await upsertSkill(client, name);
                await client.query(
                    'INSERT INTO candidate_skills (candidate_id, skill_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
                    [candidateId, skillId]
                );
            }

            // 1–2 applications per candidate, spread across statuses
            const applications = faker.number.int({ min: 1, max: 2 });
            const usedVacancies = pickN(vacancyIds, applications);
            for (const vacancyId of usedVacancies) {
                const status = pick(STATUSES);
                const appliedAt = faker.date.recent({ days: 45 });
                const { rows: app } = await client.query(
                    `INSERT INTO applications (candidate_id, vacancy_id, status, applied_at, created_by)
                     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
                    [candidateId, vacancyId, status, appliedAt, pick(hrIds)]
                );
                const applicationId = app[0].id;
                await client.query(
                    `INSERT INTO application_status_history (application_id, from_status, to_status, changed_by, changed_at, note)
                     VALUES ($1, NULL, 'pending', $2, $3, 'Application created')`,
                    [applicationId, pick(hrIds), appliedAt]
                );
                if (status !== 'pending') {
                    await client.query(
                        `INSERT INTO application_status_history (application_id, from_status, to_status, changed_by, changed_at)
                         VALUES ($1, 'pending', $2, $3, $4)`,
                        [applicationId, status, pick(hrIds), faker.date.between({ from: appliedAt, to: new Date() })]
                    );
                }
                if (status === 'accepted' && faker.datatype.boolean()) {
                    await client.query(
                        `UPDATE applications SET hiring_feedback = $1, feedback_timestamp = now()
                         WHERE id = $2`,
                        [faker.lorem.sentence(), applicationId]
                    );
                }
            }
        }

        await client.query(
            `INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, metadata)
             VALUES ($1, 'seed.run', 'database', NULL, $2)`,
            [adminId, JSON.stringify({ script: 'scripts/seed.js', seed: 42 })]
        );
    });

    const counts = {};
    for (const t of [
        'users',
        'vacancies',
        'candidates',
        'applications',
        'application_status_history',
        'skills',
        'candidate_skills',
        'vacancy_skills'
    ]) {
        const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
        counts[t] = rows[0].n;
    }
    console.log('Seed complete:', counts);
}

async function main() {
    try {
        await db.waitForConnection();
        await db.runMigrations();
        await seed();
        await db.shutdown();
        process.exit(0);
    } catch (err) {
        logger.error('Seed failed:', err);
        process.exit(1);
    }
}

main();
