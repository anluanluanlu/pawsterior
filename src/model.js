// Pure domain model. Mirrors spec/pawsterior.allium.
// Every mutation takes a state and returns a new state, or throws ValidationError.
// No DOM, no storage: app.js handles those.

export const KINDS = ['activity', 'mental_state'];
export const POLARITIES = ['good', 'negative'];

/** Rating given to "Catastrophic thoughts" (one-off): how strongly the thought pulled, not how bad it was. */
const CATASTROPHIC_RATING = Object.freeze({
  name: 'Pull', labels: Object.freeze(['Barely', 'A little', 'Moderate', 'Quite a bit', 'A lot']),
});

/** The fixed descriptions older versions showed, so earlier entries keep the wording they were rated under. */
const LEGACY_NEGATIVE_LABELS = Object.freeze(['Barely', 'Mild', 'Moderate', 'Strong', 'Severe']);
const LEGACY_GOOD_LABELS = Object.freeze(['Slightly', 'Somewhat', 'Moderately', 'Very', 'Deeply']);

/**
 * Brings an older save up to date:
 * - negative states used to be called "bad";
 * - "Catastrophic thoughts" gets the Pull rating (once: only when it has no rating setting yet);
 * - rated entries without a recorded scale get the fixed one that was shown before, so that
 *   changing a rating later never rewrites how earlier entries were rated.
 */
export function migrateLegacy(s) {
  if (!s || !Array.isArray(s.types)) return s;
  const before = new Map(s.types.map((t) => [t.id, t]));
  let changed = false;
  const types = s.types.map((t) => {
    let n = t;
    if (n.polarity === 'bad') n = { ...n, polarity: 'negative' };
    if (n.rating === undefined && n.kind === 'mental_state' && n.name === 'Catastrophic thoughts') {
      n = { ...n, rating: { name: CATASTROPHIC_RATING.name, labels: [...CATASTROPHIC_RATING.labels] } };
    }
    // "Moderately" was shortened to "Moderate" to fit the button; update saves that already got the first wording.
    if (n.name === 'Catastrophic thoughts' && n.rating?.name === 'Pull' && n.rating.labels?.[2] === 'Moderately') {
      n = { ...n, rating: { ...n.rating, labels: n.rating.labels.map((l, i) => (i === 2 ? 'Moderate' : l)) } };
    }
    if (n !== t) changed = true;
    return n;
  });
  const entries = Array.isArray(s.entries)
    ? s.entries.map((e) => {
      if (e.intensity == null || e.scale !== undefined || !before.has(e.typeId)) return e;
      changed = true;
      const { polarity } = before.get(e.typeId);
      return { ...e, scale: { name: ratingOf({ polarity }).name, labels: [...(polarity === 'good' ? LEGACY_GOOD_LABELS : LEGACY_NEGATIVE_LABELS)] } };
    })
    : s.entries;
  return changed ? { ...s, types, entries } : s;
}
export const AMBIENTS = ['silence', 'brown_noise', 'rain', 'ocean'];

const MIN = 60_000;

export const CONFIG = Object.freeze({
  defaultMeditationMs: 10 * MIN,
  minMeditationMs: 1 * MIN,
  maxMeditationMs: 240 * MIN,
  minIntervalBellMs: 1 * MIN,
  defaultWarmupMs: 15_000,
  maxWarmupMs: 5 * MIN,
  maxTypeNameLength: 60,
  maxNoteLength: 500,
  maxRatingNameLength: 30,
  maxRatingLabelLength: 20,
  minIntensity: 1,
  maxIntensity: 5,
  futureEntryToleranceMs: 1 * MIN,
});

export const SCHEMA_VERSION = 1;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const fail = (msg) => { throw new ValidationError(msg); };

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export const normalizeName = (name) => String(name ?? '').trim().replace(/\s+/g, ' ');
const nameKey = (name) => normalizeName(name).toLocaleLowerCase();

// ---------------------------------------------------------------- defaults

export function createInitialState(now = Date.now()) {
  const t = (name, kind, polarity, color, isMeditation = false, rating = null) => ({
    id: newId(), name, kind, polarity, color, rating, archived: false, isMeditation, createdAt: now,
  });
  return {
    version: SCHEMA_VERSION,
    types: [
      t('Meditation', 'activity', null, '#7c9cff', true),
      t('Met friends', 'activity', null, '#5cc8a8'),
      t("Couldn't fall asleep", 'mental_state', 'negative', '#e07a7a'),
      t('Catastrophic thoughts', 'mental_state', 'negative', '#d9a05b', false,
        { name: CATASTROPHIC_RATING.name, labels: [...CATASTROPHIC_RATING.labels] }),
      t('Felt calm', 'mental_state', 'good', '#8fd16a'),
    ],
    entries: [],
    session: null,
    settings: { durationMs: CONFIG.defaultMeditationMs, ambient: 'silence', intervalMs: 0, warmupMs: CONFIG.defaultWarmupMs },
  };
}

// ---------------------------------------------------------------- lookups

export const getType = (state, id) => state.types.find((t) => t.id === id) ?? null;
export const meditationType = (state) => state.types.find((t) => t.isMeditation) ?? null;
export const entriesOfType = (state, typeId) => state.entries.filter((e) => e.typeId === typeId);
export const sortedEntries = (state) => [...state.entries].sort((a, b) => b.occurredAt - a.occurredAt);

// ---------------------------------------------------------------- ratings

const RATING_STEPS = CONFIG.maxIntensity - CONFIG.minIntensity + 1;

/** Normalises a rating ({ name, labels }): trimmed, bounded, always exactly one label slot per step. */
function cleanRating(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = normalizeName(raw.name);
  if (name.length > CONFIG.maxRatingNameLength) fail(`Rating names can be at most ${CONFIG.maxRatingNameLength} characters.`);
  const given = Array.isArray(raw.labels) ? raw.labels : [];
  const labels = Array.from({ length: RATING_STEPS }, (_, i) => normalizeName(given[i]));
  if (labels.some((l) => l.length > CONFIG.maxRatingLabelLength)) {
    fail(`Scale descriptions can be at most ${CONFIG.maxRatingLabelLength} characters.`);
  }
  return { name, labels };
}

/** What a type's 1-5 rating shows right now. Without settings: "Severity" (or "Strength" for good states), numbers only. */
export function ratingOf(type) {
  const r = type?.rating ? cleanRating(type.rating) : null;
  return {
    name: r?.name || (type?.polarity === 'good' ? 'Strength' : 'Severity'),
    labels: r?.labels ?? Array(RATING_STEPS).fill(''),
  };
}

// ---------------------------------------------------------------- entry types

function validateTypeFields(state, { name, kind, polarity, color, rating }, selfId = null) {
  const n = normalizeName(name);
  if (!n) fail('Give it a name.');
  if (n.length > CONFIG.maxTypeNameLength) fail(`Names can be at most ${CONFIG.maxTypeNameLength} characters.`);
  const clash = state.types.find((t) => nameKey(t.name) === nameKey(n) && t.id !== selfId);
  if (clash) fail(`"${clash.name}" already exists.`);
  if (!KINDS.includes(kind)) fail('Choose activity or mental state.');
  let p = null;
  if (kind === 'mental_state') {
    if (!POLARITIES.includes(polarity)) fail('Say whether this state is a good or a negative sign.');
    p = polarity;
  }
  const c = typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#9aa4b2';
  let r = kind === 'mental_state' ? cleanRating(rating) : null;
  if (r && !r.name && r.labels.every((l) => !l)) r = null;
  return { name: n, kind, polarity: p, color: c, rating: r };
}

export function defineType(state, fields, now = Date.now()) {
  const v = validateTypeFields(state, fields);
  const type = { id: newId(), ...v, archived: false, isMeditation: false, createdAt: now };
  return { ...state, types: [...state.types, type] };
}

export function editType(state, id, fields) {
  const type = getType(state, id) ?? fail('That type no longer exists.');
  const merged = { name: type.name, kind: type.kind, polarity: type.polarity, color: type.color, rating: type.rating, ...fields };
  const v = validateTypeFields(state, merged, id);
  if (v.kind !== type.kind) {
    if (type.isMeditation) fail('Meditation is always an activity.');
    if (entriesOfType(state, id).length > 0) fail('The kind cannot change once something is logged against it.');
  }
  return { ...state, types: state.types.map((t) => (t.id === id ? { ...t, ...v } : t)) };
}

export function archiveType(state, id) {
  const type = getType(state, id) ?? fail('That type no longer exists.');
  if (type.isMeditation) fail('Meditation cannot be archived.');
  if (type.archived) fail('Already archived.');
  return { ...state, types: state.types.map((t) => (t.id === id ? { ...t, archived: true } : t)) };
}

export function restoreType(state, id) {
  const type = getType(state, id) ?? fail('That type no longer exists.');
  if (!type.archived) fail('Not archived.');
  return { ...state, types: state.types.map((t) => (t.id === id ? { ...t, archived: false } : t)) };
}

export function deleteType(state, id) {
  const type = getType(state, id) ?? fail('That type no longer exists.');
  if (type.isMeditation) fail('Meditation cannot be deleted.');
  if (entriesOfType(state, id).length > 0) fail('It has entries. Archive it instead, or delete its entries first.');
  return { ...state, types: state.types.filter((t) => t.id !== id) };
}

// ---------------------------------------------------------------- entries

function validateEntryFields(type, { occurredAt, durationMs = null, intensity = null, note = null, scale = null }, now) {
  if (!Number.isFinite(occurredAt)) fail('Pick a valid time.');
  if (occurredAt > now + CONFIG.futureEntryToleranceMs) fail('That time is in the future.');
  let d = null;
  if (durationMs != null && durationMs !== '') {
    if (type.kind !== 'activity') fail('Only activities have a duration.');
    if (!Number.isFinite(durationMs) || durationMs <= 0) fail('Duration must be positive.');
    d = Math.round(durationMs);
  }
  let i = null;
  if (intensity != null && intensity !== '') {
    if (!Number.isInteger(intensity) || intensity < CONFIG.minIntensity || intensity > CONFIG.maxIntensity) {
      fail(`Intensity goes from ${CONFIG.minIntensity} to ${CONFIG.maxIntensity}.`);
    }
    i = intensity;
  }
  let n = note == null ? null : String(note).trim();
  if (n === '') n = null;
  if (n && n.length > CONFIG.maxNoteLength) fail(`Notes can be at most ${CONFIG.maxNoteLength} characters.`);
  // A rated entry remembers the name and descriptions it was rated under, so later edits to the type's rating don't rewrite history.
  const given = i == null ? null : cleanRating(scale);
  const s = i == null ? null : given?.name ? given : ratingOf(type);
  return { occurredAt, durationMs: d, intensity: i, scale: s, note: n };
}

export function logEntry(state, { typeId, ...fields }, now = Date.now()) {
  const type = getType(state, typeId) ?? fail('That type no longer exists.');
  if (type.archived) fail(`"${type.name}" is archived.`);
  const v = validateEntryFields(type, fields, now);
  const entry = { id: newId(), typeId, ...v, sessionId: null };
  return { ...state, entries: [...state.entries, entry] };
}

export function editEntry(state, id, fields, now = Date.now()) {
  const entry = state.entries.find((e) => e.id === id) ?? fail('That entry no longer exists.');
  const type = getType(state, entry.typeId) ?? fail('Its type no longer exists.');
  const merged = {
    occurredAt: entry.occurredAt, durationMs: entry.durationMs, intensity: entry.intensity, scale: entry.scale, note: entry.note,
    ...fields,
  };
  const v = validateEntryFields(type, merged, now);
  return { ...state, entries: state.entries.map((e) => (e.id === id ? { ...e, ...v } : e)) };
}

export function deleteEntry(state, id) {
  if (!state.entries.some((e) => e.id === id)) fail('That entry no longer exists.');
  return { ...state, entries: state.entries.filter((e) => e.id !== id) };
}

// ---------------------------------------------------------------- meditation sessions

/** Time since the session started, excluding pauses. Includes the warm-up. */
export function sessionRawElapsed(session, now = Date.now()) {
  if (!session) return 0;
  const until = session.status === 'paused' ? session.pausedAt : now;
  return Math.max(0, until - session.startedAt - session.pausedTotalMs);
}

/** Time actually meditated: the warm-up does not count. */
export const sessionElapsed = (session, now = Date.now()) =>
  Math.max(0, sessionRawElapsed(session, now) - (session?.warmupMs ?? 0));

/** Warm-up time still to go (0 once meditation has begun). */
export const sessionWarmupRemaining = (session, now = Date.now()) =>
  Math.max(0, (session?.warmupMs ?? 0) - sessionRawElapsed(session, now));

export const sessionRemaining = (session, now = Date.now()) =>
  Math.max(0, session.plannedMs - sessionElapsed(session, now));

export function startSession(state, { plannedMs, ambient = 'silence', intervalMs = 0, warmupMs = 0 }, now = Date.now()) {
  if (state.session) fail('A session is already in progress.');
  if (!Number.isFinite(plannedMs) || plannedMs < CONFIG.minMeditationMs) fail('Meditate for at least a minute.');
  if (plannedMs > CONFIG.maxMeditationMs) fail('Sessions can be at most 4 hours.');
  if (!AMBIENTS.includes(ambient)) fail('Unknown ambient sound.');
  const iv = intervalMs || 0;
  if (iv && (iv < CONFIG.minIntervalBellMs || iv >= plannedMs)) fail('Interval bells must be at least a minute and shorter than the session.');
  if (!Number.isFinite(warmupMs) || warmupMs < 0 || warmupMs > CONFIG.maxWarmupMs) fail('Warm-up can be 0 to 300 seconds.');
  const session = {
    id: newId(), plannedMs, ambient, intervalMs: iv, warmupMs: Math.round(warmupMs), status: 'running',
    startedAt: now, pausedAt: null, pausedTotalMs: 0,
  };
  return { ...state, session, settings: { ...state.settings, durationMs: plannedMs, ambient, intervalMs: iv, warmupMs: Math.round(warmupMs) } };
}

export function pauseSession(state, now = Date.now()) {
  const s = state.session;
  if (!s || s.status !== 'running') fail('No running session.');
  return { ...state, session: { ...s, status: 'paused', pausedAt: now } };
}

export function resumeSession(state, now = Date.now()) {
  const s = state.session;
  if (!s || s.status !== 'paused') fail('No paused session.');
  return {
    ...state,
    session: { ...s, status: 'running', pausedAt: null, pausedTotalMs: s.pausedTotalMs + (now - s.pausedAt) },
  };
}

function endSession(state, now) {
  const s = state.session;
  const med = meditationType(state) ?? fail('Meditation type is missing.');
  const durationMs = Math.min(sessionElapsed(s, now), s.plannedMs);
  const entry = {
    id: newId(), typeId: med.id, occurredAt: s.startedAt, durationMs,
    intensity: null, note: null, sessionId: s.id,
  };
  return { ...state, session: null, entries: [...state.entries, entry] };
}

/** Ends a session before its planned time. Logs the time actually meditated. */
export function finishSessionEarly(state, now = Date.now()) {
  const s = state.session;
  if (!s) fail('No session in progress.');
  if (sessionElapsed(s, now) < CONFIG.minMeditationMs) fail('Less than a minute so far. Discard it instead?');
  return endSession(state, now);
}

/** Called on every tick. Completes the session when its time is up. */
export function tickSession(state, now = Date.now()) {
  const s = state.session;
  if (s && s.status === 'running' && sessionElapsed(s, now) >= s.plannedMs) {
    return { state: endSession(state, now), completed: true };
  }
  return { state, completed: false };
}

export function discardSession(state) {
  if (!state.session) fail('No session in progress.');
  return { ...state, session: null };
}

// ---------------------------------------------------------------- import / export

export function exportState(state, now = Date.now()) {
  return JSON.stringify({ app: 'pawsterior', exportedAt: new Date(now).toISOString(), ...state }, null, 2);
}

/** Validates a snapshot and returns it as a clean state. Throws on anything malformed. */
export function importState(json) {
  let raw;
  try { raw = typeof json === 'string' ? JSON.parse(json) : json; } catch { fail('That file is not valid JSON.'); }
  if (!raw || typeof raw !== 'object') fail('That file is not a Pawsterior export.');
  if (raw.version !== SCHEMA_VERSION) fail(`Unsupported export version: ${raw.version}.`);
  if (!Array.isArray(raw.types) || !Array.isArray(raw.entries)) fail('That file is not a Pawsterior export.');

  const rawTypes = migrateLegacy(raw).types.map((t) => {
    if (typeof t?.id !== 'string') fail('A type is missing its id.');
    return {
      id: t.id, name: normalizeName(t.name), kind: t.kind, polarity: t.kind === 'mental_state' ? t.polarity : null,
      color: t.color, rating: t.rating, archived: !!t.archived, isMeditation: !!t.isMeditation, createdAt: Number(t.createdAt) || 0,
    };
  });
  // Re-validate every type against the others (also normalises name and colour).
  const types = rawTypes.map((t) => ({ ...t, ...validateTypeFields({ types: rawTypes }, t, t.id) }));
  if (types.some((t) => t.isMeditation && t.kind !== 'activity')) fail('Meditation must be an activity.');
  if (types.filter((t) => t.isMeditation).length !== 1) fail('Export must contain exactly one meditation type.');

  const ids = new Set(types.map((t) => t.id));
  const entries = raw.entries.map((e) => {
    if (typeof e?.id !== 'string' || !ids.has(e.typeId)) fail('An entry refers to an unknown type.');
    const type = types.find((t) => t.id === e.typeId);
    const v = validateEntryFields(type, e, Infinity);
    return { id: e.id, typeId: e.typeId, ...v, sessionId: typeof e.sessionId === 'string' ? e.sessionId : null };
  });

  const base = createInitialState();
  const settings = { ...base.settings, ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) };
  return { version: SCHEMA_VERSION, types, entries, session: null, settings };
}
