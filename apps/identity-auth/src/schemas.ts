import { z } from 'zod';
import { passwordPolicyOk, PASSWORD_POLICY_MESSAGE } from './passwords.js';

export const email = z.string().trim().toLowerCase().email().max(255);

export const password = z.string().min(8).max(200).refine(passwordPolicyOk, { message: PASSWORD_POLICY_MESSAGE });

export const locationObj = z
    .object({
        country: z.string().max(100).optional(),
        city: z.string().max(100).optional()
    })
    .strip();

export const roleEnum = z.enum(['admin', 'hr']);

export const idParam = z.object({
    id: z.coerce.number().int().positive()
});

// ---------- auth ----------
export const loginBody = z
    .object({
        email,
        password: z.string().min(1).max(200)
    })
    .strict();

export const registerBody = z
    .object({
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().min(1).max(100),
        email,
        password,
        role: roleEnum,
        location: locationObj.optional()
    })
    .strict();

export const refreshBody = z
    .object({
        refreshToken: z.string().min(1).max(500)
    })
    .strict();

export const logoutBody = z
    .object({
        refreshToken: z.string().min(1).max(500).optional()
    })
    .strict();

export const forgotBody = z.object({ email }).strict();

// ---------- mfa ----------
/** Enrollment confirm — authenticated, verifies the first TOTP for a pending secret. */
export const mfaConfirmBody = z
    .object({
        code: z.string().trim().min(6).max(10)
    })
    .strict();

/** Login challenge exchange — public. One of totp_code / recovery_code required. */
export const mfaChallengeBody = z
    .object({
        challenge_token: z.string().min(1).max(4000),
        totp_code: z
            .string()
            .trim()
            .regex(/^\d{6}$/)
            .optional(),
        recovery_code: z.string().trim().min(4).max(20).optional()
    })
    .strict()
    .refine((v) => v.totp_code !== undefined || v.recovery_code !== undefined, {
        message: 'totp_code or recovery_code is required'
    });

export const mfaDisableBody = z
    .object({
        password: z.string().min(1).max(200)
    })
    .strict();

/** Admin reset of another user's MFA (lost device etc.). */
export const mfaResetBody = z
    .object({
        userId: z.coerce.number().int().positive()
    })
    .strict();

export const resetBody = z
    .object({
        token: z.string().min(1).max(500),
        newPassword: password
    })
    .strict();

export const changePasswordBody = z
    .object({
        currentPassword: z.string().min(1).max(200),
        newPassword: password
    })
    .strict();

// ---------- users ----------
export const userCreateBody = registerBody;

export const userUpdateBody = z
    .object({
        firstName: z.string().trim().min(1).max(100).optional(),
        lastName: z.string().trim().min(1).max(100).optional(),
        email: email.optional(),
        password: password.optional(),
        role: roleEnum.optional(),
        location: locationObj.optional().nullable(),
        active: z.boolean().optional()
    })
    .strict();

/** Fields a non-admin may change on their own record. */
export const SELF_UPDATE_FIELDS = new Set(['firstName', 'lastName', 'location']);

export const listUsersQuery = z
    .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(500).default(50),
        role: roleEnum.optional(),
        q: z.string().trim().max(200).optional()
    })
    .strip();

// ---------- settings ----------
export const userSettingsBody = z
    .object({
        company: z
            .object({
                name: z.string().trim().max(255).optional(),
                industry: z.string().trim().max(255).optional(),
                size: z.union([z.string().max(50), z.number()]).optional(),
                location: z.union([z.string().max(255), locationObj]).optional()
            })
            .strip()
            .optional(),
        theme: z.string().max(50).optional(),
        notifications: z.boolean().optional()
    })
    .strip();

export const integrationsBody = z
    .object({
        linkedin: z
            .object({
                clientId: z.string().min(1).max(500),
                clientSecret: z.string().min(1).max(500),
                redirectUri: z.string().min(1).max(1000)
            })
            .strict()
            .optional(),
        occ: z
            .object({
                apiKey: z.string().min(1).max(500),
                apiSecret: z.string().min(1).max(500),
                environment: z.string().max(50).optional()
            })
            .strict()
            .optional(),
        theme: z.string().max(50).optional(),
        notifications: z.boolean().optional()
    })
    .strip();
