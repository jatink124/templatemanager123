const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('./auth');

const env = {
    ADMIN_USERNAME: 'seller',
    ADMIN_PASSWORD: 'a-long-test-password',
    SESSION_SECRET: 'a-test-session-secret-that-is-long-enough',
    NODE_ENV: 'test'
};

test('authentication configuration requires strong secrets', () => {
    assert.equal(auth.getConfigurationError(env), null);
    assert.match(auth.getConfigurationError({ ...env, ADMIN_PASSWORD: 'short' }), /12 characters/);
    assert.match(auth.getConfigurationError({ ...env, SESSION_SECRET: 'short' }), /32 characters/);
});

test('credentials are checked against the configured admin', () => {
    assert.equal(auth.credentialsAreValid('seller', 'a-long-test-password', env), true);
    assert.equal(auth.credentialsAreValid('other', 'a-long-test-password', env), false);
    assert.equal(auth.credentialsAreValid('seller', 'wrong-password', env), false);
    assert.equal(auth.credentialsAreValid('seller', 'a-long-test-password', {}), false);
});

test('session tokens expire and reject tampering', () => {
    const now = 1_800_000_000_000;
    const token = auth.createSessionToken(env.SESSION_SECRET, now);
    assert.equal(auth.verifySessionToken(token, env.SESSION_SECRET, now), true);
    assert.equal(auth.verifySessionToken(token, 'another-secret-that-is-long-enough', now), false);
    assert.equal(auth.verifySessionToken(`${token}x`, env.SESSION_SECRET, now), false);
    assert.equal(auth.verifySessionToken(token, env.SESSION_SECRET, now + 8 * 60 * 60 * 1000), false);
    assert.equal(auth.verifySessionToken(null, env.SESSION_SECRET, now), false);
});

test('session cookie is HttpOnly, same-site, and optionally secure', () => {
    const token = auth.createSessionToken(env.SESSION_SECRET);
    assert.match(auth.createSessionCookie(token, env), /HttpOnly/);
    assert.match(auth.createSessionCookie(token, env), /SameSite=Strict/);
    assert.doesNotMatch(auth.createSessionCookie(token, env), /; Secure/);
    assert.match(
        auth.createSessionCookie(token, { ...env, NODE_ENV: 'production' }),
        /; Secure/
    );
    assert.equal(auth.isAuthenticated(`other=value; cm_admin_session=${token}`, env), true);
    assert.equal(auth.isAuthenticated('', env), false);
});
