// UI layer: rendering, routing, persistence, sound and wake-lock wiring.
// Domain rules live in model.js; this file never mutates state except through it.

import * as M from './model.js';
import { computeInsights, meditationSummary, recentGrid, dayIndex, dayStart } from './insights.js';
import { SoundEngine } from './sounds.js';
import { IS_TEST, STORAGE_KEY, APP_TITLE, API_URL, SYNC_PROFILE, AUTH_KEY, SYNC_META_KEY } from './env.js';
import { createSync } from './sync.js';
import { demoState } from './seed.js';

const ROUTES = ['meditate', 'log', 'history', 'insights', 'settings'];
const PALETTE = ['#7c9cff', '#5cc8a8', '#8fd16a', '#e6c84f', '#d9a05b', '#e07a7a',
  '#d77fc4', '#a08cf0', '#5fb7e6', '#9aa4b2', '#c9925f', '#6fcf97'];
const AMBIENT_LABELS = { silence: 'Silence', brown_noise: 'Brown noise', rain: 'Rain', ocean: 'Ocean' };
const DURATIONS = [10, 12, 15];
const INTERVALS = [0, 1, 2, 5, 10];

const sound = new SoundEngine();
const $view = document.getElementById('view');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');

let sync = null; // created at boot, once everything it needs exists
let state = load();
if (IS_TEST) persist(); // persist the sample data right away
let historyFilter = 'all';
let insightLag = 1;
let wakeLock = null;
let installPrompt = null;

// ================================================================ persistence

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s?.version === M.SCHEMA_VERSION && Array.isArray(s.types) && Array.isArray(s.entries)) {
        // Fill in settings added since the data was saved.
        return { ...s, settings: { ...M.createInitialState().settings, ...s.settings } };
      }
    }
  } catch { /* fall through to a fresh state */ }
  // The test build starts with sample entries; the real app starts empty.
  return IS_TEST ? demoState() : M.createInitialState();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    toast('Could not save. Is storage full or blocked?', { error: true });
  }
}

/** Save on this device, then let cloud sync know. */
function save() {
  persist();
  sync?.noteSaved();
}

/** Apply a model operation. Returns true on success; shows the reason on failure. */
function apply(fn) {
  try {
    state = fn(state);
    save();
    render();
    return true;
  } catch (e) {
    if (e instanceof M.ValidationError) { toast(e.message, { error: true }); return false; }
    throw e;
  }
}

// ================================================================ helpers

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function dayLabel(index) {
  const today = dayIndex(Date.now());
  if (index === today) return 'Today';
  if (index === today - 1) return 'Yesterday';
  const opts = { weekday: 'long', day: 'numeric', month: 'long' };
  if (new Date(dayStart(index)).getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return new Date(dayStart(index)).toLocaleDateString([], opts);
}

function toLocalInput(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const polarityBadge = (t) => t.kind === 'mental_state'
  ? `<span class="badge ${t.polarity}">${t.polarity === 'good' ? '▲ good' : '▼ bad'}</span>` : '';

function entryMeta(e, type) {
  const bits = [];
  if (e.durationMs) bits.push(fmtDuration(e.durationMs));
  if (e.intensity) bits.push(`intensity ${e.intensity}/5`);
  if (type?.isMeditation && e.sessionId) bits.push('timed session');
  return bits.join(' · ');
}

function entryRow(e) {
  const type = M.getType(state, e.typeId);
  const meta = entryMeta(e, type);
  return `<li><button class="entry" data-action="edit-entry" data-id="${e.id}">
    <span class="dot" style="background:${esc(type?.color)}"></span>
    <span class="main">
      <span class="name">${esc(type?.name ?? 'Unknown')}</span> ${type ? polarityBadge(type) : ''}
      ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
      ${e.note ? `<span class="note">${esc(e.note)}</span>` : ''}
    </span>
    <time datetime="${new Date(e.occurredAt).toISOString()}">${fmtTime(e.occurredAt)}</time>
  </button></li>`;
}

// ================================================================ routing & render

const currentRoute = () => {
  const r = location.hash.replace(/^#\/?/, '');
  return ROUTES.includes(r) ? r : 'meditate';
};

function render() {
  const signedIn = sync.status().signedIn;
  document.body.classList.toggle('signed-out', !signedIn);
  updateHeader();
  if (!signedIn) { showGate(); return; }
  const route = currentRoute();
  $view.innerHTML = VIEWS[route]();
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  updateTimer();
}

window.addEventListener('hashchange', () => { render(); $view.focus({ preventScroll: true }); window.scrollTo(0, 0); });

// ================================================================ views

const VIEWS = {
  meditate() {
    return state.session ? sessionView() : setupView();
  },

  log() {
    const live = state.types.filter((t) => !t.archived);
    const acts = live.filter((t) => t.kind === 'activity');
    const good = live.filter((t) => t.kind === 'mental_state' && t.polarity === 'good');
    const bad = live.filter((t) => t.kind === 'mental_state' && t.polarity === 'bad');
    const btns = (list) => list.length
      ? `<div class="type-grid">${list.map((t) => `<button class="type-btn" style="--c:${esc(t.color)}" data-action="quick-log" data-id="${t.id}">
          <span class="name">${esc(t.name)}</span></button>`).join('')}</div>`
      : '<p class="muted small">Nothing here yet.</p>';
    const today = dayIndex(Date.now());
    const todays = M.sortedEntries(state).filter((e) => dayIndex(e.occurredAt) === today);
    return `
      <div class="section-head"><h2>Log</h2><button class="small" data-action="new-type">+ New type</button></div>
      <p class="muted small">Tap to log it now. You can add details or change the time afterwards.</p>
      <h3>Activities &amp; happenings</h3>${btns(acts)}
      <h3>Mental state · good signs</h3>${btns(good)}
      <h3>Mental state · bad signs</h3>${btns(bad)}
      <h3>Today</h3>
      ${todays.length ? `<ul class="entries card">${todays.map(entryRow).join('')}</ul>` : '<p class="muted small">Nothing logged today.</p>'}
      <button class="ghost small" data-action="log-past">Log something at another time…</button>`;
  },

  history() {
    let list = M.sortedEntries(state);
    if (historyFilter === 'activity' || historyFilter === 'mental_state') {
      list = list.filter((e) => M.getType(state, e.typeId)?.kind === historyFilter);
    } else if (historyFilter !== 'all') {
      list = list.filter((e) => e.typeId === historyFilter);
    }
    const groups = new Map();
    for (const e of list) {
      const d = dayIndex(e.occurredAt);
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(e);
    }
    const typeOpts = [...state.types].sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => `<option value="${t.id}" ${historyFilter === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
    return `
      <div class="section-head"><h2>History</h2></div>
      <label class="field"><span>Show</span>
        <select data-change="history-filter">
          <option value="all" ${historyFilter === 'all' ? 'selected' : ''}>Everything</option>
          <option value="activity" ${historyFilter === 'activity' ? 'selected' : ''}>Activities &amp; happenings</option>
          <option value="mental_state" ${historyFilter === 'mental_state' ? 'selected' : ''}>Mental states</option>
          <optgroup label="Type">${typeOpts}</optgroup>
        </select>
      </label>
      ${groups.size === 0 ? '<div class="empty">No entries yet. Meditate or log something to start your history.</div>' : ''}
      ${[...groups].map(([d, es]) => `
        <div class="day-label">${esc(dayLabel(d))}</div>
        <ul class="entries">${es.map(entryRow).join('')}</ul>`).join('')}`;
  },

  insights() {
    const sum = meditationSummary(state);
    const grid = recentGrid(state, { n: 21 });
    const { days, pairs } = computeInsights(state, { lagDays: insightLag });
    const lagChip = (v, label) => `<button class="chip" aria-pressed="${insightLag === v}" data-action="lag" data-v="${v}">${label}</button>`;
    const pct = (x) => `${Math.round(x * 100)}%`;
    const pairHtml = pairs.slice(0, 30).map((p) => {
      const a = M.getType(state, p.activityId), s = M.getType(state, p.stateId);
      const pts = Math.round(p.diff * 100);
      const cls = p.favorable === null ? '' : p.favorable ? 'good' : 'bad';
      const arrow = pts > 0 ? `↑ ${pts}` : pts < 0 ? `↓ ${-pts}` : '±0';
      return `<div class="pair">
        <div class="title row"><span class="dot" style="background:${esc(s.color)}"></span>
          <span><b>${esc(s.name)}</b> <span class="muted">with</span> <b>${esc(a.name)}</b></span>
          <span class="spacer"></span><span class="delta ${cls}" title="Percentage points">${arrow} pts</span></div>
        <div class="bar" style="--c:${esc(s.color)}"><span>with</span><span class="track"><span class="fill" style="width:${pct(p.withRate)}"></span></span><span class="pct">${pct(p.withRate)}</span></div>
        <div class="bar" style="--c:${esc(s.color)}"><span>without</span><span class="track"><span class="fill without" style="width:${pct(p.withoutRate)}"></span></span><span class="pct">${pct(p.withoutRate)}</span></div>
        <div class="muted small">${p.withHits} of ${p.withDays} days with ${esc(a.name)} vs ${p.withoutHits} of ${p.withoutDays} days without.</div>
      </div>`;
    }).join('');
    const dayHead = grid.days.map((d) => {
      const dt = new Date(dayStart(d));
      return `<th scope="col" title="${esc(dt.toLocaleDateString())}">${dt.getDay() === 1 || d === grid.days[0] ? dt.getDate() : ''}</th>`;
    }).join('');
    return `
      <div class="section-head"><h2>Insights</h2></div>
      <div class="stats">
        <div class="stat"><b>${sum.weekMinutes}</b><span>min in last 7 days</span></div>
        <div class="stat"><b>${sum.weekDays}</b><span>days meditated in last 7 days</span></div>
      </div>

      <h3>Last 3 weeks</h3>
      ${grid.rows.length ? `<div class="card grid-wrap"><table class="heat">
        <thead><tr><th></th>${dayHead}</tr></thead>
        <tbody>${grid.rows.map((r) => `<tr><th scope="row" title="${esc(r.type.name)}">${esc(r.type.name)}</th>${r.cells.map((c, i) =>
          `<td class="${c ? 'on' : ''}" style="--c:${esc(r.type.color)}" title="${esc(new Date(dayStart(grid.days[i])).toLocaleDateString())}: ${c}"></td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted small">Nothing logged in the last 3 weeks.</p>'}

      <h3>What goes together</h3>
      <p class="muted small">Count a day as "with" an activity if it happened</p>
      <div class="chips">${lagChip(0, 'that day')}${lagChip(1, 'that day or the day before')}${lagChip(2, 'within 2 days before')}</div>
      ${pairs.length ? `<div class="card">${pairHtml}</div>` : `<div class="empty">
        ${days < 7 ? `You have ${days} day${days === 1 ? '' : 's'} of data.` : 'Not enough contrast yet.'}
        Insights appear once an activity has at least 3 days with it and 3 without, and at least one mental state has been logged.
      </div>`}
      <p class="notice">These are associations in your own data, not causes. Small numbers swing a lot: look for patterns that hold up over weeks.</p>`;
  },

  settings() {
    const counts = new Map();
    state.entries.forEach((e) => counts.set(e.typeId, (counts.get(e.typeId) ?? 0) + 1));
    const row = (t) => `<div class="type-row ${t.archived ? 'archived' : ''}">
      <span class="dot" style="background:${esc(t.color)}"></span>
      <span class="main">
        <span class="name">${esc(t.name)}</span>
        <span class="meta">${t.isMeditation ? '<span class="badge">timer</span> ' : ''}${polarityBadge(t)}
          <span class="muted small">${counts.get(t.id) ?? 0} logged</span></span>
      </span>
      <span class="actions">
        <button class="small" data-action="edit-type" data-id="${t.id}">Edit</button>
        ${t.isMeditation ? '' : t.archived
          ? `<button class="small ghost" data-action="restore-type" data-id="${t.id}">Restore</button>`
          : `<button class="small ghost" data-action="archive-type" data-id="${t.id}">Archive</button>`}
      </span>
    </div>`;
    const sorted = [...state.types].sort((a, b) => a.archived - b.archived || a.name.localeCompare(b.name));
    return `
      <div class="section-head"><h2>Setup</h2><button class="small" data-action="new-type">+ New type</button></div>
      <h3>Activities &amp; happenings</h3>
      <div class="card">${sorted.filter((t) => t.kind === 'activity').map(row).join('') || '<p class="muted small">None yet.</p>'}</div>
      <h3>Mental states</h3>
      <div class="card">${sorted.filter((t) => t.kind === 'mental_state').map(row).join('') || '<p class="muted small">None yet.</p>'}</div>

      <h3>Account &amp; sync</h3>
      ${accountCard()}

      <h3>Your data</h3>
      <div class="card">
        <p class="small muted">${sync.status().signedIn
          ? 'Your data lives on this device and is synced to your account. Backups are still handy.'
          : 'Everything stays on this device, in this browser. Export a backup now and then, or sign in above to sync across devices.'}</p>
        <div class="row wrap">
          <button data-action="export">Export backup</button>
          <button data-action="import">Import backup…</button>
          <span class="spacer"></span>
          <button class="danger" data-action="erase">Erase everything</button>
        </div>
        <input type="file" id="import-file" accept="application/json,.json" hidden>
      </div>

      ${IS_TEST ? `<h3>Test build</h3>
      <div class="card small">
        <p>This is the TEST build. Its data is stored separately from the real app and stays here between visits.</p>
        <button class="small" data-action="reset-test-data">Regenerate sample data</button>
      </div>` : ''}

      <h3>About</h3>
      <div class="card small">
        <p>Pawsterior tracks meditation and the things that shape your mind, alongside how you're actually doing.</p>
        <p class="muted">Works offline. Add it to your home screen or install it from the browser menu to use it like an app.</p>
        <button class="small" data-action="preview-bell">Test the bell</button>
      </div>`;
  },
};

function setupView() {
  const s = state.settings;
  const mins = Math.round(s.durationMs / 60000);
  const warmupMs = s.warmupMs ?? 0;
  const sum = meditationSummary(state);
  return `
    <section class="card">
      <h2>Meditate</h2>
      <h3>Duration</h3>
      <div class="chips">${DURATIONS.map((m) => `<button class="chip" aria-pressed="${m === mins}" data-action="set-duration" data-v="${m}">${m} min</button>`).join('')}</div>
      <label class="field" style="margin-top:12px"><span>Or minutes</span>
        <input type="number" inputmode="numeric" min="1" max="240" step="1" value="${mins}" data-change="custom-duration" aria-label="Custom duration in minutes"></label>
      <h3>Warm-up</h3>
      <label class="field"><span>Seconds before the timer starts (a wood snap marks the end, 0 for none)</span>
        <input type="number" inputmode="numeric" min="0" max="300" step="5" value="${Math.round(warmupMs / 1000)}" data-change="custom-warmup" aria-label="Warm-up in seconds"></label>
      <h3>Sound</h3>
      <div class="chips">${M.AMBIENTS.map((a) => `<button class="chip" aria-pressed="${a === s.ambient}" data-action="set-ambient" data-v="${a}">${AMBIENT_LABELS[a]}</button>`).join('')}</div>
      <h3>Interval bell</h3>
      <div class="chips">${INTERVALS.filter((m) => m === 0 || m * 60000 < s.durationMs).map((m) =>
        `<button class="chip" aria-pressed="${m * 60000 === (s.intervalMs || 0)}" data-action="set-interval" data-v="${m}">${m ? `every ${m} min` : 'Off'}</button>`).join('')}</div>
      <div style="margin-top:22px"><button class="primary big" data-action="start">Begin · ${mins} min</button></div>
    </section>
    <div class="stats">
      <div class="stat"><b>${sum.weekMinutes}</b><span>min in last 7 days</span></div>
      <div class="stat"><b>${sum.weekDays}</b><span>days meditated in last 7 days</span></div>
    </div>`;
}

const RING_C = 2 * Math.PI * 94;

function sessionView() {
  const s = state.session;
  const paused = s.status === 'paused';
  return `
    <section class="session ${paused ? 'paused' : ''}">
      <div class="ring" role="timer" aria-live="off">
        <svg viewBox="0 0 200 200" aria-hidden="true">
          <circle class="track" cx="100" cy="100" r="94"></circle>
          <circle class="progress" id="ring-progress" cx="100" cy="100" r="94" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"></circle>
        </svg>
        <div class="ring-text">
          <div class="time" id="timer-remaining">--:--</div>
          <div class="sub ${paused ? '' : 'breathe'}" id="timer-sub"></div>
        </div>
      </div>
      ${sound.ready ? '' : `<p><button class="small" data-action="enable-sound">🔔 Turn sound on</button></p>`}
      <div class="controls">
        ${paused
          ? '<button class="primary" data-action="resume">Resume</button>'
          : '<button class="primary" data-action="pause">Pause</button>'}
        <button data-action="finish">Finish now</button>
        <button class="ghost" data-action="discard">Discard</button>
      </div>
    </section>`;
}

function updateTimer() {
  const s = state.session;
  if (!s) { document.title = APP_TITLE; return; }
  const warm = M.sessionWarmupRemaining(s);
  const warming = warm > 0;
  // During the warm-up the clock counts down to the start; afterwards it shows the meditation time left.
  const remaining = warming ? warm : M.sessionRemaining(s);
  const total = warming ? s.warmupMs : s.plannedMs;
  document.title = `${fmtClock(remaining)} · ${APP_TITLE}`;
  const $t = document.getElementById('timer-remaining');
  if (!$t) return;
  $t.textContent = fmtClock(remaining);
  const paused = s.status === 'paused';
  const phase = warming ? 'Get settled' : 'Breathe';
  const detail = warming ? `warm-up, then ${fmtDuration(s.plannedMs)}` : fmtDuration(s.plannedMs);
  document.getElementById('timer-sub').textContent = `${paused ? 'Paused' : phase} · ${detail} · ${AMBIENT_LABELS[s.ambient]}`;
  const ring = document.getElementById('ring-progress');
  if (ring) ring.style.strokeDashoffset = String(RING_C * (remaining / total));
  document.querySelector('.session')?.classList.toggle('warmup', warming);
}

// ================================================================ meditation lifecycle

function soundForSession() {
  const s = state.session;
  if (!s || s.status !== 'running' || !sound.ready) return;
  sound.startAmbient(s.ambient);
  sound.scheduleSession(s, M.sessionRawElapsed(s));
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* not allowed: fine */ }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function onSessionEnded(durationMs) {
  sound.stopAmbient(4);
  releaseWakeLock();
  render();
  toast(`Logged ${fmtDuration(durationMs)} of meditation.`);
  openFeelSheet();
}

function lastMeditationEntry() {
  const med = M.meditationType(state);
  return M.sortedEntries(state).find((e) => e.typeId === med?.id);
}

setInterval(() => {
  if (!state.session) return;
  const { state: next, completed } = M.tickSession(state);
  if (completed) {
    state = next;
    save();
    onSessionEnded(lastMeditationEntry()?.durationMs ?? 0);
  } else {
    updateTimer();
  }
}, 500);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session?.status === 'running') requestWakeLock();
});

// Another tab changed the data: pick it up.
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) { state = load(); render(); }
});

// ================================================================ sheets & toasts

let toastTimer = null;
function toast(message, { error = false, actions = [] } = {}) {
  clearTimeout(toastTimer);
  // While a modal sheet is open only the top layer is visible, so show the toast inside it.
  const host = $sheet.open ? $sheet : document.body;
  if ($toast.parentElement !== host) host.appendChild($toast);
  $toast.className = error ? 'error' : '';
  $toast.innerHTML = `<span>${esc(message)}</span>${actions.map((a, i) => `<button data-toast="${i}">${esc(a.label)}</button>`).join('')}`;
  $toast.hidden = false;
  $toast.onclick = (e) => {
    const b = e.target.closest('[data-toast]');
    if (!b) return;
    $toast.hidden = true;
    actions[Number(b.dataset.toast)].fn();
  };
  toastTimer = setTimeout(() => { $toast.hidden = true; }, actions.length ? 6000 : 3500);
}

function openSheet(html, onMount) {
  $sheet.innerHTML = `<div class="sheet-body">${html}</div>`;
  if (!$sheet.open) $sheet.showModal();
  onMount?.($sheet);
}
const closeSheet = () => { if ($sheet.open) $sheet.close(); };
$sheet.addEventListener('click', (e) => { if (e.target === $sheet) closeSheet(); });

function confirmSheet({ title, body, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    openSheet(`<h2 id="sheet-title">${esc(title)}</h2><p class="muted">${esc(body)}</p>
      <div class="sheet-actions"><span class="spacer"></span>
        <button data-r="0">Cancel</button>
        <button class="${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div>`, (el) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; closeSheet(); resolve(v); };
      el.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => finish(b.dataset.r === '1')));
      el.addEventListener('close', () => finish(false), { once: true });
    });
  });
}

function entrySheet({ entry = null, typeId = null } = {}) {
  const isNew = !entry;
  const live = state.types.filter((t) => !t.archived || t.id === entry?.typeId);
  let type = M.getType(state, entry?.typeId ?? typeId) ?? live[0];
  const e = entry ?? { occurredAt: Date.now(), durationMs: null, intensity: null, note: null };
  const typeSelect = isNew ? `<label class="field"><span>What</span><select name="typeId">
      <optgroup label="Activities &amp; happenings">${live.filter((t) => t.kind === 'activity').map((t) => `<option value="${t.id}" ${t.id === type.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>
      <optgroup label="Mental states">${live.filter((t) => t.kind === 'mental_state').map((t) => `<option value="${t.id}" ${t.id === type.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>
    </select></label>` : '';
  const kindFields = (t) => t.kind === 'activity'
    ? `<label class="field"><span>Duration in minutes (optional)</span>
         <input type="number" name="duration" min="1" max="1440" step="1" inputmode="numeric" value="${e.durationMs ? Math.round(e.durationMs / 60000) : ''}"></label>`
    : `<div class="field"><span class="field-label">Intensity (optional)</span><div class="segmented" role="radiogroup" aria-label="Intensity">
         ${['', 1, 2, 3, 4, 5].map((v) => `<label><input type="radio" name="intensity" value="${v}" ${String(e.intensity ?? '') === String(v) ? 'checked' : ''}><span>${v || '–'}</span></label>`).join('')}
       </div></div>`;

  openSheet(`<form>
      <h2 id="sheet-title">${isNew ? 'Log' : `<span class="dot" style="background:${esc(type.color)}"></span>${esc(type.name)}`}</h2>
      ${typeSelect}
      <label class="field"><span>When</span><input type="datetime-local" name="when" required value="${toLocalInput(e.occurredAt)}" max="${toLocalInput(Date.now() + 60000)}"></label>
      <div id="kind-fields">${kindFields(type)}</div>
      <label class="field"><span>Note (optional)</span><textarea name="note" maxlength="${M.CONFIG.maxNoteLength}">${esc(e.note ?? '')}</textarea></label>
      <div class="sheet-actions">
        ${isNew ? '' : '<button type="button" class="danger" data-act="delete">Delete</button>'}
        <span class="spacer"></span>
        <button type="button" data-act="cancel">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div></form>`, (el) => {
    const form = el.querySelector('form');
    form.typeId?.addEventListener('change', () => {
      type = M.getType(state, form.typeId.value);
      el.querySelector('#kind-fields').innerHTML = kindFields(type);
    });
    el.querySelector('[data-act=cancel]').addEventListener('click', closeSheet);
    el.querySelector('[data-act=delete]')?.addEventListener('click', () => {
      if (apply((s) => M.deleteEntry(s, entry.id))) {
        closeSheet();
        const snapshot = entry;
        toast('Entry deleted.', { actions: [{ label: 'Undo', fn: () => apply((s) => ({ ...s, entries: [...s.entries, snapshot] })) }] });
      }
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const occurredAt = new Date(form.when.value).getTime();
      const dur = form.duration?.value ? Number(form.duration.value) * 60000 : null;
      const intensityRaw = form.querySelector('input[name=intensity]:checked')?.value;
      const fields = {
        occurredAt,
        durationMs: type.kind === 'activity' ? dur : null,
        intensity: type.kind === 'mental_state' && intensityRaw ? Number(intensityRaw) : null,
        note: form.note.value,
      };
      const ok = isNew
        ? apply((s) => M.logEntry(s, { typeId: type.id, ...fields }))
        : apply((s) => M.editEntry(s, entry.id, fields));
      if (ok) { closeSheet(); toast(isNew ? `Logged ${type.name}.` : 'Saved.'); }
    });
  });
}

function typeSheet(type = null) {
  const isNew = !type;
  const t = type ?? { name: '', kind: 'activity', polarity: 'bad', color: PALETTE[Math.floor(Math.random() * PALETTE.length)] };
  const used = type ? M.entriesOfType(state, type.id).length : 0;
  const kindLocked = !!type && (type.isMeditation || used > 0);
  const swatches = [...new Set([...PALETTE, t.color])].map((c) =>
    `<label><input type="radio" name="color" value="${c}" ${c === t.color ? 'checked' : ''} aria-label="Colour ${c}"><span style="background:${c}"></span></label>`).join('');
  openSheet(`<form>
      <h2 id="sheet-title">${isNew ? 'New type' : 'Edit type'}</h2>
      <label class="field"><span>Name</span><input name="name" required maxlength="${M.CONFIG.maxTypeNameLength}" value="${esc(t.name)}" placeholder="e.g. Went for a walk, Felt anxious" autocomplete="off"></label>
      <div class="field"><span class="field-label">What is it?</span><div class="segmented">
        <label><input type="radio" name="kind" value="activity" ${t.kind === 'activity' ? 'checked' : ''} ${kindLocked ? 'disabled' : ''}><span>Activity / happening</span></label>
        <label><input type="radio" name="kind" value="mental_state" ${t.kind === 'mental_state' ? 'checked' : ''} ${kindLocked ? 'disabled' : ''}><span>Mental state</span></label>
      </div>${kindLocked ? `<p class="muted small" style="margin-top:6px">${type.isMeditation ? 'Meditation is always an activity.' : 'The kind is fixed once something is logged against it.'}</p>` : ''}</div>
      <div class="field" id="polarity-field"><span class="field-label">This state suggests…</span><div class="segmented">
        <label><input type="radio" name="polarity" value="good" ${t.polarity === 'good' ? 'checked' : ''}><span>▲ Good mental health</span></label>
        <label><input type="radio" name="polarity" value="bad" ${t.polarity !== 'good' ? 'checked' : ''}><span>▼ Bad mental health</span></label>
      </div></div>
      <div class="field"><span class="field-label">Colour</span><div class="swatches">${swatches}</div></div>
      <div class="sheet-actions">
        ${!isNew && !type.isMeditation ? `<button type="button" class="danger" data-act="delete">Delete</button>` : ''}
        <span class="spacer"></span>
        <button type="button" data-act="cancel">Cancel</button>
        <button type="submit" class="primary">${isNew ? 'Create' : 'Save'}</button>
      </div></form>`, (el) => {
    const form = el.querySelector('form');
    const kindNow = () => form.querySelector('input[name=kind]:checked')?.value ?? t.kind;
    const syncPolarity = () => { el.querySelector('#polarity-field').hidden = kindNow() !== 'mental_state'; };
    form.querySelectorAll('input[name=kind]').forEach((r) => r.addEventListener('change', syncPolarity));
    syncPolarity();
    el.querySelector('[data-act=cancel]').addEventListener('click', closeSheet);
    el.querySelector('[data-act=delete]')?.addEventListener('click', async () => {
      if (used > 0) {
        toast(`"${type.name}" has ${used} entr${used === 1 ? 'y' : 'ies'}. Archive it instead to keep your history.`, { error: true });
        return;
      }
      if (apply((s) => M.deleteType(s, type.id))) { closeSheet(); toast(`Deleted ${type.name}.`); }
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const fields = {
        name: form.name.value,
        kind: kindNow(),
        polarity: form.querySelector('input[name=polarity]:checked')?.value,
        color: form.querySelector('input[name=color]:checked')?.value,
      };
      const ok = isNew ? apply((s) => M.defineType(s, fields)) : apply((s) => M.editType(s, type.id, fields));
      if (ok) { closeSheet(); toast(isNew ? `Created ${M.normalizeName(fields.name)}.` : 'Saved.'); }
    });
    if (isNew) form.name.focus();
  });
}

function openFeelSheet() {
  const states = state.types.filter((t) => t.kind === 'mental_state' && !t.archived);
  if (!states.length) return;
  openSheet(`<h2 id="sheet-title">How do you feel?</h2>
    <p class="muted small">Tap anything that fits right now. It gets logged with the current time.</p>
    <div class="feel-grid">${states.map((t) => `<button class="type-btn" style="--c:${esc(t.color)}" data-feel="${t.id}"><span class="name">${esc(t.name)}</span></button>`).join('')}</div>
    <div class="sheet-actions"><span class="spacer"></span><button class="primary" data-act="done">Done</button></div>`, (el) => {
    el.querySelectorAll('[data-feel]').forEach((b) => b.addEventListener('click', () => {
      if (b.getAttribute('aria-pressed') === 'true') return;
      if (apply((s) => M.logEntry(s, { typeId: b.dataset.feel, occurredAt: Date.now() }))) {
        b.setAttribute('aria-pressed', 'true');
        b.querySelector('.name').textContent = `✓ ${b.querySelector('.name').textContent}`;
      }
    }));
    el.querySelector('[data-act=done]').addEventListener('click', closeSheet);
  });
}

// ================================================================ actions

const ACTIONS = {
  'set-duration': (el) => setSetting({ durationMs: Number(el.dataset.v) * 60000 }),
  'set-ambient': (el) => setSetting({ ambient: el.dataset.v }),
  'set-interval': (el) => setSetting({ intervalMs: Number(el.dataset.v) * 60000 }),

  async start() {
    const { durationMs, ambient, intervalMs, warmupMs } = state.settings;
    const unlocked = sound.unlock();
    if (!apply((s) => M.startSession(s, { plannedMs: durationMs, ambient, intervalMs: intervalMs < durationMs ? intervalMs : 0, warmupMs: warmupMs ?? 0 }))) return;
    await unlocked;
    // With a warm-up the wood snap marks the start of meditation; without one, the bowl does.
    if (!warmupMs) sound.bell('start');
    soundForSession();
    requestWakeLock();
    render();
  },
  pause() {
    if (!apply((s) => M.pauseSession(s))) return;
    sound.cancelBells();
    sound.stopAmbient(1.5);
  },
  async resume() {
    const unlocked = sound.unlock();
    if (!apply((s) => M.resumeSession(s))) return;
    await unlocked;
    soundForSession();
    requestWakeLock();
    render();
  },
  async finish() {
    const s = state.session;
    if (!s) return;
    if (M.sessionElapsed(s) < M.CONFIG.minMeditationMs) {
      if (await confirmSheet({ title: 'Discard this session?', body: 'Less than a minute has passed, so there is nothing to log.', ok: 'Discard', danger: true })) {
        apply((st) => M.discardSession(st));
        sound.stopAll();
        releaseWakeLock();
      }
      return;
    }
    if (!apply((st) => M.finishSessionEarly(st))) return;
    sound.cancelBells();
    sound.bell('end');
    onSessionEnded(lastMeditationEntry()?.durationMs ?? 0);
  },
  async discard() {
    if (!await confirmSheet({ title: 'Discard this session?', body: 'Nothing will be logged.', ok: 'Discard', danger: true })) return;
    if (apply((s) => M.discardSession(s))) { sound.stopAll(); releaseWakeLock(); }
  },
  async 'enable-sound'() {
    await sound.unlock();
    soundForSession();
    render();
  },
  async 'preview-bell'() {
    await sound.unlock();
    sound.bell('start');
  },

  'quick-log': (el) => {
    const type = M.getType(state, el.dataset.id);
    if (!apply((s) => M.logEntry(s, { typeId: el.dataset.id, occurredAt: Date.now() }))) return;
    const entry = M.sortedEntries(state).find((e) => e.typeId === type.id);
    toast(`Logged ${type.name}.`, {
      actions: [
        { label: 'Details', fn: () => entrySheet({ entry: state.entries.find((e) => e.id === entry.id) }) },
        { label: 'Undo', fn: () => apply((s) => M.deleteEntry(s, entry.id)) },
      ],
    });
  },
  'log-past': () => entrySheet(),
  'edit-entry': (el) => {
    const entry = state.entries.find((e) => e.id === el.dataset.id);
    if (entry) entrySheet({ entry });
  },

  'new-type': () => typeSheet(),
  'edit-type': (el) => typeSheet(M.getType(state, el.dataset.id)),
  'archive-type': (el) => {
    const t = M.getType(state, el.dataset.id);
    if (apply((s) => M.archiveType(s, t.id))) toast(`Archived ${t.name}. Its history is kept.`);
  },
  'restore-type': (el) => apply((s) => M.restoreType(s, el.dataset.id)),

  lag: (el) => { insightLag = Number(el.dataset.v); render(); },

  export() {
    const blob = new Blob([M.exportState(state)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pawsterior-${toLocalInput(Date.now()).slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  import() {
    const input = document.getElementById('import-file');
    input.value = '';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      let next;
      try { next = M.importState(await file.text()); } catch (e) {
        toast(e instanceof M.ValidationError ? e.message : 'Could not read that file.', { error: true });
        return;
      }
      const ok = await confirmSheet({
        title: 'Replace your data?',
        body: `This replaces everything on this device${sync.status().signedIn ? ' and in your account' : ''} with ${next.types.length} types and ${next.entries.length} entries from the backup.`,
        ok: 'Replace', danger: true,
      });
      if (ok) { sound.stopAll(); state = next; save(); render(); toast('Backup imported.'); }
    };
    input.click();
  },
  async erase() {
    if (!await confirmSheet({ title: 'Erase everything?', body: `All types and entries on this device${sync.status().signedIn ? ' and in your account (so on your other devices too)' : ''} will be deleted. This cannot be undone. Export a backup first if you might want them.`, ok: 'Erase', danger: true })) return;
    sound.stopAll();
    releaseWakeLock();
    state = M.createInitialState();
    save();
    render();
    toast('Everything erased.');
  },
  async 'reset-test-data'() {
    if (!await confirmSheet({ title: 'Regenerate test data?', body: 'Replaces everything in the TEST build with new random sample entries. Your real data is not affected.', ok: 'Regenerate' })) return;
    sound.stopAll();
    releaseWakeLock();
    state = demoState({ seed: Math.floor(Math.random() * 2 ** 32) });
    save();
    render();
    toast('Sample data regenerated.');
  },
  'sync-now': () => sync.syncNow(),
  async 'sign-out'() {
    if (!await confirmSheet({ title: 'Sign out?', body: 'Your data stays in your account. It is removed from this device, and you will need to sign in to use the app again.', ok: 'Sign out' })) return;
    await sync.syncNow(); // get any last changes safely into the cloud first
    if (sync.status().dirty && !await confirmSheet({ title: 'Some changes have not synced', body: 'They could not be uploaded just now, and would be lost. Sign out anyway?', ok: 'Sign out anyway', danger: true })) return;
    await leaveDevice(() => sync.logout());
  },
  async 'delete-account'() {
    if (!await confirmSheet({ title: 'Delete your account?', body: 'This permanently deletes your account and its cloud copy (real and test), and removes the data from this device. Export a backup first if you want to keep it.', ok: 'Delete account', danger: true })) return;
    try { await leaveDevice(() => sync.deleteAccount()); } catch (e) { toast(e.message, { error: true }); }
  },
  async install() {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    document.getElementById('install-btn').hidden = true;
  },
};

function setSetting(patch) {
  state = { ...state, settings: { ...state.settings, ...patch } };
  // Drop an interval bell that no longer fits inside the session.
  if (state.settings.intervalMs >= state.settings.durationMs) state.settings.intervalMs = 0;
  save();
  render();
}

const CHANGES = {
  'history-filter': (el) => { historyFilter = el.value; render(); },
  'custom-warmup': (el) => {
    const sec = Math.round(Number(el.value));
    if (el.value === '' || !Number.isFinite(sec) || sec < 0 || sec > 300) { toast('Choose between 0 and 300 seconds.', { error: true }); render(); return; }
    setSetting({ warmupMs: sec * 1000 });
  },
  'custom-duration': (el) => {
    const m = Math.round(Number(el.value));
    if (!Number.isFinite(m) || m < 1 || m > 240) { toast('Choose between 1 and 240 minutes.', { error: true }); render(); return; }
    setSetting({ durationMs: m * 60000 });
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  e.preventDefault();
  ACTIONS[el.dataset.action]?.(el, e);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el) CHANGES[el.dataset.change]?.(el, e);
});

// ================================================================ PWA

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  document.getElementById('install-btn').hidden = false;
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
navigator.storage?.persist?.().catch(() => {});

// ================================================================ account & sync

function ago(ts) {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

/** Run a sign-out style step, then clear this device's copy of the data. */
async function leaveDevice(step) {
  await step();
  sound.stopAll();
  releaseWakeLock();
  state = M.createInitialState();
  persist();
  render();
}

function accountCard() {
  const st = sync.status();
  const line = {
    syncing: 'Syncing…',
    offline: 'Offline. Changes will sync when you are back online.',
    error: `Sync problem: ${st.error ?? 'unknown error'}`,
    conflict: 'The cloud copy and this device both changed.',
    idle: st.dirty ? 'Waiting to sync…' : st.lastSyncedAt ? `Synced ${ago(st.lastSyncedAt)}` : 'Not synced yet',
  }[st.phase];
  const bad = st.phase === 'error' || st.phase === 'conflict';
  return `<div class="card">
    <p>Signed in as <b>${esc(st.email)}</b></p>
    <p class="small ${bad ? '' : 'muted'}" ${bad ? 'style="color:var(--bad)"' : ''}>${esc(line)}</p>
    <div class="row wrap">
      <button data-action="sync-now">${st.phase === 'conflict' ? 'Resolve…' : 'Sync now'}</button>
      <button data-action="sign-out">Sign out</button>
      <span class="spacer"></span>
      <button class="danger" data-action="delete-account">Delete account</button>
    </div></div>`;
}

/** Shown instead of the app until you are signed in. */
function showGate() {
  const st = sync.status();
  document.title = APP_TITLE;
  $view.innerHTML = `<section class="card gate">
    <h2>Sign in to Pawsterior</h2>
    <p class="muted small">Your data is kept in your account, so it is safe and available on all your devices.</p>
    ${st.error ? `<p class="small" style="color:var(--bad)">${esc(st.error)}</p>` : ''}
    <form>
      <label class="field"><span>Email</span><input name="email" type="email" required autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false"></label>
      <label class="field"><span>Password (at least 10 characters to create an account)</span><input name="password" type="password" required maxlength="200" autocomplete="current-password"></label>
      <p class="small" id="auth-error" role="alert" style="color:var(--bad)" hidden></p>
      <div class="row wrap">
        <button type="submit" class="primary">Sign in</button>
        <button type="button" data-act="register">Create account</button>
      </div>
    </form></section>`;
  const form = $view.querySelector('form');
  const $err = $view.querySelector('#auth-error');
  const buttons = form.querySelectorAll('button');
  const attempt = async (kind) => {
    $err.hidden = true;
    if (!form.reportValidity()) return;
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await sync[kind](form.email.value, form.password.value);
      toast(kind === 'register' ? 'Account created.' : 'Signed in.');
    } catch (e) {
      $err.textContent = e.message;
      $err.hidden = false;
      buttons.forEach((b) => { b.disabled = false; });
    }
  };
  form.querySelector('[data-act=register]').addEventListener('click', () => attempt('register'));
  form.addEventListener('submit', (ev) => { ev.preventDefault(); attempt('login'); });
  form.email.focus({ preventScroll: true });
}

/** Your email and a sync light in the top corner. */
function updateHeader() {
  const st = sync.status();
  const $who = document.getElementById('whoami');
  $who.hidden = !st.signedIn;
  if (!st.signedIn) return;
  $who.querySelector('.who').textContent = st.email;
  const phase = st.phase === 'idle' && st.dirty ? 'pending' : st.phase;
  $who.dataset.phase = phase;
  $who.title = `Signed in as ${st.email}. ${{ idle: 'Synced', pending: 'Waiting to sync', syncing: 'Syncing', offline: 'Offline', error: 'Sync problem', conflict: 'Needs your attention' }[phase]}.`;
}

/** Both the cloud and this device changed. Returns 'cloud', 'device' or null (decide later). */
function onConflict({ local, remote }) {
  // Never interrupt a meditation or another open sheet; the Setup page offers "Resolve…".
  if (state.session || $sheet.open) return Promise.resolve(null);
  const count = (s) => `${s.entries.length} entries, ${s.types.length} types`;
  return new Promise((resolve) => {
    openSheet(`<h2 id="sheet-title">Which copy do you want?</h2>
      <p class="muted">This device and your account have different data. Pick one; the other is replaced. Export a backup first if you are unsure.</p>
      <div class="card small"><b>Cloud copy</b><br>${esc(count(remote))}</div>
      <div class="card small"><b>This device</b><br>${esc(count(local))}</div>
      <div class="sheet-actions">
        <button data-r="later">Decide later</button><span class="spacer"></span>
        <button data-r="device">Keep this device</button>
        <button class="primary" data-r="cloud">Use cloud copy</button></div>`, (el) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; closeSheet(); resolve(v); };
      el.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => finish(b.dataset.r === 'later' ? null : b.dataset.r)));
      el.addEventListener('close', () => finish(null), { once: true });
    });
  });
}

/** Replace local data with the cloud copy, keeping this device's running timer. */
function applyRemote(remote) {
  if (remote?.version !== M.SCHEMA_VERSION || !Array.isArray(remote.types) || !Array.isArray(remote.entries)) {
    throw new Error('The cloud data is from a newer version of the app. Reload to update.');
  }
  state = { ...remote, session: state.session, settings: { ...M.createInitialState().settings, ...remote.settings } };
  persist();
  render();
}

let wasSignedIn = false;
sync = createSync({
  apiUrl: API_URL,
  profile: SYNC_PROFILE,
  storage: localStorage,
  authKey: AUTH_KEY,
  metaKey: SYNC_META_KEY,
  getState: () => state,
  applyRemote,
  // Nothing logged and no custom types: safe to replace without asking.
  isPristine: (s) => s.entries.length === 0 && s.types.length <= M.createInitialState().types.length,
  onConflict,
  onChange: () => {
    const signedIn = sync.status().signedIn;
    updateHeader();
    // Signing in or out swaps the whole screen; otherwise only refresh the Setup card.
    if (signedIn !== wasSignedIn) { wasSignedIn = signedIn; render(); }
    else if (signedIn && currentRoute() === 'settings' && !$sheet.open) render();
  },
});
wasSignedIn = sync.status().signedIn;
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync.syncNow(); });
window.addEventListener('online', () => sync.syncNow());

// ================================================================ boot

// A session left running across a reload completes immediately if its time is up.
if (state.session) {
  const { state: next, completed } = M.tickSession(state);
  if (completed) { state = next; save(); toast('Your last session finished while the app was closed. It has been logged.'); }
}
if (IS_TEST) {
  document.body.classList.add('is-test');
  document.querySelector('.brand span').insertAdjacentHTML('afterend', '<span class="test-badge">TEST</span>');
}
render();
sync.syncNow();
