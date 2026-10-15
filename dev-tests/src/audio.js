// audio.js — WebAudio, no asset downloads. Built to sit under the game
// rather than on top of it: a geared engine built from pre-rendered loops
// of individual combustion pulses (pitch-shifted and cross-faded by rpm
// band like a sample set), low-passed and soft-clipped, intake hiss under
// throttle, speed-scaled wind, and tyre squeal that only speaks up during
// real slides. One-shots are soft
// sine/triangle tones and filtered noise: countdown, lap chimes, boost
// whoosh, pad sweep, wall thud, landing thump, upshift blip.

const GEARS = [0, 8, 15, 23, 31, 40, 52]; // m/s shift points
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Render a seamless loop of combustion pulses at a reference firing rate.
// Each pulse: a short sine thump that chirps down onto fRef, plus a noise
// crack; timing jitters ~8% and level ~40% so the texture never sounds
// machine-perfect. Written modulo the buffer length, so it loops cleanly.
export function renderEngineLoop(ctx, { fRef, thump, rasp }, seconds = 2) {
  const sr = ctx.sampleRate, len = Math.round(seconds * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const pulses = Math.round(seconds * fRef);
  const period = len / pulses;
  const decay = period * 1.3;
  const n = Math.round(decay * 3);
  for (let k = 0; k < pulses; k++) {
    const start = k * period + (Math.random() - 0.5) * period * 0.16;
    const amp = 0.8 + Math.random() * 0.4;
    const ph0 = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const tt = i / sr;
      const env = Math.exp(-i / decay);
      const fr = fRef * (1 + 1.4 * Math.exp(-i / (decay * 0.25)));
      const s = Math.sin(ph0 + 2 * Math.PI * fr * tt) * thump;
      const nz = (Math.random() * 2 - 1) * rasp * Math.exp(-i / (decay * 0.3));
      const idx = ((Math.round(start) + i) % len + len) % len;
      d[idx] += amp * env * (s + nz);
    }
  }
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  const g = peak > 0 ? 0.8 / peak : 1;
  for (let i = 0; i < len; i++) d[i] *= g;
  return buf;
}

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.gear = 0;
    this.rpm = 0.2;
    this.prev = { boostFlash: 0, padBoost: 0, grounded: true, airTime: 0, wallHit: false, drifting: false };
    this.wallCooldown = 0;
    this.squealLvl = 0;
  }

  // must be called from a user gesture (keydown / pointerdown)
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = 0.42;
    // gentle bus compressor: glues layers, stops one-shots from spiking
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 20;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.15;
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    // shared looped noise buffer (wind, squeal, exhaust, one-shot bursts)
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // --- engine: sampled-style. Three looped buffers of individual
    // combustion pulses (low thump + noise crack, jittered in time and
    // level) are rendered once at init, then pitch-shifted with
    // playbackRate and cross-faded by rpm band, the way a real engine
    // sample set works. Irregular pulses read as an engine, not a buzzer.
    this.bands = [
      { fRef: 36,  thump: 1.0, rasp: 0.30, lo: -1,  mid: 0.0,  hi: 0.45 },
      { fRef: 85,  thump: 0.8, rasp: 0.55, lo: 0.1, mid: 0.5,  hi: 0.9  },
      { fRef: 170, thump: 0.6, rasp: 0.85, lo: 0.55, mid: 1.0, hi: 2    },
    ];
    this.engineSum = ctx.createGain();
    this.engineSum.gain.value = 1;
    for (const b of this.bands) {
      b.buffer = renderEngineLoop(ctx, b);
      b.src = ctx.createBufferSource();
      b.src.buffer = b.buffer;
      b.src.loop = true;
      b.gain = ctx.createGain();
      b.gain.gain.value = 0;
      b.src.connect(b.gain);
      b.gain.connect(this.engineSum);
      b.src.start();
    }
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 600;
    this.engineFilter.Q.value = 0.7;
    this.shaper = ctx.createWaveShaper();
    const curve = new Float32Array(512);
    for (let i = 0; i < 512; i++) { const x = (i / 255.5) - 1; curve[i] = Math.tanh(x * 1.3); }
    this.shaper.curve = curve;
    this.shaper.oversample = "2x";
    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 0.0001;
    this.engineSum.connect(this.engineFilter);
    this.engineFilter.connect(this.shaper);
    this.shaper.connect(this.engineBus);
    this.engineBus.connect(this.master);
    // intake hiss under throttle
    this.intake = this.loopNoise();
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = "lowpass";
    this.intakeFilter.frequency.value = 700;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0.0001;
    this.intake.connect(this.intakeFilter);
    this.intakeFilter.connect(this.intakeGain);
    this.intakeGain.connect(this.master);

    // --- wind: lowpassed noise, swells with speed ------------------------
    this.wind = this.loopNoise();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "lowpass";
    this.windFilter.frequency.value = 350;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.0001;
    this.wind.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);

    // --- tyre squeal: two softened bandpasses, then a lowpass to tame hiss
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0.0001;
    this.squealLP = ctx.createBiquadFilter();
    this.squealLP.type = "lowpass";
    this.squealLP.frequency.value = 2200;
    this.squealFilters = [];
    for (const [f, q] of [[800, 5], [1300, 7]]) {
      const src = this.loopNoise();
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = f;
      bp.Q.value = q;
      src.connect(bp);
      bp.connect(this.squealLP);
      this.squealFilters.push(bp);
    }
    this.squealLP.connect(this.squealGain);
    this.squealGain.connect(this.master);
  }

  loopNoise() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.start();
    return src;
  }

  // ---- one-shot building blocks -------------------------------------------
  tone({ f0, f1 = f0, type = "sine", dur = 0.1, vol = 0.1, at = 0, attack = 0.008 }) {
    const ctx = this.ctx, t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  burst({ type = "lowpass", f0 = 800, f1 = f0, q = 1, dur = 0.2, vol = 0.15, at = 0, attack = 0.006 }) {
    const ctx = this.ctx, t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt);
    flt.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  // named game events (main.js calls these; update() fires the physics ones)
  sfx(name, arg = 1) {
    if (!this.ctx) return;
    switch (name) {
      case "tick":
        this.tone({ f0: 660, type: "sine", dur: 0.14, vol: 0.09 });
        break;
      case "go":
        this.tone({ f0: 990, type: "sine", dur: 0.5, vol: 0.1 });
        this.tone({ f0: 1320, type: "sine", dur: 0.45, vol: 0.04, at: 0.02 });
        break;
      case "lap":
        this.tone({ f0: 660, type: "triangle", dur: 0.14, vol: 0.08 });
        this.tone({ f0: 990, type: "triangle", dur: 0.26, vol: 0.08, at: 0.12 });
        break;
      case "best":
        [660, 880, 1100, 1320].forEach((f, i) => this.tone({ f0: f, type: "triangle", dur: i === 3 ? 0.45 : 0.12, vol: 0.08, at: i * 0.1 }));
        break;
      case "finish":
        [[523, 0], [659, 0], [784, 0], [1047, 0.18], [1319, 0.36]].forEach(([f, at]) =>
          this.tone({ f0: f, type: "triangle", dur: 1.0, vol: 0.055, at, attack: 0.03 }));
        break;
      case "boost": // drift-exit / trick boost: airy whoosh
        this.burst({ type: "bandpass", f0: 300, f1: 1800, q: 1.2, dur: 0.6, vol: 0.18 * arg, attack: 0.05 });
        this.tone({ f0: 180, f1: 520, type: "sine", dur: 0.4, vol: 0.05 * arg, attack: 0.03 });
        break;
      case "pad": // boost panel: short rising sweep
        this.tone({ f0: 260, f1: 900, type: "triangle", dur: 0.3, vol: 0.06 });
        this.burst({ type: "highpass", f0: 1200, dur: 0.25, vol: 0.06 });
        break;
      case "wall": // thud + scrape
        this.tone({ f0: 80, f1: 36, type: "sine", dur: 0.22, vol: 0.3 * arg, attack: 0.003 });
        this.burst({ type: "lowpass", f0: 300, f1: 110, dur: 0.2, vol: 0.22 * arg });
        break;
      case "land": // suspension thump
        this.tone({ f0: 64, f1: 38, type: "sine", dur: 0.18, vol: 0.25 * arg, attack: 0.003 });
        this.burst({ type: "lowpass", f0: 420, f1: 140, dur: 0.14, vol: 0.12 * arg });
        break;
      case "shift": // upshift: brief exhaust blip
        this.burst({ type: "bandpass", f0: 200, q: 1.5, dur: 0.06, vol: 0.09 });
        break;
      case "contact": // car-to-car bump
        this.burst({ type: "lowpass", f0: 600, f1: 180, dur: 0.12, vol: 0.16 * arg });
        break;
      case "quake": // hazard event: long low rumble, ~4 s
        this.burst({ type: "lowpass", f0: 220, f1: 70, q: 0.8, dur: 4.2, vol: 0.3 * arg, attack: 0.6 });
        this.burst({ type: "lowpass", f0: 120, f1: 60, q: 1.2, dur: 3.6, vol: 0.18 * arg, attack: 0.9, at: 0.3 });
        this.tone({ f0: 35, f1: 31, type: "sine", dur: 4.0, vol: 0.28 * arg, attack: 0.5 });
        this.tone({ f0: 52, f1: 40, type: "triangle", dur: 2.5, vol: 0.06 * arg, attack: 0.3, at: 0.4 });
        break;
      case "rumble-warn": // hazard warning: shorter, quieter distant rumble
        this.burst({ type: "lowpass", f0: 170, f1: 90, q: 0.8, dur: 1.8, vol: 0.12 * arg, attack: 0.4 });
        this.tone({ f0: 38, f1: 34, type: "sine", dur: 1.6, vol: 0.12 * arg, attack: 0.35 });
        break;
    }
  }

  // car: the player's Car; input: this frame's input vector (optional)
  update(dt, car, input = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const spd = car.speed;
    const throttle = input ? (input.throttle || 0) : 0;

    // --- engine: gear from speed, rpm rises through the gear and drops at
    // each shift. Idle hangs around 0.15; redline is 1.
    let gear = 0;
    while (gear < GEARS.length - 2 && spd >= GEARS[gear + 1]) gear++;
    const span = GEARS[gear + 1] - GEARS[gear];
    let rpmT = 0.28 + 0.72 * clamp((spd - GEARS[gear]) / span, 0, 1);
    if (spd < 1.5) rpmT = 0.15 + throttle * 0.3; // idle / revving at the line
    if (car.drifting && throttle) rpmT = Math.min(1, rpmT + 0.1); // wheelspin flare
    if (!car.grounded) rpmT = Math.min(1, rpmT + 0.15 * throttle); // free-revving in the air
    if (gear !== this.gear) {
      if (gear > this.gear && spd > 6) this.sfx("shift");
      this.gear = gear;
    }
    this.rpm += (rpmT - this.rpm) * Math.min(1, (rpmT > this.rpm ? 6 : 10) * dt);
    const f = 30 + this.rpm * 170; // firing rate: ~900 rpm idle .. ~6000 rpm (4-cyl)
    for (const b of this.bands) {
      // triangular cross-fade window per band over rpm
      let w;
      if (this.rpm <= b.mid) w = b.lo < -0.5 ? 1 : clamp((this.rpm - b.lo) / Math.max(b.mid - b.lo, 1e-3), 0, 1);
      else w = b.hi > 1.5 ? 1 : clamp((b.hi - this.rpm) / Math.max(b.hi - b.mid, 1e-3), 0, 1);
      b.gain.gain.setTargetAtTime(w * w, t, 0.05);
      b.src.playbackRate.setTargetAtTime(clamp(f / b.fRef, 0.3, 3.5), t, 0.03);
    }
    this.engineFilter.frequency.setTargetAtTime(320 + this.rpm * 2400 + throttle * 700, t, 0.06);
    const load = 0.05 + this.rpm * 0.05 + throttle * 0.035;
    this.engineBus.gain.setTargetAtTime(car.grounded ? load : load * 0.7, t, 0.06);
    this.intakeGain.gain.setTargetAtTime(throttle * (0.012 + this.rpm * 0.02), t, 0.08);
    this.intakeFilter.frequency.setTargetAtTime(500 + this.rpm * 1500, t, 0.08);

    // --- wind: quadratic with speed, airborne = louder and brighter ---
    const air = !car.grounded;
    const wind = Math.pow(Math.min(spd / 45, 1), 2) * 0.05 * (air ? 1.8 : 1);
    this.windGain.gain.setTargetAtTime(wind, t, 0.12);
    this.windFilter.frequency.setTargetAtTime(250 + spd * 11 + (air ? 400 : 0), t, 0.12);

    // --- squeal: only in genuine slides, eased in/out so it never chatters
    const slip = Math.abs(car.slipAngle);
    let want = 0;
    if (car.grounded && spd > 7 && slip > 0.18) want = Math.min((slip - 0.18) * spd * 0.0032, 0.035);
    if (car.grounded && car.braking && spd > 20 && !car.drifting) want = Math.max(want, 0.008);
    this.squealLvl += (want - this.squealLvl) * Math.min(1, (want > this.squealLvl ? 6 : 4) * dt);
    this.squealFilters[0].frequency.setTargetAtTime(700 + slip * 700, t, 0.06);
    this.squealFilters[1].frequency.setTargetAtTime(1150 + slip * 900 + spd * 4, t, 0.06);
    this.squealGain.gain.setTargetAtTime(this.squealLvl, t, 0.06);

    // --- edge-triggered physics events ---
    const p = this.prev;
    if (car.boostFlash > p.boostFlash + 0.3 && car.boostFlash >= 0.75) {
      this.sfx("boost", car.boostFlash >= 0.9 ? 1 : 0.7);
    }
    if (car.padBoost > 0 && p.padBoost <= 0) this.sfx("pad");
    if (car.grounded && !p.grounded && p.airTime > 0.15) this.sfx("land", clamp(0.5 + p.airTime, 0.5, 1.3));
    this.wallCooldown = Math.max(0, this.wallCooldown - dt);
    if (car.wallHit && !p.wallHit && this.wallCooldown <= 0) {
      this.sfx("wall", clamp(0.35 + spd / 35, 0.35, 1.1));
      this.wallCooldown = 0.3;
    }
    p.boostFlash = car.boostFlash;
    p.padBoost = car.padBoost;
    p.grounded = car.grounded;
    p.airTime = car.airTime;
    p.wallHit = car.wallHit;
    p.drifting = car.drifting;
  }
}
