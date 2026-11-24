// Sample data for the test build: about eight weeks of random but plausible entries.

import * as M from './model.js';

const DAY = 86_400_000;

/** A deterministic random generator (mulberry32), so a given seed gives the same history. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOTES = [
  'Busy mind at first, settled after a few minutes.', 'Kept drifting to work.', 'Slept poorly the night before.',
  'Felt spacious.', 'Noisy neighbours.', 'Short but good.', 'Tired.', 'Walked to the lake afterwards.',
];

export function demoState({ now = Date.now(), seed = now, days = 56 } = {}) {
  const rand = rng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  let s = M.createInitialState(now - days * DAY);
  const id = (name) => s.types.find((t) => t.name === name).id;
  // An extra type so the history has some variety.
  s = M.defineType(s, { name: 'Went for a run', kind: 'activity', color: '#e6c84f' }, now - days * DAY);
  s = M.defineType(s, { name: 'Felt anxious', kind: 'mental_state', polarity: 'negative', color: '#d77fc4' }, now - days * DAY);

  const entries = [];
  const add = (typeId, ts, extra = {}) => {
    if (ts > now - 60_000) return;
    entries.push({ id: M.newId(), typeId, occurredAt: ts, durationMs: null, intensity: null, note: null, sessionId: null, ...extra });
  };
  const at = (dayStartTs, hour, minute = between(0, 59)) => dayStartTs + hour * 3_600_000 + minute * 60_000;

  for (let back = days; back >= 0; back--) {
    const d = new Date(now - back * DAY);
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const meditated = rand() < 0.62;
    if (meditated) {
      const sessions = rand() < 0.15 ? 2 : 1;
      for (let i = 0; i < sessions; i++) {
        add(id('Meditation'), at(day, i ? 20 : between(6, 9)), {
          durationMs: pick([10, 12, 15, 15, 20, 5, 30]) * 60_000,
          sessionId: rand() < 0.8 ? M.newId() : null,
          note: rand() < 0.2 ? pick(NOTES) : null,
        });
      }
    }
    if (rand() < 0.28) add(id('Met friends'), at(day, between(17, 21)), { durationMs: rand() < 0.5 ? between(1, 4) * 60 * 60_000 : null });
    if (rand() < 0.25) add(id('Went for a run'), at(day, between(6, 18)), { durationMs: between(20, 60) * 60_000 });
    // Meditating makes calm a bit likelier and poor sleep a bit less likely: gives Insights something to find.
    if (rand() < (meditated ? 0.5 : 0.22)) add(id('Felt calm'), at(day, between(10, 21)), { intensity: between(2, 5) });
    if (rand() < (meditated ? 0.1 : 0.32)) add(id("Couldn't fall asleep"), at(day, between(0, 3)), { intensity: between(1, 5), note: rand() < 0.3 ? pick(NOTES) : null });
    if (rand() < 0.2) add(id('Catastrophic thoughts'), at(day, between(8, 22)), { intensity: between(1, 5) });
    if (rand() < 0.18) add(id('Felt anxious'), at(day, between(8, 22)), { intensity: between(1, 5) });
  }
  return { ...s, entries };
}
