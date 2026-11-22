// All sounds are synthesised with Web Audio: no audio files to download or cache.
// Bells are scheduled on the audio clock so they ring on time even if the page
// is in the background and timers are throttled.

// A simple gong: low fundamental, a slightly detuned twin for slow beating, soft upper partials.
const GONG = [[1, 1], [1.006, 0.7], [2.0, 0.3], [2.98, 0.15], [4.1, 0.06]];

const BELLS = {
  start: { freq: 196, gain: 0.45, decay: 7 },
  interval: { freq: 392, gain: 0.18, decay: 4 },
  end: { freq: 98, gain: 0.6, decay: 16, attack: 0.25, partials: GONG },
};

// Inharmonic partials loosely modelled on a singing bowl.
const PARTIALS = [[1, 1], [2.02, 0.45], [2.76, 0.3], [5.4, 0.12], [8.93, 0.05]];

export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.ambient = null;
    this.scheduled = new Set();
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Must be called from a user gesture the first time. */
  async unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* ignore */ }
    }
    return this.ready;
  }

  /** Ring a bell `delaySec` seconds from now. Returns a handle for cancellation. */
  bell(kind = 'start', delaySec = 0) {
    if (!this.ctx) return null;
    const { freq, gain, decay, attack = 0.015, partials = PARTIALS } = BELLS[kind] ?? BELLS.start;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + Math.max(0, delaySec) + 0.02;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    out.connect(this.master);
    const oscs = partials.map(([mult, amp], i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      const g = ctx.createGain();
      // Higher partials die away faster.
      g.gain.setValueAtTime(amp, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay / (1 + i * 0.8));
      o.connect(g).connect(out);
      o.start(t0);
      o.stop(t0 + decay + 0.1);
      return o;
    });
    const handle = { oscs, out };
    this.scheduled.add(handle);
    oscs[0].onended = () => { this.scheduled.delete(handle); out.disconnect(); };
    return handle;
  }

  /** A short dry wood "tok", `delaySec` from now. Marks the end of the warm-up. */
  snap(delaySec = 0) {
    if (!this.ctx) return null;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + Math.max(0, delaySec) + 0.02;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(0.9, t0 + 0.003);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    out.connect(this.master);
    // Body: a quickly falling sine, like a knock on a hollow block.
    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(950, t0);
    body.frequency.exponentialRampToValueAtTime(380, t0 + 0.07);
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.8;
    body.connect(bodyGain).connect(out);
    // Click: a few ms of band-passed noise for the wooden attack.
    const len = Math.floor(ctx.sampleRate * 0.03);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const click = ctx.createBufferSource();
    click.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 1.2;
    click.connect(bp).connect(out);
    body.start(t0);
    body.stop(t0 + 0.2);
    click.start(t0);
    const handle = { oscs: [body, click], out };
    this.scheduled.add(handle);
    body.onended = () => { this.scheduled.delete(handle); out.disconnect(); };
    return handle;
  }

  cancelBells() {
    for (const h of this.scheduled) {
      for (const o of h.oscs) { try { o.stop(); } catch { /* already stopped */ } }
      h.out.disconnect();
    }
    this.scheduled.clear();
  }

  /**
   * Schedule the warm-up snap, interval bells and end bells for a session.
   * `rawElapsedMs` is the time since the start excluding pauses, warm-up included.
   */
  scheduleSession({ plannedMs, intervalMs, warmupMs = 0 }, rawElapsedMs) {
    this.cancelBells();
    if (!this.ctx) return;
    if (warmupMs > rawElapsedMs + 50) this.snap((warmupMs - rawElapsedMs) / 1000);
    if (intervalMs > 0) {
      for (let t = intervalMs; t < plannedMs; t += intervalMs) {
        const at = warmupMs + t;
        if (at > rawElapsedMs + 250) this.bell('interval', (at - rawElapsedMs) / 1000);
      }
    }
    const remaining = warmupMs + plannedMs - rawElapsedMs;
    if (remaining > 0) {
      this.bell('end', remaining / 1000);
    }
  }

  startAmbient(kind) {
    this.stopAmbient(0.3);
    if (!this.ctx || !kind || kind === 'silence') return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    const noise = noiseBuffer(ctx, kind === 'rain' ? 'pink' : 'brown', 12);
    src.buffer = noise.buffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = noise.loopEnd;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    let tail = src;
    const extra = [];

    if (kind === 'rain') {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 500;
      tail.connect(hp);
      tail = hp;
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 3);
    } else if (kind === 'ocean') {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700;
      tail.connect(lp);
      tail = lp;
      // Slow swell: an LFO modulating a gain stage, like waves.
      const swell = ctx.createGain();
      swell.gain.value = 0.55;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.09;
      const depth = ctx.createGain();
      depth.gain.value = 0.45;
      lfo.connect(depth).connect(swell.gain);
      lfo.start();
      extra.push(lfo);
      tail.connect(swell);
      tail = swell;
      gain.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 3);
    } else {
      gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 3);
    }
    tail.connect(gain).connect(this.master);
    src.start();
    this.ambient = { src, gain, extra };
  }

  stopAmbient(fadeSec = 2) {
    const a = this.ambient;
    if (!a || !this.ctx) return;
    this.ambient = null;
    const t = this.ctx.currentTime;
    a.gain.gain.cancelScheduledValues(t);
    a.gain.gain.setValueAtTime(Math.max(a.gain.gain.value, 0.0001), t);
    a.gain.gain.exponentialRampToValueAtTime(0.0001, t + fadeSec);
    const stopAt = t + fadeSec + 0.05;
    a.src.stop(stopAt);
    a.extra.forEach((n) => n.stop(stopAt));
    a.src.onended = () => a.gain.disconnect();
  }

  stopAll() {
    this.cancelBells();
    this.stopAmbient();
  }
}

const bufferCache = new Map();

function noiseBuffer(ctx, color, seconds) {
  const key = `${color}:${ctx.sampleRate}`;
  if (bufferCache.has(key)) return bufferCache.get(key);
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const fade = Math.floor(ctx.sampleRate * 0.5);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    if (color === 'brown') {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      }
    } else {
      // Paul Kellet's pink noise approximation.
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    }
    // Crossfade the loop seam: the loop ends `fade` samples early, and the head
    // of the buffer blends in what would have followed, so it doesn't click.
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      data[i] = data[i] * k + data[len - fade + i] * (1 - k);
    }
  }
  const result = { buffer: buf, loopEnd: (len - fade) / ctx.sampleRate };
  bufferCache.set(key, result);
  return result;
}
