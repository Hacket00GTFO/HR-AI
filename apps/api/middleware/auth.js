const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const db = require('../db');
const logger = require('../utils/logger');
const redisClient = require('../utils/redis');
require('dotenv').config();

// ---- Token verification strategy ----
// Identity-auth issues RS256 access tokens; the monolith verifies them
// against the service's JWKS endpoint. Legacy HS256 tokens (JWT_SECRET) are
// accepted ONLY when ALLOW_LEGACY_HS256=true (default false) — a temporary
// escape hatch while sessions roll over.
const IDENTITY_JWKS_URL = process.env.IDENTITY_JWKS_URL || 'http://localhost:3001/.well-known/jwks.json';
const JWT_ISSUER = process.env.JWT_ISSUER || 'strafor-identity';
const ALLOW_LEGACY_HS256 = (process.env.ALLOW_LEGACY_HS256 || '').toLowerCase() === 'true';

const jwks = jwksClient({
    jwksUri: IDENTITY_JWKS_URL,
    cache: true,
    cacheMaxAge: 10 * 60 * 1000,
    rateLimit: true,
    jwksRequestsPerMinute: 10,
    timeout: 5000
});

function getSigningKey(kid) {
    return new Promise((resolve, reject) => {
        jwks.getSigningKey(kid, (err, key) => {
            if (err) reject(err);
            else resolve(key.getPublicKey());
        });
    });
}

function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        // Fail fast: never sign/verify with a missing or default secret.
        throw new Error('JWT_SECRET environment variable is required');
    }
    return secret;
}

/**
 * Verify the signature + expiry of a bearer token.
 * Returns { decoded, viaLegacy } or throws {status, message}.
 */
async function verifySignature(token) {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || !decoded.header) {
        throw Object.assign(new Error('Invalid token'), { status: 401 });
    }
    const alg = decoded.header.alg;

    if (alg === 'RS256') {
        const kid = decoded.header.kid;
        if (!kid) {
            throw Object.assign(new Error('Invalid token'), { status: 401 });
        }
        let publicKey;
        try {
            publicKey = await getSigningKey(kid);
        } catch (err) {
            const status = err && err.name === 'SigningKeyNotFoundError' ? 401 : 503;
            throw Object.assign(new Error(status === 503 ? 'Authentication service unavailable' : 'Invalid token'), {
                status
            });
        }
        const claims = jwt.verify(token, publicKey, {
            algorithms: ['RS256'],
            issuer: JWT_ISSUER
        });
        // Identity access-token claims: {sub, email, role, location, jti, iss}
        return {
            decoded: {
                id: Number(claims.sub),
                email: claims.email,
                role: claims.role,
                location: claims.location,
                jti: claims.jti
            },
            viaLegacy: false
        };
    }

    if (alg === 'HS256' && ALLOW_LEGACY_HS256) {
        const claims = jwt.verify(token, getJwtSecret());
        return { decoded: claims, viaLegacy: true };
    }

    throw Object.assign(new Error('Invalid token'), { status: 401 });
}

// Revocation: Redis blacklist bl:<jti> (written by identity-auth on logout)
// when REDIS_URL is configured; otherwise the local users.logged_out flag —
// the pre-extraction mechanism — remains the fallback.
async function isRevoked(decoded, viaLegacy) {
    const redis = redisClient.get();
    if (redis) {
        if (decoded.jti) {
            try {
                if ((await redis.exists(`bl:${decoded.jti}`)) === 1) return true;
            } catch (err) {
                logger.error('Redis blacklist check failed:', err);
            }
        }
        // Legacy tokens carry no jti — keep enforcing logged_out for them.
        if (!viaLegacy) return false;
    }
    try {
        const { rows } = await db.query('SELECT logged_out, active FROM users WHERE id = $1 AND deleted_at IS NULL', [
            decoded.id
        ]);
        const user = rows[0];
        return !user || user.logged_out === true || user.active === false;
    } catch (error) {
        logger.error('Token revocation check failed:', error);
        throw Object.assign(new Error('Authentication service unavailable'), { status: 503 });
    }
}

// Verify JWT token middleware.
const verifyToken = async (req, res, next) => {
    const header = req.headers.authorization;
    const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
        return res.status(401).json({ message: 'No token provided' });
    }

    let decoded;
    let viaLegacy;
    try {
        ({ decoded, viaLegacy } = await verifySignature(token));
    } catch (error) {
        const status = Number.isInteger(error.status) ? error.status : 401;
        return res.status(status).json({ message: error.message || 'Invalid token' });
    }

    try {
        if (await isRevoked(decoded, viaLegacy)) {
            return res.status(401).json({ message: 'Token is no longer valid' });
        }
    } catch (error) {
        return res.status(error.status || 503).json({ message: error.message });
    }

    req.user = {
        id: decoded.id,
        email: decoded.email,
        role: decoded.role
    };
    next();
};

// Check if user is admin
const isAdmin = (req, res, next) => {
    verifyToken(req, res, () => {
        if (req.user && req.user.role === 'admin') {
            next();
        } else {
            res.status(403).json({ message: 'Access denied. Admin privileges required.' });
        }
    });
};

// Check if user is HR — strictly role 'hr'. Admins do NOT inherit HR
// capabilities: recruitment and HR operations belong to HR, while admins own
// platform management (accounts, settings, integrations, audit).
const isHR = (req, res, next) => {
    verifyToken(req, res, () => {
        if (req.user && req.user.role === 'hr') {
            next();
        } else {
            res.status(403).json({ message: 'Access denied. HR privileges required.' });
        }
    });
};

// Any staff member (admin OR hr). For read-only surfaces that show job/ops
// metadata (no business record content) — e.g. the bulk-operations list.
const isStaff = (req, res, next) => {
    verifyToken(req, res, () => {
        if (req.user && (req.user.role === 'hr' || req.user.role === 'admin')) {
            next();
        } else {
            res.status(403).json({ message: 'Access denied. Staff privileges required.' });
        }
    });
};

module.exports = {
    verifyToken,
    isAdmin,
    isHR,
    isStaff,
    getJwtSecret
};
