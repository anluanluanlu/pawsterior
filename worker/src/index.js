// Pawsterior sync API: accounts, sessions and one JSON document per user, all in Workers KV.
//
//   POST   /auth/register  {email, password}  -> {token, email}
//   POST   /auth/login     {email, password}  -> {token, email}
//   POST   /auth/logout                       -> {ok}           (Bearer token)
//   GET    /data?profile=main|test            -> {rev, state}   (Bearer token)
//   PUT    /data?profile=main|test {baseRev, state} -> {rev}    (409 {rev, state} if baseRev is stale)
//   DELETE /account                           -> {ok}           (deletes the account and its data)
//
// KV keys:  user:<email>  sess:<sha256(token)>  data:<userId>:<profile>  rl:<email>
// Passwords are PBKDF2-SHA256 hashed with a per-user salt. Session tokens are random and
// only their SHA-256 is stored. KV has no compare-and-set, so two writes landing in the
// same instant could both pass the revision check; fine for one person, use a Durable
// Object if you ever need strict serialisation.

const PBKDF2_ITERATIONS = 100_000; // the maximum Workers allows
const SESSION_TTL = 60 * 60 * 24 * 90; // 90 days
const MAX_BODY = 1_000_000;
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_SECONDS = 15 * 60;
const PROFILES = ['main', 'test'];
const MIN_PASSWORD = 10;

const enc = new TextEncoder();

// ---------------------------------------------------------------- helpers

const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (bytes) => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hashPassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const sha256Hex = async (text) => toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const local = env.ALLOW_LOCALHOST === 'true' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!allowed.includes(origin) && !local) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (status, body, headers) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'That is too large to sync.');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

function cleanEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

function cleanPassword(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD) throw new HttpError(400, `Use a password of at least ${MIN_PASSWORD} characters.`);
  if (value.length > 200) throw new HttpError(400, 'That password is too long.');
  return value;
}

function cleanProfile(url) {
  const p = url.searchParams.get('profile') ?? 'main';
  if (!PROFILES.includes(p)) throw new HttpError(400, 'Unknown profile.');
  return p;
}

function validState(s) {
  return s && typeof s === 'object' && !Array.isArray(s)
    && Number.isInteger(s.version) && Array.isArray(s.types) && Array.isArray(s.entries);
}

// ---------------------------------------------------------------- auth

async function createSession(env, user) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.PAWS.put(`sess:${await sha256Hex(token)}`, JSON.stringify({ userId: user.id, email: user.email }), { expirationTtl: SESSION_TTL });
  return token;
}

async function authenticate(req, env) {
  const m = /^Bearer (\S+)$/.exec(req.headers.get('Authorization') ?? '');
  if (!m) throw new HttpError(401, 'Sign in required.');
  const tokenHash = await sha256Hex(m[1]);
  const sess = await env.PAWS.get(`sess:${tokenHash}`, 'json');
  if (!sess) throw new HttpError(401, 'Your session has expired. Sign in again.');
  return { ...sess, tokenHash };
}

async function register(req, env) {
  if (env.ALLOW_SIGNUP === 'false') throw new HttpError(403, 'Registration is closed.');
  const body = await readJson(req);
  const email = cleanEmail(body.email);
  const password = cleanPassword(body.password);
  if (await env.PAWS.get(`user:${email}`)) throw new HttpError(409, 'That email is already registered. Sign in instead.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt, PBKDF2_ITERATIONS);
  const user = { id: crypto.randomUUID(), email, salt: toB64(salt), hash: toB64(hash), iterations: PBKDF2_ITERATIONS, created: Date.now() };
  await env.PAWS.put(`user:${email}`, JSON.stringify(user));
  return { token: await createSession(env, user), email };
}

const DUMMY_SALT = new Uint8Array(16);

async function login(req, env) {
  const body = await readJson(req);
  const email = cleanEmail(body.email);
  const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
  const rlKey = `rl:${email}`;
  const failures = Number(await env.PAWS.get(rlKey)) || 0;
  if (failures >= MAX_FAILED_LOGINS) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');

  const user = await env.PAWS.get(`user:${email}`, 'json');
  // Always do the hashing work, so an unknown email takes as long as a wrong password.
  const hash = await hashPassword(password, user ? fromB64(user.salt) : DUMMY_SALT, user?.iterations ?? PBKDF2_ITERATIONS);
  if (!user || !safeEqual(hash, fromB64(user.hash))) {
    await env.PAWS.put(rlKey, String(failures + 1), { expirationTtl: LOCKOUT_SECONDS });
    throw new HttpError(401, 'Wrong email or password.');
  }
  if (failures) await env.PAWS.delete(rlKey);
  return { token: await createSession(env, user), email };
}

// ---------------------------------------------------------------- data

async function getData(req, env, url) {
  const me = await authenticate(req, env);
  const doc = await env.PAWS.get(`data:${me.userId}:${cleanProfile(url)}`, 'json');
  return doc ? { rev: doc.rev, state: doc.state } : { rev: 0, state: null };
}

async function putData(req, env, url) {
  const me = await authenticate(req, env);
  const key = `data:${me.userId}:${cleanProfile(url)}`;
  const body = await readJson(req);
  if (!Number.isInteger(body.baseRev) || body.baseRev < 0) throw new HttpError(400, 'Missing baseRev.');
  if (!validState(body.state)) throw new HttpError(400, 'That does not look like Pawsterior data.');
  const current = await env.PAWS.get(key, 'json');
  const rev = current?.rev ?? 0;
  if (body.baseRev !== rev) throw new HttpError(409, 'The cloud copy changed.', { rev, state: current?.state ?? null });
  // A running timer belongs to the device it runs on.
  const state = { ...body.state, session: null };
  await env.PAWS.put(key, JSON.stringify({ rev: rev + 1, updatedAt: Date.now(), state }));
  return { rev: rev + 1 };
}

async function deleteAccount(req, env) {
  const me = await authenticate(req, env);
  await Promise.all([
    ...PROFILES.map((p) => env.PAWS.delete(`data:${me.userId}:${p}`)),
    env.PAWS.delete(`user:${me.email}`),
    env.PAWS.delete(`sess:${me.tokenHash}`),
  ]);
  // Other devices' sessions point at nothing now and expire on their own.
  return { ok: true };
}

// ---------------------------------------------------------------- router

export async function handle(req, env) {
  const cors = corsHeaders(req, env);
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    let result;
    switch (`${req.method} ${url.pathname}`) {
      case 'POST /auth/register': result = await register(req, env); break;
      case 'POST /auth/login': result = await login(req, env); break;
      case 'POST /auth/logout': {
        const me = await authenticate(req, env);
        await env.PAWS.delete(`sess:${me.tokenHash}`);
        result = { ok: true };
        break;
      }
      case 'GET /data': result = await getData(req, env, url); break;
      case 'PUT /data': result = await putData(req, env, url); break;
      case 'DELETE /account': result = await deleteAccount(req, env); break;
      default: throw new HttpError(404, 'Not found.');
    }
    return json(200, result, cors);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message, ...e.extra }, cors);
    console.error(e);
    return json(500, { error: 'Something went wrong.' }, cors);
  }
}

export default { fetch: handle };
