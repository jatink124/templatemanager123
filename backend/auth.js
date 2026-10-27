const crypto = require('crypto');

const SESSION_COOKIE = 'cm_admin_session';
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

function getConfigurationError(env = process.env) {
    if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
        return 'ADMIN_USERNAME and ADMIN_PASSWORD must be configured';
    }
    if (env.ADMIN_PASSWORD.length < 12) {
        return 'ADMIN_PASSWORD must be at least 12 characters long';
    }
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
        return 'SESSION_SECRET must be at least 32 characters long';
    }
    return null;
}

function safeEqual(actual, expected) {
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length
        && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function credentialsAreValid(username, password, env = process.env) {
    return !getConfigurationError(env)
        && typeof username === 'string'
        && typeof password === 'string'
        && safeEqual(username, env.ADMIN_USERNAME)
        && safeEqual(password, env.ADMIN_PASSWORD);
}

function createSessionToken(secret, now = Date.now()) {
    const payload = Buffer.from(JSON.stringify({ issuedAt: now })).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function verifySessionToken(token, secret, now = Date.now()) {
    if (typeof token !== 'string') return false;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return false;

    const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest();
    let actualSignature;
    try {
        actualSignature = Buffer.from(signature, 'base64url');
    } catch (error) {
        return false;
    }
    if (actualSignature.length !== expectedSignature.length
        || !crypto.timingSafeEqual(actualSignature, expectedSignature)) {
        return false;
    }

    try {
        const { issuedAt } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return Number.isSafeInteger(issuedAt)
            && issuedAt <= now + 60_000
            && now - issuedAt < SESSION_MAX_AGE_MS;
    } catch (error) {
        return false;
    }
}

function getCookieValue(cookieHeader, cookieName = SESSION_COOKIE) {
    if (typeof cookieHeader !== 'string') return null;
    const cookie = cookieHeader.split(';').map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`));
    return cookie ? cookie.slice(cookieName.length + 1) : null;
}

function isAuthenticated(cookieHeader, env = process.env, now = Date.now()) {
    if (getConfigurationError(env)) return false;
    const token = getCookieValue(cookieHeader);
    return verifySessionToken(token, env.SESSION_SECRET, now);
}

function createSessionCookie(token, env = process.env) {
    const secure = env.NODE_ENV === 'production' || env.NETLIFY === 'true';
    return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function clearSessionCookie(env = process.env) {
    const secure = env.NODE_ENV === 'production' || env.NETLIFY === 'true';
    return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

module.exports = {
    SESSION_COOKIE,
    SESSION_MAX_AGE_SECONDS,
    getConfigurationError,
    credentialsAreValid,
    createSessionToken,
    verifySessionToken,
    getCookieValue,
    isAuthenticated,
    createSessionCookie,
    clearSessionCookie
};
