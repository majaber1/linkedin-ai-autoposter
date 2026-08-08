const test = require('node:test');
const assert = require('node:assert/strict');
const { filesystemDriver } = require('../lib/store');
const { encrypt, decrypt } = require('../lib/linkedin-auth');
const app = require('../server/index');

test('OAuth state is single-use and unknown states are rejected', async () => {
  const store = filesystemDriver();
  await store.putOAuthState('valid-state');
  assert.equal(await store.consumeOAuthState('valid-state'), true);
  assert.equal(await store.consumeOAuthState('valid-state'), false);
  assert.equal(await store.consumeOAuthState('unknown-state'), false);
});

test('automation API keys require an exact timing-safe match', () => {
  const previous = process.env.AUTOMATION_API_KEY;
  process.env.AUTOMATION_API_KEY = 'a'.repeat(64);
  try {
    assert.equal(app.locals.security.apiKeyMatches('a'.repeat(64)), true);
    assert.equal(app.locals.security.apiKeyMatches('a'.repeat(63)), false);
    assert.equal(app.locals.security.apiKeyMatches('b'.repeat(64)), false);
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_API_KEY;
    else process.env.AUTOMATION_API_KEY = previous;
  }
});

test('production GitHub access is deny-by-default', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAllowed = process.env.ALLOWED_GITHUB_USERS;
  process.env.NODE_ENV = 'production';
  delete process.env.ALLOWED_GITHUB_USERS;
  try {
    assert.equal(app.locals.security.allowedGitHubUser('majaber1'), false);
    process.env.ALLOWED_GITHUB_USERS = 'majaber1, trusted-owner';
    assert.equal(app.locals.security.allowedGitHubUser('MAJABER1'), true);
    assert.equal(app.locals.security.allowedGitHubUser('stranger'), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousAllowed === undefined) delete process.env.ALLOWED_GITHUB_USERS; else process.env.ALLOWED_GITHUB_USERS = previousAllowed;
  }
});

test('production readiness reports missing security configuration without values', () => {
  const missing = app.locals.security.productionConfigErrors({ NODE_ENV: 'production' });
  assert.deepEqual(missing, [
    'DATABASE_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_REDIRECT_URI', 'ALLOWED_GITHUB_USERS'
  ]);
  const complete = app.locals.security.productionConfigErrors({
    NODE_ENV: 'production', DATABASE_URL: 'configured', GITHUB_CLIENT_ID: 'configured',
    GITHUB_CLIENT_SECRET: 'configured', GITHUB_REDIRECT_URI: 'configured', ALLOWED_GITHUB_USERS: 'owner'
  });
  assert.deepEqual(complete, []);
});

test('LinkedIn credentials are encrypted and authenticated at rest', () => {
  const previous = process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY;
  process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = 'test-only-key-with-enough-entropy';
  try {
    const original = { accessToken: 'secret-token', personUrn: 'urn:li:person:123' };
    const payload = encrypt(original);
    assert.doesNotMatch(JSON.stringify(payload), /secret-token/);
    assert.deepEqual(decrypt(payload), original);
    payload.data = payload.data.slice(0, -2) + 'AA';
    assert.throws(() => decrypt(payload));
  } finally {
    if (previous === undefined) delete process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY;
    else process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = previous;
  }
});

test('image validation rejects a MIME mismatch and accepts a real PNG', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  assert.doesNotThrow(() => app.locals.security.validateImage(png, 'image/png'));
  assert.throws(() => app.locals.security.validateImage(png, 'image/jpeg'), /does not match/);
  assert.throws(() => app.locals.security.validateImage(Buffer.alloc(0), 'image/png'), /empty/);
});
