const test = require('node:test');
const assert = require('node:assert/strict');
const customerAuth = require('./customer-auth');

const env = {
    SESSION_SECRET: 'a-test-session-secret-that-is-long-enough',
    CUSTOMER_SESSION_SECRET: 'a-separate-customer-session-secret-32-characters',
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    NODE_ENV: 'test'
};

test('customer registration validates and normalizes account details', () => {
    assert.deepEqual(
        customerAuth.validateRegistration({
            name: '  Customer Example ',
            email: 'CUSTOMER@example.com ',
            password: 'a-strong-password'
        }),
        {
            name: 'Customer Example',
            email: 'customer@example.com',
            password: 'a-strong-password'
        }
    );
    assert.throws(
        () => customerAuth.validateRegistration({
            name: 'Customer',
            email: 'invalid',
            password: 'a-strong-password'
        }),
        /valid email address/
    );
    assert.throws(
        () => customerAuth.validateRegistration({
            name: 'Customer',
            email: 'customer@example.com',
            password: 'short'
        }),
        /between 10 and 128/
    );
});

test('customer passwords are salted and verified', async () => {
    const first = await customerAuth.hashPassword('a-strong-password');
    const second = await customerAuth.hashPassword('a-strong-password');

    assert.notEqual(first, second);
    assert.equal(await customerAuth.passwordMatches('a-strong-password', first), true);
    assert.equal(await customerAuth.passwordMatches('incorrect-password', first), false);
    assert.equal(await customerAuth.passwordMatches('a'.repeat(129), first), false);
});

test('customer session cookies are signed and HttpOnly', () => {
    const cookie = customerAuth.createSessionCookie('customer-id', env);
    assert.match(cookie, /^cm_customer_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.equal(customerAuth.customerIdFromCookie(cookie, env), 'customer-id');
    const [sessionCookie, ...cookieAttributes] = cookie.split(';');
    const tamperedCookie = `${sessionCookie.slice(0, -1)}x;${cookieAttributes.join(';')}`;
    assert.equal(customerAuth.customerIdFromCookie(tamperedCookie, env), null);
    assert.match(
        customerAuth.createSessionCookie('customer-id', { ...env, NODE_ENV: 'production' }),
        /; Secure/
    );
});

test('Google ID tokens require the configured audience and a verified email', async () => {
    const claims = {
        iss: 'https://accounts.google.com',
        aud: env.GOOGLE_CLIENT_ID,
        sub: 'google-user-id',
        email: 'USER@example.com',
        email_verified: 'true',
        name: 'Google User',
        exp: String(Math.floor(Date.now() / 1000) + 300)
    };
    const fetchImpl = async () => ({
        ok: true,
        json: async () => claims
    });

    assert.deepEqual(
        await customerAuth.verifyGoogleCredential('google-id-token', env, fetchImpl),
        {
            googleSub: 'google-user-id',
            email: 'user@example.com',
            name: 'Google User'
        }
    );
    assert.deepEqual(
        await customerAuth.verifyGoogleCredential('google-id-token', env, async () => ({
            ok: true,
            json: async () => ({ ...claims, email_verified: true })
        })),
        {
            googleSub: 'google-user-id',
            email: 'user@example.com',
            name: 'Google User'
        }
    );
    await assert.rejects(
        customerAuth.verifyGoogleCredential('google-id-token', env, async () => ({
            ok: true,
            json: async () => ({ ...claims, aud: 'wrong-client' })
        })),
        /could not be verified/
    );
    await assert.rejects(
        customerAuth.verifyGoogleCredential('google-id-token', {}, fetchImpl),
        /not configured/
    );
});
