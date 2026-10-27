const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const CUSTOMER_COOKIE = 'cm_customer_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class CustomerAuthError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'CustomerAuthError';
        this.statusCode = statusCode;
    }
}

function getSessionSecret(env = process.env) {
    return env.CUSTOMER_SESSION_SECRET || env.SESSION_SECRET;
}

function getConfigurationError(env = process.env) {
    const secret = getSessionSecret(env);
    if (!secret || secret.length < 32) {
        return 'A session secret of at least 32 characters must be configured';
    }
    return null;
}

function normalizeEmail(email) {
    if (typeof email !== 'string') {
        throw new CustomerAuthError('Enter a valid email address');
    }

    const normalized = email.trim().toLowerCase();
    if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
        throw new CustomerAuthError('Enter a valid email address');
    }
    return normalized;
}

function validateRegistration(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new CustomerAuthError('Invalid sign-up details');
    }

    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const email = normalizeEmail(input.email);
    const password = input.password;
    if (!name || name.length > 120) {
        throw new CustomerAuthError('Name is required and must be 120 characters or fewer');
    }
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
        throw new CustomerAuthError('Password must be between 10 and 128 characters');
    }
    return { name, email, password };
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derivedKey = await scrypt(password, salt, 64);
    return `${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

async function passwordMatches(password, storedHash) {
    if (typeof password !== 'string' || password.length > 128
        || typeof storedHash !== 'string') return false;
    const [saltHex, keyHex, extra] = storedHash.split(':');
    if (!saltHex || !keyHex || extra !== undefined || !/^[a-f0-9]{32}$/.test(saltHex)
        || !/^[a-f0-9]{128}$/.test(keyHex)) {
        return false;
    }

    const expected = Buffer.from(keyHex, 'hex');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

function sessionToken(customerId, env = process.env, now = Date.now()) {
    const payload = Buffer.from(JSON.stringify({
        sub: customerId,
        iat: now,
        exp: now + SESSION_MAX_AGE_SECONDS * 1000
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', getSessionSecret(env))
        .update(`customer:${payload}`)
        .digest('base64url');
    return `${payload}.${signature}`;
}

function verifySessionToken(token, env = process.env, now = Date.now()) {
    if (typeof token !== 'string' || getConfigurationError(env)) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;

    const expected = crypto.createHmac('sha256', getSessionSecret(env))
        .update(`customer:${payload}`)
        .digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

    try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (typeof claims.sub !== 'string' || !claims.sub
            || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
            || claims.iat > now + 60_000 || claims.exp <= now
            || claims.exp - claims.iat > SESSION_MAX_AGE_SECONDS * 1000) {
            return null;
        }
        return claims.sub;
    } catch (error) {
        return null;
    }
}

function cookieValue(cookieHeader) {
    if (typeof cookieHeader !== 'string') return null;
    const cookie = cookieHeader.split(';').map((part) => part.trim())
        .find((part) => part.startsWith(`${CUSTOMER_COOKIE}=`));
    return cookie ? cookie.slice(CUSTOMER_COOKIE.length + 1) : null;
}

function customerIdFromCookie(cookieHeader, env = process.env) {
    return verifySessionToken(cookieValue(cookieHeader), env);
}

function createSessionCookie(customerId, env = process.env) {
    const secure = env.NODE_ENV === 'production' || env.NETLIFY === 'true';
    const token = sessionToken(customerId, env);
    return `${CUSTOMER_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function clearSessionCookie(env = process.env) {
    const secure = env.NODE_ENV === 'production' || env.NETLIFY === 'true';
    return `${CUSTOMER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

async function verifyGoogleCredential(credential, env = process.env, fetchImpl = fetch) {
    if (!env.GOOGLE_CLIENT_ID) {
        throw new CustomerAuthError('Google sign-in is not configured yet', 503);
    }
    if (typeof credential !== 'string' || credential.length > 10000) {
        throw new CustomerAuthError('Invalid Google sign-in credential', 401);
    }

    const url = new URL('https://oauth2.googleapis.com/tokeninfo');
    url.searchParams.set('id_token', credential);
    let response;
    try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    } catch (error) {
        throw new CustomerAuthError('Could not verify Google sign-in. Please try again.', 502);
    }
    if (!response.ok) {
        throw new CustomerAuthError('Google sign-in could not be verified', 401);
    }

    let claims;
    try {
        claims = await response.json();
    } catch (error) {
        throw new CustomerAuthError('Google returned an invalid sign-in response', 502);
    }

    const issuerIsGoogle = claims.iss === 'accounts.google.com'
        || claims.iss === 'https://accounts.google.com';
    if (!issuerIsGoogle || claims.aud !== env.GOOGLE_CLIENT_ID
        || !claims.sub || !claims.email
        || (claims.email_verified !== 'true' && claims.email_verified !== true)
        || !Number.isFinite(Number(claims.exp)) || Number(claims.exp) * 1000 <= Date.now()) {
        throw new CustomerAuthError('Google sign-in could not be verified', 401);
    }

    return {
        googleSub: String(claims.sub),
        email: normalizeEmail(claims.email),
        name: typeof claims.name === 'string' && claims.name.trim()
            ? claims.name.trim().slice(0, 120)
            : claims.email.slice(0, 120)
    };
}

function publicCustomer(customer) {
    return {
        id: customer.id,
        name: customer.name,
        email: customer.email
    };
}

module.exports = {
    CUSTOMER_COOKIE,
    CustomerAuthError,
    getConfigurationError,
    normalizeEmail,
    validateRegistration,
    hashPassword,
    passwordMatches,
    customerIdFromCookie,
    createSessionCookie,
    clearSessionCookie,
    verifyGoogleCredential,
    publicCustomer
};
