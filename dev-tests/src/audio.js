// audio.js — WebAudio synth, no assets. Continuous layers: a geared engine
// (sub + detuned saws through a soft clipper and an rpm-tracking lowpass),
// speed-scaled wind, and tire squeal (band-passed noise gated by slip).
// One-shot effects: countdown beeps, lap/best/finish jingles, drift-boost
// whoosh, boost-pad sweep, wall thud, landing thump, upshift exhaust pop.

const GEARS = [0, 8, 15, 23, 31, 40, 52]; // m/s shift points
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.gear = 0;
    this.rpm = 0.2;
    this.prev = { boostFlash: 0, padBoost: 0, grounded: true, airTime: 0, wallHit: false, drifting: false };
    this.wallCooldown = 0;
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
    this.master.gain.value = 0.5;
    // soft limiter so stacked one-shots never clip
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.12;
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    // shared looped white noise source (wind, squeal, and one-shot bursts)
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // --- engine: sub sine + two detuned saws -> soft clip -> lowpass ---
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0001;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 700;
    this.engineFilter.Q.value = 1.2;
    this.shaper = ctx.createWaveShaper();
    const curve = new Float32Array(512);
    for (let i = 0; i < 512; i++) { const x = (i / 255.5) - 1; curve[i] = Math.tanh(x * 2.2); }
    this.shaper.curve = curve;
    this.shaper.oversample = "2x";
    this.oscs = [];
    const mk = (type, detune, g) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og);
      og.connect(this.shaper);
      o.start();
      this.oscs.push(o);
      return o;
    };
    this.oscSub = mk("sine", 0, 0.9);       // half the fundamental: the thump
    this.oscA = mk("sawtooth", -7, 0.45);
    this.oscB = mk("sawtooth", 9, 0.45);
    this.oscC = mk("square", 0, 0.18);      // an octave up: the bark
    this.shaper.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // --- wind: lowpassed noise, swells with speed ---
    this.wind = this.loopNoise();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "lowpass";
    this.windFilter.frequency.value = 400;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.0001;
    this.wind.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);

    // --- tire squeal: two peaking bandpasses in parallel (richer than one) ---
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0.0001;
    this.squealFilters = [];
    for (const [f, q] of [[900, 10], [1500, 14]]) {
      const src = this.loopNoise();
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = f;
      bp.Q.value = q;
      src.connect(bp);
      bp.connect(this.squealGain);
      this.squealFilters.push(bp);
    }
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
  tone({ f0, f1 = f0, type = "square", dur = 0.1, vol = 0.12, at = 0, attack = 0.005 }) {
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

  burst({ type = "lowpass", f0 = 800, f1 = f0, q = 1, dur = 0.2, vol = 0.2, at = 0, attack = 0.004 }) {
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
        this.tone({ f0: 740, type: "square", dur: 0.12, vol: 0.14 });
        break;
      case "go":
        this.tone({ f0: 1180, type: "square", dur: 0.5, vol: 0.16 });
        this.tone({ f0: 590, type: "sawtooth", dur: 0.5, vol: 0.06 });
        break;
      case "lap":
        this.tone({ f0: 660, type: "triangle", dur: 0.12, vol: 0.14 });
        this.tone({ f0: 990, type: "triangle", dur: 0.22, vol: 0.14, at: 0.11 });
        break;
      case "best":
        [660, 880, 1100, 1320].forEach((f, i) => this.tone({ f0: f, type: "triangle", dur: i === 3 ? 0.4 : 0.11, vol: 0.14, at: i * 0.1 }));
        break;
      case "finish":
        [[523, 0], [659, 0], [784, 0], [1047, 0.18], [1319, 0.36]].forEach(([f, at]) =>
          this.tone({ f0: f, type: "triangle", dur: 0.9, vol: 0.09, at, attack: 0.02 }));
        break;
      case "boost": // drift-exit / trick boost: jet whoosh + rising tone
        this.burst({ type: "bandpass", f0: 400, f1: 3200, q: 1.4, dur: 0.55, vol: 0.32 * arg, attack: 0.03 });
        this.tone({ f0: 220, f1: 880, type: "sawtooth", dur: 0.35, vol: 0.07 * arg, attack: 0.02 });
        break;
      case "pad": // boost panel: quick ascending sweep
        this.tone({ f0: 300, f1: 1200, type: "square", dur: 0.3, vol: 0.09 });
        this.burst({ type: "highpass", f0: 1500, dur: 0.3, vol: 0.12 });
        break;
      case "wall": // thud + scrape
        this.tone({ f0: 90, f1: 38, type: "sine", dur: 0.22, vol: 0.45 * arg, attack: 0.002 });
        this.burst({ type: "lowpass", f0: 320, f1: 120, dur: 0.18, vol: 0.4 * arg });
        break;
      case "land": // suspension thump
        this.tone({ f0: 70, f1: 40, type: "sine", dur: 0.18, vol: 0.35 * arg, attack: 0.002 });
        this.burst({ type: "lowpass", f0: 500, f1: 150, dur: 0.14, vol: 0.2 * arg });
        break;
      case "shift": // upshift exhaust pop
        this.burst({ type: "bandpass", f0: 220, q: 2, dur: 0.07, vol: 0.18 });
        break;
      case "contact": // car-to-car bump
        this.burst({ type: "lowpass", f0: 700, f1: 200, dur: 0.12, vol: 0.25 * arg });
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
    // each shift. Idle hangs around 0.18; redline is 1.
    let gear = 0;
    while (gear < GEARS.length - 2 && spd >= GEARS[gear + 1]) gear++;
    const span = GEARS[gear + 1] - GEARS[gear];
    let rpmT = 0.3 + 0.7 * clamp((spd - GEARS[gear]) / span, 0, 1);
    if (spd < 1.5) rpmT = 0.18 + throttle * 0.25; // revving at the line
    if (car.drifting && throttle) rpmT = Math.min(1, rpmT + 0.12); // wheelspin flare
    if (gear !== this.gear) {
      if (gear > this.gear && spd > 6) this.sfx("shift");
      this.gear = gear;
    }
    this.rpm += (rpmT - this.rpm) * Math.min(1, (rpmT > this.rpm ? 7 : 12) * dt);
    const f = 42 + this.rpm * 190;
    this.oscSub.frequency.setTargetAtTime(f * 0.5, t, 0.02);
    this.oscA.frequency.setTargetAtTime(f, t, 0.02);
    this.oscB.frequency.setTargetAtTime(f, t, 0.02);
    this.oscC.frequency.setTargetAtTime(f * 2, t, 0.02);
    this.engineFilter.frequency.setTargetAtTime(380 + this.rpm * 2600 + throttle * 500, t, 0.05);
    const load = 0.045 + this.rpm * 0.05 + throttle * 0.035;
    this.engineGain.gain.setTargetAtTime(car.grounded ? load : load * 0.6, t, 0.05);

    // --- wind: quadratic with speed, airborne = louder and brighter ---
    const air = !car.grounded;
    const wind = Math.pow(Math.min(spd / 45, 1), 2) * 0.11 * (air ? 1.8 : 1);
    this.windGain.gain.setTargetAtTime(wind, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(300 + spd * 14 + (air ? 500 : 0), t, 0.1);

    // --- squeal grows with slip angle and speed ---
    const slip = Math.abs(car.slipAngle);
    let squeal = 0;
    if (car.grounded && spd > 6 && slip > 0.14) squeal = Math.min((slip - 0.14) * spd * 0.0045, 0.07);
    if (car.wallHit) squeal = Math.max(squeal, 0.02);
    this.squealFilters[0].frequency.setTargetAtTime(750 + slip * 900, t, 0.04);
    this.squealFilters[1].frequency.setTargetAtTime(1300 + slip * 1400 + spd * 6, t, 0.04);
    this.squealGain.gain.setTargetAtTime(squeal, t, 0.05);

    // --- edge-triggered physics events ---
    const p = this.prev;
    if (car.boostFlash > p.boostFlash + 0.3 && car.boostFlash >= 0.75) {
      this.sfx("boost", car.boostFlash >= 0.9 ? 1 : 0.7);
    }
    if (car.padBoost > 0 && p.padBoost <= 0) this.sfx("pad");
    if (car.grounded && !p.grounded && p.airTime > 0.15) this.sfx("land", clamp(0.5 + p.airTime, 0.5, 1.4));
    this.wallCooldown = Math.max(0, this.wallCooldown - dt);
    if (car.wallHit && !p.wallHit && this.wallCooldown <= 0) {
      this.sfx("wall", clamp(0.4 + spd / 30, 0.4, 1.2));
      this.wallCooldown = 0.25;
    }
    p.boostFlash = car.boostFlash;
    p.padBoost = car.padBoost;
    p.grounded = car.grounded;
    p.airTime = car.airTime;
    p.wallHit = car.wallHit;
    p.drifting = car.drifting;
  }
}
