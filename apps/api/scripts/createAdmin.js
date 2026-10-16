require('dotenv').config();
const User = require('../models/User');
const db = require('../db');

// Usage:
//   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=... node scripts/createAdmin.js
//   node scripts/createAdmin.js admin@example.com 'P@ssw0rd' [First] [Last]
//
// There is intentionally NO default password — it must come from the
// ADMIN_PASSWORD env var or the second CLI argument.

async function createAdmin() {
    const [, , argEmail, argPassword, argFirstName, argLastName] = process.argv;

    const email = (process.env.ADMIN_EMAIL || argEmail || '').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || argPassword;
    const firstName = process.env.ADMIN_FIRST_NAME || argFirstName || 'Admin';
    const lastName = process.env.ADMIN_LAST_NAME || argLastName || 'User';

    if (!email || !password) {
        console.error('Usage: ADMIN_EMAIL=<email> ADMIN_PASSWORD=<password> node scripts/createAdmin.js');
        console.error('   or: node scripts/createAdmin.js <email> <password> [firstName] [lastName]');
        process.exit(1);
    }
    if (password.length < 8) {
        console.error('Refusing to create admin: password must be at least 8 characters.');
        process.exit(1);
    }

    try {
        // Connect to PostgreSQL and apply pending migrations
        await db.waitForConnection();
        await db.runMigrations();

        // Check if admin already exists
        const existingAdmin = await User.findByEmail(email);
        if (existingAdmin) {
            console.log('Admin account already exists');
            process.exit(0);
        }

        await User.create({
            firstName,
            lastName,
            email,
            password,
            role: 'admin',
            location: null
        });

        console.log('Admin account created successfully');
        process.exit(0);
    } catch (error) {
        console.error('Error creating admin account:', error.message);
        process.exit(1);
    }
}

createAdmin();
