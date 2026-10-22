import bcrypt from 'bcryptjs';

const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
    const salt = await bcrypt.genSalt(BCRYPT_COST);
    return bcrypt.hash(plain, salt);
}

export async function comparePassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
}

/**
 * Policy: min 8 chars, at least 3 character classes among
 * lower / upper / digit / symbol ("mixed classes").
 */
export function passwordPolicyOk(password: string): boolean {
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) return false;
    let classes = 0;
    if (/[a-z]/.test(password)) classes += 1;
    if (/[A-Z]/.test(password)) classes += 1;
    if (/[0-9]/.test(password)) classes += 1;
    if (/[^a-zA-Z0-9]/.test(password)) classes += 1;
    return classes >= 3;
}

export const PASSWORD_POLICY_MESSAGE =
    'Password must be at least 8 characters and mix 3 of: lowercase, uppercase, digits, symbols';
