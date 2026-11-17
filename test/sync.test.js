import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSync } from '../src/sync.js';
import { handle } from '../worker/src/index.js';
import { newEnv } from './worker-helpers.js';

const PASSWORD = 'correct horse battery';
const base = () => ({ version: 1, types: [{ id: 't' }], entries: [], settings: { durationMs: 600000 }, session: null });

/** A fake device: its own storage, its own state, talking to a shared in-memory Worker. */
function device(env, { choice = 'cloud', online = true } = {}) {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const d = {
    state: base(), online, conflicts: [], events: [],
    storage,
    save(patch) { d.state = { ...d.state, ...patch }; d.sync.noteSaved(); },
  };
  d.sync = createSync({
    apiUrl: 'https://api.example', profile: 'main', storage, authKey: 'auth', metaKey: 'meta',
    getState: () => d.state,
    applyRemote: (s) => { d.state = { ...s, session: d.state.session }; },
    isPristine: (s) => s.entries.length === 0,
    onConflict: async (c) => { d.conflicts.push(c); return choice; },
    onChange: (s) => d.events.push(s.phase),
    debounceMs: 5,
    fetchFn: async (url, init) => {
      if (!d.online) throw new TypeError('offline');
      return handle(new Request(url, init), env);
    },
  });
  return d;
}

const entry = (id) => ({ id, typeId: 't', occurredAt: 1 });
const settle = () => new Promise((r) => setTimeout(r, 60));

test('signing in uploads this device, and a second device downloads it', async () => {
  const env = newEnv();
  const a = device(env);
  a.state = { ...base(), entries: [entry('1'), entry('2')] };
  await a.sync.register('me@example.com', PASSWORD);
  await settle();
  assert.equal(a.sync.status().dirty, false);
  assert.equal(a.sync.status().phase, 'idle');

  const b = device(env);
  await b.sync.login('me@example.com', PASSWORD);
  await settle();
  assert.deepEqual(b.state.entries.map((e) => e.id), ['1', '2']);
  assert.equal(b.conflicts.length, 0, 'an empty device just takes the cloud copy');
});

test('a change on one device reaches the other on its next sync', async () => {
  const env = newEnv();
  const a = device(env);
  await a.sync.register('me@example.com', PASSWORD);
  await settle();
  const b = device(env);
  await b.sync.login('me@example.com', PASSWORD);
  await settle();

  a.save({ entries: [entry('new')] });
  await settle();
  await b.sync.syncNow();
  assert.deepEqual(b.state.entries.map((e) => e.id), ['new']);
});

test('timer-only changes are not pushed', async () => {
  const env = newEnv();
  const a = device(env);
  await a.sync.register('me@example.com', PASSWORD);
  await settle();
  a.save({ session: { status: 'running' } });
  assert.equal(a.sync.status().dirty, false);
});

test('a pulled state keeps the running timer of this device', async () => {
  const env = newEnv();
  const a = device(env);
  await a.sync.register('me@example.com', PASSWORD);
  await settle();
  const b = device(env);
  await b.sync.login('me@example.com', PASSWORD);
  await settle();
  b.state = { ...b.state, session: { status: 'running' } };
  a.save({ entries: [entry('x')] });
  await settle();
  await b.sync.syncNow();
  assert.equal(b.state.session.status, 'running');
  assert.equal(b.state.entries.length, 1);
});

test('both devices changed: the chosen side wins', async () => {
  for (const choice of ['cloud', 'device']) {
    const env = newEnv();
    const a = device(env);
    a.state = { ...base(), entries: [entry('a1')] };
    await a.sync.register('me@example.com', PASSWORD);
    await settle();
    const b = device(env, { choice });
    await b.sync.login('me@example.com', PASSWORD);
    await settle();

    a.save({ entries: [entry('a1'), entry('a2')] });
    b.save({ entries: [entry('a1'), entry('b2')] });
    await settle();
    await settle();

    assert.equal(b.conflicts.length, 1);
    const ids = b.state.entries.map((e) => e.id).join();
    assert.equal(ids, choice === 'cloud' ? 'a1,a2' : 'a1,b2');
    assert.equal(b.sync.status().dirty, false);
    await a.sync.syncNow();
    assert.equal(a.state.entries.map((e) => e.id).join(), ids);
  }
});

test('dismissing the conflict keeps local data and stays flagged', async () => {
  const env = newEnv();
  const a = device(env);
  a.state = { ...base(), entries: [entry('a1')] };
  await a.sync.register('me@example.com', PASSWORD);
  await settle();
  const b = device(env, { choice: null });
  b.state = { ...base(), entries: [entry('b1')] };
  await b.sync.login('me@example.com', PASSWORD);
  await settle();
  assert.equal(b.sync.status().phase, 'conflict');
  assert.deepEqual(b.state.entries.map((e) => e.id), ['b1']);
  assert.equal(b.sync.status().dirty, true);
});

test('offline edits stay queued and upload when back online', async () => {
  const env = newEnv();
  const a = device(env);
  await a.sync.register('me@example.com', PASSWORD);
  await settle();
  a.online = false;
  a.save({ entries: [entry('offline')] });
  await settle();
  assert.equal(a.sync.status().phase, 'offline');
  assert.equal(a.sync.status().dirty, true);
  a.online = true;
  await a.sync.syncNow();
  assert.equal(a.sync.status().dirty, false);
  const b = device(env);
  await b.sync.login('me@example.com', PASSWORD);
  await settle();
  assert.deepEqual(b.state.entries.map((e) => e.id), ['offline']);
});

test('a revoked session signs the device out but keeps its data', async () => {
  const env = newEnv();
  const a = device(env);
  await a.sync.register('me@example.com', PASSWORD);
  await settle();
  for (const k of [...env.PAWS.map.keys()]) if (k.startsWith('sess:')) env.PAWS.map.delete(k);
  a.save({ entries: [entry('keep')] });
  await settle();
  assert.equal(a.sync.status().signedIn, false);
  assert.match(a.sync.status().error, /signed out/i);
  assert.deepEqual(a.state.entries.map((e) => e.id), ['keep']);
});

test('sign-in errors come back as readable messages', async () => {
  const env = newEnv();
  const a = device(env);
  await a.sync.register('me@example.com', PASSWORD);
  await settle();
  const b = device(env);
  await assert.rejects(() => b.sync.login('me@example.com', 'definitely wrong'), /Wrong email or password/);
  b.online = false;
  await assert.rejects(() => b.sync.login('me@example.com', PASSWORD), /Could not reach/);
  assert.equal(b.sync.status().signedIn, false);
});

test('signing out keeps local data and stops syncing', async () => {
  const env = newEnv();
  const a = device(env);
  await a.sync.register('me@example.com', PASSWORD);
  await settle();
  await a.sync.logout();
  assert.equal(a.sync.status().signedIn, false);
  a.save({ entries: [entry('local')] });
  assert.equal(a.sync.status().dirty, false);
  assert.equal(a.state.entries.length, 1);
});

test('a signed-in profile that was never synced uploads its existing data', async () => {
  const env = newEnv();
  const a = device(env);
  await a.sync.register('me@example.com', PASSWORD);
  await settle();
  // The other build (same login, own metadata) already holds local entries.
  const other = createSync({
    apiUrl: 'https://api.example', profile: 'test', storage: a.storage, authKey: 'auth', metaKey: 'meta-test',
    getState: () => ({ ...base(), entries: [entry('t1')] }),
    applyRemote: () => assert.fail('nothing to pull'), isPristine: () => false, onConflict: async () => null,
    fetchFn: async (url, init) => handle(new Request(url, init), env),
  });
  await other.syncNow();
  assert.equal(other.status().dirty, false);
  const token = JSON.parse(a.storage.getItem('auth')).token;
  const cloud = await (await handle(new Request('https://api.example/data?profile=test', { headers: { Authorization: `Bearer ${token}` } }), env)).json();
  assert.equal(cloud.state.entries[0].id, 't1');
});
