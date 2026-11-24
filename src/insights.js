// Associations between activities and mental states.
// Implements the Insights surface in spec/pawsterior.allium.

const DAY_MS = 86_400_000;

/** Local calendar day as an integer, DST-safe. */
export function dayIndex(ts) {
  const d = new Date(ts);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** Local midnight timestamp for a day index. */
export function dayStart(index) {
  const u = new Date(index * DAY_MS);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()).getTime();
}

function daysByType(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.typeId)) map.set(e.typeId, new Set());
    map.get(e.typeId).add(dayIndex(e.occurredAt));
  }
  return map;
}

/**
 * For each (activity, mental state) pair, compare how often the state was logged on
 * days "with" the activity (that day or up to lagDays before) vs all other days.
 */
export function computeInsights(state, { now = Date.now(), lagDays = 1, minDays = 3 } = {}) {
  if (state.entries.length === 0) return { days: 0, pairs: [] };
  const byType = daysByType(state.entries);
  const first = Math.min(...state.entries.map((e) => dayIndex(e.occurredAt)));
  const last = Math.max(dayIndex(now), ...state.entries.map((e) => dayIndex(e.occurredAt)));
  const days = [];
  for (let d = first; d <= last; d++) days.push(d);

  const activities = state.types.filter((t) => t.kind === 'activity' && byType.has(t.id));
  const states = state.types.filter((t) => t.kind === 'mental_state' && byType.has(t.id));
  const pairs = [];

  for (const a of activities) {
    const aDays = byType.get(a.id);
    const exposed = (d) => { for (let k = 0; k <= lagDays; k++) if (aDays.has(d - k)) return true; return false; };
    const withDays = days.filter(exposed);
    const withoutDays = days.filter((d) => !exposed(d));
    if (withDays.length < minDays || withoutDays.length < minDays) continue;

    for (const s of states) {
      const sDays = byType.get(s.id);
      const withHits = withDays.filter((d) => sDays.has(d)).length;
      const withoutHits = withoutDays.filter((d) => sDays.has(d)).length;
      const withRate = withHits / withDays.length;
      const withoutRate = withoutHits / withoutDays.length;
      const diff = withRate - withoutRate;
      pairs.push({
        activityId: a.id, stateId: s.id,
        withDays: withDays.length, withHits, withRate,
        withoutDays: withoutDays.length, withoutHits, withoutRate,
        diff,
        favorable: diff === 0 ? null : (s.polarity === 'good' ? diff > 0 : diff < 0),
      });
    }
  }
  pairs.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  return { days: days.length, pairs };
}

/** Meditation summary for the last 7 days (today and the 6 days before): minutes and distinct days. */
export function meditationSummary(state, now = Date.now()) {
  const med = state.types.find((t) => t.isMeditation);
  const entries = med ? state.entries.filter((e) => e.typeId === med.id) : [];
  const today = dayIndex(now);
  const week = entries.filter((e) => today - dayIndex(e.occurredAt) < 7);
  const weekMinutes = Math.round(week.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / 60_000);
  const weekDays = new Set(week.map((e) => dayIndex(e.occurredAt))).size;
  return { weekMinutes, weekDays };
}

/** Grid of the last `n` days: for each type with entries, which days it was logged and how strongly. */
export function recentGrid(state, { now = Date.now(), n = 21 } = {}) {
  const today = dayIndex(now);
  const dayList = Array.from({ length: n }, (_, i) => today - (n - 1) + i);
  const byType = daysByType(state.entries.filter((e) => today - dayIndex(e.occurredAt) < n));
  const counts = new Map();
  const levels = new Map();
  for (const e of state.entries) {
    const d = dayIndex(e.occurredAt);
    if (today - d >= n || d > today) continue;
    const key = `${e.typeId}:${d}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (e.intensity) levels.set(key, Math.max(levels.get(key) ?? 0, e.intensity));
  }
  const rows = state.types
    .filter((t) => byType.has(t.id))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'activity' ? -1 : 1))
    .map((t) => ({ type: t, cells: dayList.map((d) => counts.get(`${t.id}:${d}`) ?? 0),
      // Highest rating logged that day (0 if none rated), used to shade mental-state cells.
      levels: dayList.map((d) => levels.get(`${t.id}:${d}`) ?? 0) }));
  return { days: dayList, rows };
}
