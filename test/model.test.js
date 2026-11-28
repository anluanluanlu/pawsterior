import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';

const T0 = new Date(2026, 10, 10, 9, 0).getTime();
const MIN = 60_000;
const byName = (s, n) => s.types.find((t) => t.name === n);

test('initial state seeds exactly one meditation type and the example types', () => {
  const s = M.createInitialState(T0);
  assert.equal(s.types.filter((t) => t.isMeditation).length, 1);
  assert.equal(M.meditationType(s).kind, 'activity');
  assert.equal(byName(s, "Couldn't fall asleep").polarity, 'negative');
  assert.equal(byName(s, 'Felt calm').polarity, 'good');
  assert.equal(byName(s, 'Met friends').polarity, null);
});

test('defineType validates name, kind and polarity', () => {
  let s = M.createInitialState(T0);
  s = M.defineType(s, { name: '  Went   for a walk ', kind: 'activity', polarity: 'good', color: '#ABCDEF' });
  const walk = byName(s, 'Went for a walk');
  assert.ok(walk, 'name is normalised');
  assert.equal(walk.polarity, null, 'activities never carry polarity');
  assert.equal(walk.color, '#abcdef');

  assert.throws(() => M.defineType(s, { name: 'went FOR a walk', kind: 'activity' }), M.ValidationError);
  assert.throws(() => M.defineType(s, { name: '', kind: 'activity' }), M.ValidationError);
  assert.throws(() => M.defineType(s, { name: 'x'.repeat(61), kind: 'activity' }), M.ValidationError);
  assert.throws(() => M.defineType(s, { name: 'Anxious', kind: 'mental_state' }), /good or a negative/);
  assert.throws(() => M.defineType(s, { name: 'Anxious', kind: 'mood' }), M.ValidationError);
});

test('editType keeps kind fixed once entries exist, and meditation always an activity', () => {
  let s = M.createInitialState(T0);
  const friends = byName(s, 'Met friends');
  s = M.editType(s, friends.id, { kind: 'mental_state', polarity: 'good' });
  assert.equal(M.getType(s, friends.id).kind, 'mental_state');
  s = M.editType(s, friends.id, { kind: 'activity' });
  s = M.logEntry(s, { typeId: friends.id, occurredAt: T0 }, T0);
  assert.throws(() => M.editType(s, friends.id, { kind: 'mental_state', polarity: 'good' }), /cannot change/);
  assert.throws(() => M.editType(s, M.meditationType(s).id, { kind: 'mental_state', polarity: 'good' }), /always an activity/);
  s = M.editType(s, M.meditationType(s).id, { name: 'Sitting' });
  assert.equal(M.meditationType(s).name, 'Sitting');
});

test('archive, restore and delete obey the rules', () => {
  let s = M.createInitialState(T0);
  const med = M.meditationType(s);
  const calm = byName(s, 'Felt calm');
  assert.throws(() => M.archiveType(s, med.id), M.ValidationError);
  assert.throws(() => M.deleteType(s, med.id), M.ValidationError);

  s = M.logEntry(s, { typeId: calm.id, occurredAt: T0 }, T0);
  assert.throws(() => M.deleteType(s, calm.id), /Archive it instead/);
  s = M.archiveType(s, calm.id);
  assert.throws(() => M.logEntry(s, { typeId: calm.id, occurredAt: T0 }, T0), /archived/);
  s = M.restoreType(s, calm.id);
  s = M.logEntry(s, { typeId: calm.id, occurredAt: T0 }, T0);
  assert.equal(M.entriesOfType(s, calm.id).length, 2);

  const friends = byName(s, 'Met friends');
  s = M.deleteType(s, friends.id);
  assert.equal(M.getType(s, friends.id), null);
});

test('logEntry validates time, duration, intensity and note', () => {
  const s = M.createInitialState(T0);
  const friends = byName(s, 'Met friends').id;
  const sleep = byName(s, "Couldn't fall asleep").id;

  const ok = M.logEntry(s, { typeId: friends, occurredAt: T0, durationMs: 90 * MIN, note: '  pub quiz  ' }, T0);
  assert.equal(ok.entries[0].note, 'pub quiz');
  assert.equal(ok.entries[0].durationMs, 90 * MIN);
  assert.equal(M.logEntry(s, { typeId: friends, occurredAt: T0, note: '   ' }, T0).entries[0].note, null);

  assert.throws(() => M.logEntry(s, { typeId: friends, occurredAt: T0 + 5 * MIN }, T0), /future/);
  assert.doesNotThrow(() => M.logEntry(s, { typeId: friends, occurredAt: T0 + 30_000 }, T0));
  assert.throws(() => M.logEntry(s, { typeId: friends, occurredAt: NaN }, T0), M.ValidationError);
  assert.throws(() => M.logEntry(s, { typeId: sleep, occurredAt: T0, durationMs: MIN }, T0), /Only activities/);
  assert.throws(() => M.logEntry(s, { typeId: friends, occurredAt: T0, durationMs: -1 }, T0), M.ValidationError);
  assert.throws(() => M.logEntry(s, { typeId: sleep, occurredAt: T0, intensity: 6 }, T0), /Intensity/);
  assert.throws(() => M.logEntry(s, { typeId: sleep, occurredAt: T0, intensity: 2.5 }, T0), /Intensity/);
  assert.equal(M.logEntry(s, { typeId: sleep, occurredAt: T0, intensity: 4 }, T0).entries[0].intensity, 4);
  assert.throws(() => M.logEntry(s, { typeId: sleep, occurredAt: T0, note: 'x'.repeat(501) }, T0), /Notes/);
  assert.throws(() => M.logEntry(s, { typeId: 'nope', occurredAt: T0 }, T0), M.ValidationError);
});

test('editEntry and deleteEntry', () => {
  let s = M.createInitialState(T0);
  const sleep = byName(s, "Couldn't fall asleep").id;
  s = M.logEntry(s, { typeId: sleep, occurredAt: T0 }, T0);
  const id = s.entries[0].id;
  s = M.editEntry(s, id, { intensity: 3, note: 'racing thoughts', occurredAt: T0 - 60 * MIN }, T0);
  assert.deepEqual(
    { i: s.entries[0].intensity, n: s.entries[0].note, t: s.entries[0].occurredAt },
    { i: 3, n: 'racing thoughts', t: T0 - 60 * MIN },
  );
  s = M.deleteEntry(s, id);
  assert.equal(s.entries.length, 0);
  assert.throws(() => M.deleteEntry(s, id), M.ValidationError);
});

test('meditation session runs to completion and logs the planned duration', () => {
  let s = M.createInitialState(T0);
  s = M.startSession(s, { plannedMs: 10 * MIN, ambient: 'rain', intervalMs: 2 * MIN }, T0);
  assert.equal(s.session.status, 'running');
  assert.deepEqual(s.settings, { durationMs: 10 * MIN, ambient: 'rain', intervalMs: 2 * MIN, warmupMs: 0 }, 'choices are remembered');
  assert.throws(() => M.startSession(s, { plannedMs: 10 * MIN }, T0), /already/);

  let r = M.tickSession(s, T0 + 9 * MIN);
  assert.equal(r.completed, false);
  r = M.tickSession(s, T0 + 10 * MIN + 400);
  assert.equal(r.completed, true);
  assert.equal(r.state.session, null);
  const [entry] = r.state.entries;
  assert.equal(entry.typeId, M.meditationType(s).id);
  assert.equal(entry.durationMs, 10 * MIN, 'never logs more than planned');
  assert.equal(entry.occurredAt, T0);
  assert.equal(entry.sessionId, s.session.id);
});

test('pauses are excluded from elapsed time', () => {
  let s = M.createInitialState(T0);
  s = M.startSession(s, { plannedMs: 5 * MIN }, T0);
  s = M.pauseSession(s, T0 + 2 * MIN);
  assert.equal(M.sessionElapsed(s.session, T0 + 30 * MIN), 2 * MIN, 'paused clock stands still');
  assert.equal(M.tickSession(s, T0 + 30 * MIN).completed, false, 'paused sessions never complete on their own');
  assert.throws(() => M.pauseSession(s, T0 + 3 * MIN), M.ValidationError);
  s = M.resumeSession(s, T0 + 12 * MIN);
  assert.equal(M.sessionElapsed(s.session, T0 + 13 * MIN), 3 * MIN);
  assert.equal(M.sessionRemaining(s.session, T0 + 13 * MIN), 2 * MIN);
  assert.equal(M.tickSession(s, T0 + 15 * MIN - 1).completed, false);
  assert.equal(M.tickSession(s, T0 + 15 * MIN).completed, true);
});

test('finishing early logs actual time; under a minute it must be discarded', () => {
  let s = M.createInitialState(T0);
  s = M.startSession(s, { plannedMs: 20 * MIN }, T0);
  assert.throws(() => M.finishSessionEarly(s, T0 + 30_000), /Discard/);
  const done = M.finishSessionEarly(s, T0 + 7 * MIN);
  assert.equal(done.entries[0].durationMs, 7 * MIN);
  assert.equal(done.session, null);

  const paused = M.pauseSession(s, T0 + 4 * MIN);
  assert.equal(M.finishSessionEarly(paused, T0 + 9 * MIN).entries[0].durationMs, 4 * MIN);

  const discarded = M.discardSession(s);
  assert.equal(discarded.session, null);
  assert.equal(discarded.entries.length, 0, 'discarding leaves no entry');
});

test('warm-up delays the meditation clock and is not logged', () => {
  let s = M.createInitialState(T0);
  assert.equal(s.settings.warmupMs, 15_000, 'default warm-up is 15 s');
  s = M.startSession(s, { plannedMs: 5 * MIN, warmupMs: 15_000 }, T0);
  assert.equal(M.sessionWarmupRemaining(s.session, T0 + 5_000), 10_000);
  assert.equal(M.sessionElapsed(s.session, T0 + 5_000), 0);
  assert.equal(M.sessionRemaining(s.session, T0 + 5_000), 5 * MIN);
  assert.equal(M.sessionWarmupRemaining(s.session, T0 + 20_000), 0);
  assert.equal(M.sessionElapsed(s.session, T0 + 75_000), MIN);
  // pausing during the warm-up freezes it
  s = M.pauseSession(s, T0 + 5_000);
  s = M.resumeSession(s, T0 + 65_000);
  assert.equal(M.sessionWarmupRemaining(s.session, T0 + 65_000), 10_000);
  assert.equal(M.tickSession(s, T0 + 15_000 + 60_000 + 5 * MIN - 1).completed, false);
  const done = M.tickSession(s, T0 + 15_000 + 60_000 + 5 * MIN);
  assert.equal(done.completed, true);
  assert.equal(done.state.entries[0].durationMs, 5 * MIN, 'warm-up is not part of the logged duration');
  assert.throws(() => M.startSession(M.createInitialState(T0), { plannedMs: 5 * MIN, warmupMs: -1 }, T0), M.ValidationError);
  assert.throws(() => M.startSession(M.createInitialState(T0), { plannedMs: 5 * MIN, warmupMs: 301_000 }, T0), M.ValidationError);
});

test('startSession validates duration and interval bell', () => {
  const s = M.createInitialState(T0);
  assert.throws(() => M.startSession(s, { plannedMs: 30_000 }, T0), M.ValidationError);
  assert.throws(() => M.startSession(s, { plannedMs: 241 * MIN }, T0), M.ValidationError);
  assert.throws(() => M.startSession(s, { plannedMs: 5 * MIN, intervalMs: 5 * MIN }, T0), /Interval/);
  assert.throws(() => M.startSession(s, { plannedMs: 5 * MIN, intervalMs: 30_000 }, T0), /Interval/);
  assert.throws(() => M.startSession(s, { plannedMs: 5 * MIN, ambient: 'whale' }, T0), /ambient/);
});

test('export / import round-trips and rejects invalid files', () => {
  let s = M.createInitialState(T0);
  s = M.logEntry(s, { typeId: byName(s, 'Felt calm').id, occurredAt: T0, intensity: 2, note: 'ok' }, T0);
  s = M.startSession(s, { plannedMs: 5 * MIN }, T0);
  const back = M.importState(M.exportState(s, T0));
  assert.deepEqual(back.types, s.types);
  assert.deepEqual(back.entries, s.entries);
  assert.equal(back.session, null, 'an in-progress session is not imported');

  assert.throws(() => M.importState('{nope'), /JSON/);
  assert.throws(() => M.importState({ version: 99, types: [], entries: [] }), /version/);
  const noMed = JSON.parse(M.exportState(s));
  noMed.types = noMed.types.filter((t) => !t.isMeditation);
  assert.throws(() => M.importState(noMed), /meditation/);
  const orphan = JSON.parse(M.exportState(s));
  orphan.entries.push({ id: 'x', typeId: 'missing', occurredAt: T0 });
  assert.throws(() => M.importState(orphan), /unknown type/);
  const dupe = JSON.parse(M.exportState(s));
  dupe.types.push({ ...dupe.types[1], id: 'other' });
  assert.throws(() => M.importState(dupe), /already exists/);
});

test('ratings: defaults, per-type names and descriptions, and entries keep the scale they were logged under', () => {
  let s = M.createInitialState(T0);
  const sleep = byName(s, "Couldn't fall asleep");
  const cat = byName(s, 'Catastrophic thoughts');
  assert.deepEqual(M.ratingOf(sleep), { name: 'Severity', labels: ['', '', '', '', ''] });
  assert.equal(M.ratingOf(byName(s, 'Felt calm')).name, 'Strength');
  assert.deepEqual(M.ratingOf(cat), { name: 'Pull', labels: ['Barely', 'A little', 'Moderate', 'Quite a bit', 'A lot'] });

  s = M.logEntry(s, { typeId: cat.id, occurredAt: T0, intensity: 3 }, T0);
  s = M.editType(s, cat.id, { rating: { name: ' Weight ', labels: ['', '', '', '', 'Huge'] } });
  assert.deepEqual(M.ratingOf(byName(s, 'Catastrophic thoughts')), { name: 'Weight', labels: ['', '', '', '', 'Huge'] });
  assert.equal(s.entries[0].scale.name, 'Pull', 'the earlier entry keeps the wording it was rated under');
  s = M.logEntry(s, { typeId: cat.id, occurredAt: T0, intensity: 5 }, T0);
  assert.equal(s.entries[1].scale.name, 'Weight');
  s = M.logEntry(s, { typeId: cat.id, occurredAt: T0 }, T0);
  assert.equal(s.entries[2].scale, null, 'unrated entries carry no scale');

  s = M.editType(s, cat.id, { rating: { name: '', labels: ['', '', '', '', ''] } });
  assert.equal(byName(s, 'Catastrophic thoughts').rating, null, 'a blank rating returns to the defaults');
  assert.throws(() => M.editType(s, cat.id, { rating: { name: 'x'.repeat(31), labels: [] } }), /Rating names/);
  assert.throws(() => M.editType(s, cat.id, { rating: { name: 'ok', labels: ['x'.repeat(21)] } }), /descriptions/);
  const friends = M.editType(s, byName(s, 'Met friends').id, { rating: { name: 'Pull', labels: [] } });
  assert.equal(byName(friends, 'Met friends').rating, null, 'activities have no rating');
});

test('older saves: Catastrophic thoughts gets Pull once, and rated entries keep their old wording', () => {
  const old = M.createInitialState(T0);
  const cat = byName(old, 'Catastrophic thoughts');
  delete cat.rating;
  const logged = { id: 'e1', typeId: cat.id, occurredAt: T0, durationMs: null, intensity: 4, note: null, sessionId: null };
  const migrated = M.migrateLegacy({ ...old, entries: [logged] });
  assert.equal(byName(migrated, 'Catastrophic thoughts').rating.name, 'Pull');
  assert.deepEqual(migrated.entries[0].scale, { name: 'Severity', labels: ['Barely', 'Mild', 'Moderate', 'Strong', 'Severe'] });
  const calm = byName(old, 'Felt calm');
  const good = M.migrateLegacy({ ...old, entries: [{ ...logged, id: 'e2', typeId: calm.id, intensity: 2 }] });
  assert.deepEqual(good.entries[0].scale, { name: 'Strength', labels: ['Slightly', 'Somewhat', 'Moderately', 'Very', 'Deeply'] });
  assert.equal(M.migrateLegacy(migrated), migrated, 'migrating twice changes nothing');
  const cleared = M.editType(migrated, cat.id, { rating: null });
  assert.equal(M.migrateLegacy(cleared), cleared, 'a rating the user cleared is not put back');
  const back = M.importState(M.exportState(migrated, T0));
  assert.deepEqual(back.entries[0].scale, migrated.entries[0].scale);
});

test('a save that already has the first Pull wording gets "Moderate"', () => {
  const s = M.createInitialState(T0);
  const cat = byName(s, 'Catastrophic thoughts');
  cat.rating = { name: 'Pull', labels: ['Barely', 'A little', 'Moderately', 'Quite a bit', 'A lot'] };
  const fixed = M.migrateLegacy(s);
  assert.deepEqual(byName(fixed, 'Catastrophic thoughts').rating.labels, ['Barely', 'A little', 'Moderate', 'Quite a bit', 'A lot']);
  cat.rating = { name: 'Pull', labels: ['', '', 'My own', '', ''] };
  assert.equal(M.migrateLegacy(s), s, 'the person\'s own wording is left alone');
});
