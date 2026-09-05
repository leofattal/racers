// audio.js — WebAudio synth: engine note (two detuned oscillators pitched by
// speed/throttle) + tire squeal (band-passed noise, gated by slip). No assets.
export class AudioSys {
  constructor() {
    this.ctx = null;
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
    this.master.connect(ctx.destination);

    // engine: saw + square an octave down through a lowpass
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0001;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 900;
    this.osc1 = ctx.createOscillator();
    this.osc1.type = "sawtooth";
    this.osc2 = ctx.createOscillator();
    this.osc2.type = "square";
    this.osc1.frequency.value = 70;
    this.osc2.frequency.value = 35;
    this.osc1.connect(this.engineFilter);
    this.osc2.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.osc1.start();
    this.osc2.start();

    // tire squeal: looped noise through a peaking bandpass
    const len = ctx.sampleRate;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noise = ctx.createBufferSource();
    this.noise.buffer = buf;
    this.noise.loop = true;
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = "bandpass";
    this.squealFilter.Q.value = 9;
    this.squealFilter.frequency.value = 900;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0.0001;
    this.noise.connect(this.squealFilter);
    this.squealFilter.connect(this.squealGain);
    this.squealGain.connect(this.master);
    this.noise.start();
  }

  update(dt, car) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const spd = car.speed;
    const ratio = Math.min(spd / 40, 1);
    // rpm-ish curve: pitch climbs with speed, throttle adds a bark
    const rpm = 0.25 + ratio * 0.75;
    const f = 55 + rpm * 260;
    this.osc1.frequency.setTargetAtTime(f, t, 0.03);
    this.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.03);
    this.engineFilter.frequency.setTargetAtTime(500 + rpm * 2200, t, 0.05);
    this.engineGain.gain.setTargetAtTime(0.05 + rpm * 0.05, t, 0.05);

    // squeal grows with slip angle and speed
    const slip = Math.abs(car.slipAngle);
    let squeal = 0;
    if (spd > 6 && slip > 0.16) {
      squeal = Math.min((slip - 0.16) * spd * 0.004, 0.06);
    }
    if (car.wallHit) squeal = Math.max(squeal, 0.015);
    this.squealFilter.frequency.setTargetAtTime(750 + slip * 900, t, 0.04);
    this.squealGain.gain.setTargetAtTime(squeal, t, 0.05);
  }
}
