const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken, isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const { validate } = require('../middleware/validate');
const schemas = require('../middleware/schemas');
const { callIdentity, legacyError, legacyUser } = require('../utils/serviceClient');
require('dotenv').config();

// ── Strangler proxy ─────────────────────────────────────────────────────────
// Authentication moved to apps/identity-auth (RS256 tokens, rotating refresh
// tokens). These routes keep the LEGACY wire contract — {token, user, message}
// — while forwarding to IDENTITY_URL/v1/auth/*. The identity service returns
// {accessToken, refreshToken, tokenType, expiresIn, user}; we map
// accessToken→token and keep the new fields for clients that want refresh.

function authSuccess(data, message) {
    return {
        token: data.accessToken,
        refreshToken: data.refreshToken,
        tokenType: data.tokenType,
        expiresIn: data.expiresIn,
        user: legacyUser(data.user),
        message
    };
}

// Login route (public, rate-limited in server.js)
router.post('/login', validate({ body: schemas.loginBody }), async (req, res) => {
    try {
        const { status, data } = await callIdentity(req, {
            method: 'POST',
            path: '/v1/auth/login',
            body: { email: req.body.email, password: req.body.password }
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'An error occurred during login'));
        }
        res.status(status).json(authSuccess(data, 'Login successful'));
    } catch (error) {
        logger.error('Login error:', error);
        res.status(500).json({ message: 'An error occurred during login' });
    }
});

// Register route (protected for admin only, rate-limited in server.js)
router.post('/register', isAdmin, validate({ body: schemas.registerBody }), async (req, res) => {
    try {
        const { firstName, lastName, email, password, role, location } = req.body;

        // Validate location object for HR role (same guard as before the move).
        if (role === 'hr' && (!location || !location.country || !location.city)) {
            return res.status(400).json({
                message: 'Missing location information',
                details: 'Country and city are required for HR accounts'
            });
        }

        const { status, data } = await callIdentity(req, {
            method: 'POST',
            path: '/v1/auth/register',
            body: { firstName, lastName, email, password, role, location }
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'An error occurred during registration'));
        }
        res.status(status).json(authSuccess(data, 'User registered successfully'));
    } catch (error) {
        logger.error('Registration error:', error);
        res.status(500).json({ message: 'An error occurred during registration' });
    }
});

// Get list of countries (no auth required) — DB is authoritative
// (seeded from data/countries.js at migration time). Stays local: the
// countries table is owned by the monolith, not by identity-auth.
router.get('/countries', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT name FROM countries ORDER BY name');
        res.json(rows.map((r) => r.name));
    } catch (error) {
        logger.error('Error fetching countries:', error);
        res.status(500).json({ message: 'Error fetching countries' });
    }
});

// Logout — identity-auth blacklists the access token jti (Redis) and revokes
// the refresh-token family. If the client holds a refreshToken, forward it so
// only that family dies; otherwise identity revokes all sessions for the user.
router.post('/logout', verifyToken, async (req, res) => {
    try {
        const { status, data } = await callIdentity(req, {
            method: 'POST',
            path: '/v1/auth/logout',
            body: req.body && req.body.refreshToken ? { refreshToken: req.body.refreshToken } : {}
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'An error occurred during logout'));
        }
        res.json({
            message: 'Logged out successfully',
            status: 'logged_out'
        });
    } catch (error) {
        logger.error('Logout error:', error);
        res.status(500).json({ message: 'An error occurred during logout' });
    }
});

// Token refresh — NEW endpoint surfaced through the legacy surface so clients
// can renew sessions without re-login. Public (the refresh token is the
// credential). Response keeps the identity shape + the legacy `token` alias.
router.post('/refresh', validate({ body: schemas.refreshBody }), async (req, res) => {
    try {
        const { status, data } = await callIdentity(req, {
            method: 'POST',
            path: '/v1/auth/refresh',
            body: { refreshToken: req.body.refreshToken }
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Invalid or expired refresh token'));
        }
        res.status(status).json({
            token: data.accessToken,
            refreshToken: data.refreshToken,
            tokenType: data.tokenType,
            expiresIn: data.expiresIn,
            user: legacyUser(data.user)
        });
    } catch (error) {
        logger.error('Refresh error:', error);
        res.status(500).json({ message: 'An error occurred during token refresh' });
    }
});

// Password reset request (public — always 200, never reveals account existence)
router.post('/password/forgot', validate({ body: schemas.forgotBody }), async (req, res) => {
    try {
        const { data } = await callIdentity(req, {
            method: 'POST',
            path: '/v1/auth/password/forgot',
            body: { email: req.body.email }
        });
        res.json({ message: (data && data.message) || 'If the account exists, a reset link has been sent' });
    } catch (error) {
        logger.error('Password forgot error:', error);
        res.json({ message: 'If the account exists, a reset link has been sent' });
    }
});

// Password reset with a mailed token (public)
router.post('/password/reset', validate({ body: schemas.resetBody }), async (req, res) => {
    try {
        const { status, data } = await callIdentity(req, {
            method: 'POST',
            path: '/v1/auth/password/reset',
            body: { token: req.body.token, newPassword: req.body.newPassword }
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Invalid or expired reset token'));
        }
        res.json({ message: 'Password reset successfully' });
    } catch (error) {
        logger.error('Password reset error:', error);
        res.status(500).json({ message: 'An error occurred during password reset' });
    }
});

// Password change (authenticated — revokes every session incl. this token)
router.post('/password/change', verifyToken, validate({ body: schemas.changePasswordBody }), async (req, res) => {
    try {
        const { status, data } = await callIdentity(req, {
            method: 'POST',
            path: '/v1/auth/password/change',
            body: { currentPassword: req.body.currentPassword, newPassword: req.body.newPassword }
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'An error occurred during password change'));
        }
        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        logger.error('Password change error:', error);
        res.status(500).json({ message: 'An error occurred during password change' });
    }
});

module.exports = {
    router,
    verifyToken,
    isAdmin
};
