import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, call } from './worker-helpers.js';

const PASSWORD = 'correct horse battery';
const doc = (extra = {}) => ({ version: 1, types: [], entries: [], settings: {}, session: null, ...extra });

async function signedUp(env, email = 'me@example.com') {
  const r = await call(env, 'POST', '/auth/register', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200);
  return r.data.token;
}

test('register then login with the same password', async () => {
  const env = newEnv();
  await signedUp(env);
  const ok = await call(env, 'POST', '/auth/login', { body: { email: 'ME@example.com ', password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.email, 'me@example.com');
  assert.ok(ok.data.token.length >= 40);
});

test('the password is never stored and the session token is only stored hashed', async () => {
  const env = newEnv();
  const token = await signedUp(env);
  const all = JSON.stringify([...env.PAWS.map.entries()]);
  assert.ok(!all.includes(PASSWORD));
  assert.ok(!all.includes(token));
});

test('wrong password and unknown email get the same answer', async () => {
  const env = newEnv();
  await signedUp(env);
  const wrong = await call(env, 'POST', '/auth/login', { body: { email: 'me@example.com', password: 'not the password' } });
  const unknown = await call(env, 'POST', '/auth/login', { body: { email: 'nobody@example.com', password: PASSWORD } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.data, unknown.data);
});

test('registration validates input and refuses duplicates', async () => {
  const env = newEnv();
  assert.equal((await call(env, 'POST', '/auth/register', { body: { email: 'nope', password: PASSWORD } })).status, 400);
  assert.equal((await call(env, 'POST', '/auth/register', { body: { email: 'a@b.co', password: 'short' } })).status, 400);
  await signedUp(env);
  assert.equal((await call(env, 'POST', '/auth/register', { body: { email: 'me@example.com', password: PASSWORD } })).status, 409);
});

test('registration can be closed', async () => {
  const env = newEnv({ ALLOW_SIGNUP: 'false' });
  const r = await call(env, 'POST', '/auth/register', { body: { email: 'me@example.com', password: PASSWORD } });
  assert.equal(r.status, 403);
});

test('only allowlisted emails can register, whatever their case or spacing', async () => {
  const env = newEnv({ ALLOWED_EMAILS: ' Me@Example.com , friend@example.com' });
  const stranger = await call(env, 'POST', '/auth/register', { body: { email: 'stranger@example.com', password: PASSWORD } });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.data.error, 'Registration is closed.');
  assert.equal((await call(env, 'POST', '/auth/register', { body: { email: 'ME@example.com', password: PASSWORD } })).status, 200);
  assert.equal((await call(env, 'POST', '/auth/register', { body: { email: 'friend@example.com', password: PASSWORD } })).status, 200);
});

test('an empty allowlist admits nobody, and the master switch still wins', async () => {
  const none = newEnv({ ALLOWED_EMAILS: '' });
  assert.equal((await call(none, 'POST', '/auth/register', { body: { email: 'me@example.com', password: PASSWORD } })).status, 403);
  const closed = newEnv({ ALLOWED_EMAILS: 'me@example.com', ALLOW_SIGNUP: 'false' });
  assert.equal((await call(closed, 'POST', '/auth/register', { body: { email: 'me@example.com', password: PASSWORD } })).status, 403);
});

test('the allowlist does not affect existing accounts signing in', async () => {
  const env = newEnv();
  await signedUp(env);
  env.ALLOWED_EMAILS = 'someone-else@example.com';
  assert.equal((await call(env, 'POST', '/auth/login', { body: { email: 'me@example.com', password: PASSWORD } })).status, 200);
});

test('repeated wrong passwords lock the account for a while, even for the right password', async () => {
  const env = newEnv();
  await signedUp(env);
  for (let i = 0; i < 10; i++) {
    assert.equal((await call(env, 'POST', '/auth/login', { body: { email: 'me@example.com', password: 'wrong wrong wrong' } })).status, 401);
  }
  assert.equal((await call(env, 'POST', '/auth/login', { body: { email: 'me@example.com', password: PASSWORD } })).status, 429);
});

test('sessions expire (a TTL is set) and logout revokes the token', async () => {
  const env = newEnv();
  const token = await signedUp(env);
  assert.ok([...env.PAWS.ttls.values()].some((t) => t >= 60 * 60 * 24 * 30));
  assert.equal((await call(env, 'GET', '/data', { token })).status, 200);
  assert.equal((await call(env, 'POST', '/auth/logout', { token })).status, 200);
  assert.equal((await call(env, 'GET', '/data', { token })).status, 401);
});

test('data needs a valid token', async () => {
  const env = newEnv();
  assert.equal((await call(env, 'GET', '/data')).status, 401);
  assert.equal((await call(env, 'GET', '/data', { token: 'made-up' })).status, 401);
  assert.equal((await call(env, 'PUT', '/data', { body: { baseRev: 0, state: doc() } })).status, 401);
});

test('first read is empty; writes bump the revision', async () => {
  const env = newEnv();
  const token = await signedUp(env);
  assert.deepEqual((await call(env, 'GET', '/data', { token })).data, { rev: 0, state: null });
  const put = await call(env, 'PUT', '/data', { token, body: { baseRev: 0, state: doc({ entries: [{ id: 'a' }] }) } });
  assert.deepEqual(put.data, { rev: 1 });
  const got = await call(env, 'GET', '/data', { token });
  assert.equal(got.data.rev, 1);
  assert.equal(got.data.state.entries.length, 1);
});

test('a stale baseRev is refused with the cloud copy attached', async () => {
  const env = newEnv();
  const token = await signedUp(env);
  await call(env, 'PUT', '/data', { token, body: { baseRev: 0, state: doc({ entries: [{ id: 'a' }] }) } });
  const stale = await call(env, 'PUT', '/data', { token, body: { baseRev: 0, state: doc() } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.rev, 1);
  assert.equal(stale.data.state.entries.length, 1);
});

test('a running timer is never stored, and junk is rejected', async () => {
  const env = newEnv();
  const token = await signedUp(env);
  await call(env, 'PUT', '/data', { token, body: { baseRev: 0, state: doc({ session: { status: 'running' } }) } });
  assert.equal((await call(env, 'GET', '/data', { token })).data.state.session, null);
  assert.equal((await call(env, 'PUT', '/data', { token, body: { baseRev: 1, state: { hello: 1 } } })).status, 400);
  assert.equal((await call(env, 'PUT', '/data', { token, body: { baseRev: 'x', state: doc() } })).status, 400);
});

test('main and test profiles are separate, and users cannot see each other', async () => {
  const env = newEnv();
  const a = await signedUp(env, 'a@example.com');
  const b = await signedUp(env, 'b@example.com');
  await call(env, 'PUT', '/data?profile=main', { token: a, body: { baseRev: 0, state: doc({ entries: [{ id: 'x' }] }) } });
  assert.equal((await call(env, 'GET', '/data?profile=test', { token: a })).data.rev, 0);
  assert.equal((await call(env, 'GET', '/data?profile=main', { token: b })).data.rev, 0);
  assert.equal((await call(env, 'GET', '/data?profile=bogus', { token: a })).status, 400);
});

test('deleting the account removes its data and logs everything out', async () => {
  const env = newEnv();
  const token = await signedUp(env);
  await call(env, 'PUT', '/data', { token, body: { baseRev: 0, state: doc() } });
  assert.equal((await call(env, 'DELETE', '/account', { token })).status, 200);
  assert.equal((await call(env, 'GET', '/data', { token })).status, 401);
  assert.equal([...env.PAWS.map.keys()].filter((k) => k.startsWith('data:') || k.startsWith('user:')).length, 0);
});

test('CORS allows only the configured origins', async () => {
  const env = newEnv();
  const ok = await call(env, 'OPTIONS', '/data', { origin: 'https://app.example' });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.example');
  const denied = await call(env, 'OPTIONS', '/data', { origin: 'https://evil.example' });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const local = await call(env, 'OPTIONS', '/data', { origin: 'http://localhost:8080' });
  assert.equal(local.headers.get('access-control-allow-origin'), null);
  const dev = await call(newEnv({ ALLOW_LOCALHOST: 'true' }), 'OPTIONS', '/data', { origin: 'http://localhost:8080' });
  assert.equal(dev.headers.get('access-control-allow-origin'), 'http://localhost:8080');
});

test('unknown routes are 404', async () => {
  assert.equal((await call(newEnv(), 'GET', '/nope')).status, 404);
});
