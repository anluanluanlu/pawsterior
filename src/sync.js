// Cloud sync: sign-in plus whole-document sync against the Worker in worker/.
// The device copy stays the source of truth, so the app works offline; this only
// pushes changes up and pulls newer cloud data down. Nothing here touches the DOM.
//
// Each device remembers `rev`, the cloud revision it last synced with. A push says
// "I am based on rev N"; the server refuses if the cloud has moved on, and the app
// then asks which copy to keep (see onConflict).

export function createSync({
  apiUrl,
  profile,
  storage,
  authKey,
  metaKey,
  getState,        // () => current app state
  applyRemote,     // (remoteState) => void; replaces local data. May throw to reject it.
  isPristine,      // (state) => true if the device has nothing worth keeping
  onConflict,      // async ({ local, remote }) => 'cloud' | 'device' | null
  onChange = () => {},
  fetchFn = (...a) => fetch(...a),
  debounceMs = 2000,
  now = () => Date.now(),
}) {
  const read = (k) => { try { return JSON.parse(storage.getItem(k)); } catch { return null; } };
  const write = (k, v) => {
    try { if (v == null) storage.removeItem(k); else storage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ }
  };

  let auth = read(authKey);
  // Signed in (say, via the other build) but never synced this profile: its data is new to the cloud.
  let meta = read(metaKey) ?? { rev: 0, dirty: !!auth, lastSyncedAt: null };
  let version = 0;          // bumps on every local change, to spot edits made mid-push
  let syncedJson = null;    // what the cloud is known to hold (device-local session excluded)
  let phase = 'idle';       // idle | syncing | offline | error | conflict
  let running = null;
  let again = false;
  let timer = null;
  let lastError = null;

  const payload = () => JSON.stringify({ ...getState(), session: null });
  if (auth && !meta.dirty) syncedJson = payload();

  const persistMeta = () => write(metaKey, meta);
  const emit = () => onChange(status());

  function status() {
    return { signedIn: !!auth, email: auth?.email ?? null, phase, dirty: !!meta.dirty, lastSyncedAt: meta.lastSyncedAt, error: lastError };
  }

  class NetworkError extends Error {}

  async function api(method, path, body, token) {
    let res;
    try {
      res = await fetchFn(apiUrl + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new NetworkError('Could not reach the server.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    return { status: res.status, data: data ?? {} };
  }

  function dropAuth() {
    auth = null;
    meta = { rev: 0, dirty: false, lastSyncedAt: null };
    syncedJson = null;
    write(authKey, null);
    persistMeta();
    clearTimeout(timer);
  }

  // ---- accounts

  async function authenticate(path, email, password) {
    const r = await api('POST', path, { email, password });
    if (r.status !== 200) throw new Error(r.data.error ?? 'Could not sign in.');
    auth = { token: r.data.token, email: r.data.email };
    write(authKey, auth);
    // Everything on this device is new to this account until a sync says otherwise.
    meta = { rev: 0, dirty: true, lastSyncedAt: null };
    syncedJson = null;
    version++;
    persistMeta();
    phase = 'idle';
    lastError = null;
    emit();
    syncNow();
  }

  const register = (email, password) => authenticate('/auth/register', email, password);
  const login = (email, password) => authenticate('/auth/login', email, password);

  async function logout() {
    const token = auth?.token;
    dropAuth();
    phase = 'idle';
    lastError = null;
    emit();
    if (token) api('POST', '/auth/logout', undefined, token).catch(() => {}); // best effort
  }

  async function deleteAccount() {
    if (!auth) return;
    const r = await api('DELETE', '/account', undefined, auth.token);
    if (r.status !== 200) throw new Error(r.data.error ?? 'Could not delete the account.');
    dropAuth();
    emit();
  }

  // ---- syncing

  /** Call after every local save. */
  function noteSaved() {
    if (!auth) return;
    if (payload() === syncedJson) return; // only the device-local timer changed
    meta.dirty = true;
    version++;
    persistMeta();
    emit();
    clearTimeout(timer);
    timer = setTimeout(syncNow, debounceMs);
  }

  function syncNow() {
    if (!auth) return Promise.resolve();
    if (running) { again = true; return running; }
    running = run().finally(() => {
      running = null;
      if (again) { again = false; syncNow(); }
    });
    return running;
  }

  async function run() {
    phase = 'syncing';
    emit();
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const token = auth?.token;
        if (!token) return;
        const path = `/data?profile=${profile}`;

        if (!meta.dirty) {
          const r = await api('GET', path, undefined, token);
          if (r.status === 401) return expired();
          if (r.status !== 200) throw new Error(r.data.error ?? 'Sync failed.');
          if (r.data.rev > meta.rev && r.data.state) {
            applyRemote(r.data.state);
            meta.rev = r.data.rev;
            syncedJson = payload();
          }
          return done();
        }

        const v = version;
        const json = payload();
        const r = await api('PUT', path, { baseRev: meta.rev, state: JSON.parse(json) }, token);
        if (r.status === 401) return expired();
        if (r.status === 200) {
          meta.rev = r.data.rev;
          syncedJson = json;
          if (version === v) meta.dirty = false; // not edited while we were pushing
          meta.lastSyncedAt = now();
          persistMeta();
          if (!meta.dirty) return done();
          continue;
        }
        if (r.status === 409) {
          const remote = r.data;
          const local = getState();
          const choice = remote.state && !isPristine(local)
            ? await onConflict({ local, remote: remote.state })
            : 'cloud';
          if (choice === 'cloud' && remote.state) {
            applyRemote(remote.state);
            meta.rev = remote.rev;
            meta.dirty = false;
            syncedJson = payload();
            return done();
          }
          if (choice === 'device') {
            meta.rev = remote.rev; // overwrite the cloud copy on the next pass
            persistMeta();
            continue;
          }
          phase = 'conflict';
          return;
        }
        throw new Error(r.data.error ?? 'Sync failed.');
      }
      throw new Error('Sync kept being interrupted.');
    } catch (e) {
      phase = e instanceof NetworkError ? 'offline' : 'error';
      lastError = e instanceof NetworkError ? null : e.message;
    } finally {
      emit();
    }
  }

  function done() {
    meta.lastSyncedAt = now();
    persistMeta();
    phase = 'idle';
    lastError = null;
  }

  function expired() {
    dropAuth();
    phase = 'idle';
    lastError = 'You have been signed out. Sign in again to keep syncing.';
  }

  return { status, register, login, logout, deleteAccount, noteSaved, syncNow };
}
