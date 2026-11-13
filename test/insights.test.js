import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';
import { computeInsights, meditationSummary, recentGrid, dayIndex, dayStart } from '../src/insights.js';

const at = (day, hour = 12) => new Date(2026, 9, day, hour).getTime(); // October 2026, local time
const byName = (s, n) => s.types.find((t) => t.name === n);

function stateWith(log) {
  let s = M.createInitialState(at(1));
  for (const [name, day, hour, extra] of log) {
    s = M.logEntry(s, { typeId: byName(s, name).id, occurredAt: at(day, hour), ...extra }, Infinity);
  }
  return s;
}

test('dayIndex is a local calendar day and survives DST changes', () => {
  assert.equal(dayIndex(at(10, 0)), dayIndex(at(10, 23)));
  assert.equal(dayIndex(at(11, 0)) - dayIndex(at(10, 23)), 1);
  // Europe and the US change clocks in late Oct / early Nov; consecutive days stay consecutive.
  for (let d = 20; d < 31; d++) assert.equal(dayIndex(at(d + 1)) - dayIndex(at(d)), 1);
  assert.equal(dayStart(dayIndex(at(15, 18))), new Date(2026, 9, 15).getTime());
});

test('computeInsights compares days with and without an activity', () => {
  // Meditation on days 1-5; bad sleep on days 3 and 8, 9, 10. Data spans days 1-10.
  const s = stateWith([
    ...[1, 2, 3, 4, 5].map((d) => ['Meditation', d, 7, { durationMs: 600_000 }]),
    ...[3, 8, 9, 10].map((d) => ["Couldn't fall asleep", d, 23]),
  ]);
  const { days, pairs } = computeInsights(s, { now: at(10, 23), lagDays: 0 });
  assert.equal(days, 10);
  const p = pairs.find((x) => x.activityId === byName(s, 'Meditation').id);
  assert.equal(p.withDays, 5);
  assert.equal(p.withHits, 1);
  assert.equal(p.withoutDays, 5);
  assert.equal(p.withoutHits, 3);
  assert.equal(p.withRate, 0.2);
  assert.equal(p.withoutRate, 0.6);
  assert.ok(Math.abs(p.diff + 0.4) < 1e-9);
  assert.equal(p.favorable, true, 'a bad state that is rarer with the activity is favourable');
});

test('lag extends "with" to following days', () => {
  const s = stateWith([
    ...[1, 4, 7].map((d) => ['Met friends', d]),
    ['Felt calm', 2], ['Felt calm', 5], ['Felt calm', 8],
  ]);
  const now = at(9);
  const same = computeInsights(s, { now, lagDays: 0 }).pairs.find((p) => p.stateId === byName(s, 'Felt calm').id);
  assert.equal(same.withRate, 0, 'never on the same day');
  const next = computeInsights(s, { now, lagDays: 1 }).pairs.find((p) => p.stateId === byName(s, 'Felt calm').id);
  assert.equal(next.withDays, 6); // days 1,2,4,5,7,8
  assert.equal(next.withHits, 3);
  assert.equal(next.withoutHits, 0);
  assert.equal(next.favorable, true, 'a good state that is commoner with the activity is favourable');
});

test('pairs need enough days on both sides and at least one mental state', () => {
  const few = stateWith([['Meditation', 1], ['Meditation', 2], ['Felt calm', 3]]);
  assert.deepEqual(computeInsights(few, { now: at(6), lagDays: 0 }).pairs, []);
  const noStates = stateWith([['Meditation', 1], ['Meditation', 2], ['Meditation', 3]]);
  assert.deepEqual(computeInsights(noStates, { now: at(10), lagDays: 0 }).pairs, []);
  assert.deepEqual(computeInsights(M.createInitialState(), {}), { days: 0, pairs: [] });
});

test('pairs are sorted by the size of the difference', () => {
  const s = stateWith([
    ...[1, 2, 3, 4].map((d) => ['Meditation', d]),
    ...[1, 2, 3, 4].map((d) => ['Felt calm', d]),
    ['Catastrophic thoughts', 2], ['Catastrophic thoughts', 6],
  ]);
  const { pairs } = computeInsights(s, { now: at(8), lagDays: 0 });
  assert.equal(pairs[0].stateId, byName(s, 'Felt calm').id);
  assert.ok(Math.abs(pairs[0].diff) >= Math.abs(pairs[1].diff));
});

test('meditationSummary counts the week and the streak', () => {
  const s = stateWith([
    ['Meditation', 1, 7, { durationMs: 20 * 60_000 }],
    ['Meditation', 8, 7, { durationMs: 10 * 60_000 }],
    ['Meditation', 9, 7, { durationMs: 15 * 60_000 }],
    ['Meditation', 9, 20, { durationMs: 5 * 60_000 }],
  ]);
  const today = meditationSummary(s, at(10, 9));
  assert.equal(today.weekMinutes, 30);
  assert.equal(today.weekSessions, 3);
  assert.equal(today.totalSessions, 4);
  assert.equal(today.streak, 2, 'streak holds until the end of today');
  assert.equal(meditationSummary(s, at(11, 9)).streak, 0);
});

test('recentGrid lays out the last n days per type', () => {
  const s = stateWith([['Met friends', 9], ['Met friends', 9], ['Felt calm', 10], ['Meditation', 1]]);
  const g = recentGrid(s, { now: at(10, 20), n: 3 });
  assert.equal(g.days.length, 3);
  assert.deepEqual(g.rows.map((r) => r.type.name), ['Met friends', 'Felt calm']);
  assert.deepEqual(g.rows[0].cells, [0, 2, 0]);
  assert.deepEqual(g.rows[1].cells, [0, 0, 1]);
});
