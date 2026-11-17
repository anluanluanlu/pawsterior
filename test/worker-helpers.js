import { handle } from '../worker/src/index.js';

export class FakeKV {
  constructor() { this.map = new Map(); this.ttls = new Map(); }
  async get(key, type) {
    const v = this.map.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value, opts) { this.map.set(key, value); if (opts?.expirationTtl) this.ttls.set(key, opts.expirationTtl); }
  async delete(key) { this.map.delete(key); }
}

export const newEnv = (extra = {}) => ({ PAWS: new FakeKV(), ALLOWED_ORIGINS: 'https://app.example', ...extra });

export async function call(env, method, path, { body, token, origin } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  const res = await handle(new Request(`https://api.example${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
}
