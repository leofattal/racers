// hazards.js — track-themed natural disasters during a race.
//
//   eruption   (volcanic sunset palette "rainbow"): a distant mountain blows,
//              then glowing lava rocks rain onto the road ahead of the
//              leader, sit there cooling as obstacles, and sink away.
//   earthquake (every other palette): a few seconds of lateral jolts on every
//              grounded car, continuous camera shake and dust along the road.
//
// The schedule is a pure function of the track id and race time (seeded LCG
// per event index, no Math.random), so every online peer computes the same
// events without any network traffic. Rock animation is a pure function of
// race time as well; only the anchor (the leader's arc length at drop time)
// comes from live car state.

import * as THREE from "three";

// --- tuning -------------------------------------------------------------------
export const HAZARD_TUNING = {
  FIRST_T: 25,          // first event starts at 25 .. 26 s of race time
  FIRST_JITTER: 1,
  GAP_MIN: 40,          // then every 40 .. 55 s
  GAP_JITTER: 15,
  WARN: 3,              // warning lead time (HUD + rumble)
  QUAKE_DUR: 4,         // tremor lasts 4 .. 5 s
  QUAKE_JITTER: 1,
  QUAKE_ACCEL: 4.5,     // m/s^2 peak lateral acceleration
  QUAKE_FREQ: 2.1,      // Hz, main sway
  QUAKE_YAW: 0.14,      // rad/s peak yaw wobble
  QUAKE_SHAKE: 3.2,     // camera kick per second at full intensity (~0.45 steady shake)
  ERUPT_DUR: 4,         // rocks are released over 4 s
  ROCKS_MIN: 6,         // 6 .. 10 rocks per eruption
  ROCKS_JITTER: 5,
  AHEAD_MIN: 60,        // landing arc length ahead of the leader
  AHEAD_SPAN: 160,      // -> 60 .. 220 m
  LAT_MAX: 5.5,         // lateral spread (road half width is 7.5)
  DROP_H: 60,           // rocks fall from 60 m up
  FALL: 1.2,            // ... over 1.2 s
  COOL: 8,              // obstacle lifetime on the road
  SINK: 1,              // then sink into the road over 1 s
  HIT_R: 1.7,           // XZ contact distance
  HIT_SLOW: 0.55,       // speed multiplier on impact
  HIT_COOLDOWN: 0.5,    // s between penalties for the same car
};
const T = HAZARD_TUNING;
const POOL = 12;          // never more than 10 rocks alive (events are 40+ s apart)
const MAX_EVENTS = 64;    // ~ 45 minutes of racing

// --- deterministic randomness ------------------------------------------------
export function hashStr(str) { // FNV-1a, 32 bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export function makeRng(seed) { // Numerical Recipes LCG -> [0, 1)
  let st = (seed >>> 0) || 1;
  return () => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return st / 4294967296; };
}
const eventRng = (trackId, index) => {
  const r = makeRng(hashStr(String(trackId)) ^ Math.imul(index + 1, 0x9e3779b1));
  r(); r(); // decorrelate nearby seeds
  return r;
};

export function hazardTypeFor(track) {
  const key = (track && track.def && track.def.palette) || (track && track.id);
  return key === "rainbow" ? "eruption" : "earthquake";
}

// Pure schedule: [{ t, dur, type, rocks: [{ dt, ahead, lat, size, spin }] }]
export function buildSchedule(trackId, type, count = MAX_EVENTS) {
  const out = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const r = eventRng(trackId, i);
    t = i === 0 ? T.FIRST_T + r() * T.FIRST_JITTER : t + T.GAP_MIN + r() * T.GAP_JITTER;
    const ev = { index: i, t, type, dur: 0, rocks: [] };
    if (type === "earthquake") {
      ev.dur = T.QUAKE_DUR + r() * T.QUAKE_JITTER;
    } else {
      ev.dur = T.ERUPT_DUR + T.FALL;
      const n = T.ROCKS_MIN + Math.floor(r() * T.ROCKS_JITTER);
      for (let k = 0; k < n; k++) {
        ev.rocks.push({
          dt: (k / n) * T.ERUPT_DUR + r() * (T.ERUPT_DUR / n) * 0.8, // spread across the 4 s
          ahead: T.AHEAD_MIN + r() * T.AHEAD_SPAN,
          lat: (r() * 2 - 1) * T.LAT_MAX,
          size: 0.85 + r() * 0.5,
          spin: r() * Math.PI * 2,
        });
      }
    }
    out.push(ev);
  }
  return out;
}

const HOT = { r: 1.0, g: 0.42, b: 0.08 };  // bright orange
const COLD = { r: 0.10, g: 0.03, b: 0.01 }; // dark crust

export class Hazards {
  constructor(scene) {
    this.scene = scene;
    this.track = null;
    this.type = null;
    this.enabled = false;
    this.schedule = [];
    this.active = null;   // { type, intensity 0..1 } while an event runs
    this.warning = null;  // warning text during the 3 s lead-in
    this.glow = 0;        // 0..1 eruption sky glow (main.js may tint the sun)
    this._activeObj = { type: null, intensity: 0 };
    this._hitT = new Map(); // car -> race time of its last rock penalty
    this._phase = new Map(); // per-car quake phase
    this._vis = makeRng(0x5eed); // visual-only randomness (dust placement)
    this._dustAcc = 0;

    // rock pool: shared geometry, one material each (independent cooling)
    this.rockGeo = new THREE.DodecahedronGeometry(1, 0);
    this.rocks = [];
    for (let i = 0; i < POOL; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x2a1a14, roughness: 0.9, metalness: 0.0, emissive: 0xff6a14, emissiveIntensity: 2.2 });
      const mesh = new THREE.Mesh(this.rockGeo, mat);
      mesh.visible = false;
      mesh.castShadow = true;
      if (scene) scene.add(mesh);
      this.rocks.push({ mesh, alive: false, landed: false, x: 0, y: 0, z: 0, s: 0, lat: 0, size: 1, spin: 0, dropT: 0, ev: -1, k: -1 });
    }
    this.reset();
  }

  setTrack(track, enabled = true) {
    this.track = track;
    this.enabled = !!enabled;
    this.type = hazardTypeFor(track);
    this.schedule = this.enabled && track ? buildSchedule(track.id, this.type) : [];
    this.reset();
  }

  reset() {
    this._idx = 0;          // next event not yet finished
    this._stage = 0;        // 0 idle, 1 warned, 2 active (for edge-triggered cues)
    this._lastSecond = -1;
    this._spawned = 0;      // rocks of the current eruption already released
    this.active = null;
    this.warning = null;
    this.glow = 0;
    this._dustAcc = 0;
    this._hitT.clear();
    for (const r of this.rocks) { r.alive = false; r.landed = false; r.mesh.visible = false; }
  }

  // ctx: { kickCams(amount), flash(text, seconds), sfx(name, arg), particles,
  //        leaderCars? (cars used to find the leader; defaults to `cars`) }
  update(dt, raceTime, cars, ctx = {}) {
    this.active = null;
    this.warning = null;
    if (!this.enabled || !this.track) { this.glow = 0; return; }
    const sched = this.schedule;
    // skip events that are fully over (also after a big time jump)
    while (this._idx < sched.length && raceTime > this._endOf(sched[this._idx])) {
      this._idx++; this._stage = 0; this._lastSecond = -1; this._spawned = 0;
    }
    const ev = sched[this._idx];
    if (ev) {
      const rel = raceTime - ev.t;
      const word = ev.type === "eruption" ? "ERUPTION" : "TREMOR";
      if (rel >= -T.WARN && rel < 0) {
        this.warning = `${word} INCOMING`;
        if (this._stage < 1) { this._stage = 1; if (ctx.sfx) ctx.sfx("rumble-warn", 1); }
        const sec = Math.floor(rel);
        if (sec !== this._lastSecond) { this._lastSecond = sec; if (ctx.flash) ctx.flash(this.warning, 0.75); }
      } else if (rel >= 0 && rel < ev.dur) {
        const u = rel / ev.dur;
        const intensity = Math.sin(Math.PI * Math.min(1, u)); // peaks mid-event
        this._activeObj.type = ev.type;
        this._activeObj.intensity = intensity;
        this.active = this._activeObj;
        const label = ev.type === "eruption" ? "ERUPTION" : "EARTHQUAKE";
        if (this._stage < 2) {
          this._stage = 2;
          if (ctx.sfx) ctx.sfx("quake", 1);
          if (ctx.kickCams) ctx.kickCams(ev.type === "eruption" ? 0.6 : 0.3);
        }
        const sec = Math.floor(rel) + 100;
        if (sec !== this._lastSecond) { this._lastSecond = sec; if (ctx.flash) ctx.flash(label, 1.1); }
        if (ev.type === "earthquake") this._quake(dt, raceTime, rel, intensity, cars, ctx);
        else if (ctx.kickCams) ctx.kickCams(dt * T.QUAKE_SHAKE * 0.25 * intensity);
      }
      if (ev.type === "eruption") this._releaseRocks(ev, raceTime, ctx.leaderCars || cars);
      // sky glow: builds through the warning, pulses through the eruption
      if (ev.type === "eruption") {
        const g = rel < -T.WARN ? 0 : rel < 0 ? (rel + T.WARN) / T.WARN * 0.5
          : rel < ev.dur ? 0.65 + 0.35 * Math.sin(rel * 7) : Math.max(0, 1 - (rel - ev.dur) / 3);
        this.glow = Math.max(0, Math.min(1, g));
      } else this.glow = 0;
    } else this.glow = 0;
    this._animateRocks(dt, raceTime, cars, ctx);
  }

  _endOf(ev) {
    return ev.type === "eruption"
      ? ev.t + T.ERUPT_DUR + T.FALL + T.COOL + T.SINK + 0.1 // all its rocks are gone
      : ev.t + ev.dur;
  }

  // --- earthquake -------------------------------------------------------------
  _quake(dt, raceTime, rel, intensity, cars, ctx) {
    const w = Math.PI * 2 * T.QUAKE_FREQ;
    for (const car of cars) {
      if (!car || car.finished || !car.grounded) continue;
      let ph = this._phase.get(car);
      if (ph === undefined) { ph = (hashStr(String(car.netId || car.name || "car")) % 6283) / 1000; this._phase.set(car, ph); }
      const a = T.QUAKE_ACCEL * intensity * (Math.sin(w * rel + ph) * 0.8 + Math.sin(w * 2.7 * rel + ph * 1.7) * 0.35);
      const rx = Math.cos(car.heading), rz = -Math.sin(car.heading); // car's right
      car.vel.x += rx * a * dt;
      car.vel.z += rz * a * dt;
      car.heading += T.QUAKE_YAW * intensity * Math.cos(w * 1.3 * rel + ph) * dt;
    }
    if (ctx.kickCams) ctx.kickCams(dt * T.QUAKE_SHAKE * intensity);
    // dust kicked up along the road near the cars
    const P = ctx.particles;
    if (!P || !cars.length) return;
    this._dustAcc += dt * 14 * intensity;
    let n = 0;
    while (this._dustAcc >= 1 && n < 6) {
      this._dustAcc -= 1; n++;
      const car = cars[Math.floor(this._vis() * cars.length)];
      if (!car || !car.prog) continue;
      const pose = this.track.poseFor(car.prog.s + 6 + this._vis() * 40, (this._vis() * 2 - 1) * 7);
      P.burst(pose.x, pose.y, pose.z, 0xcdbb9c, 2.2, 2, "smoke", { opacity: 0.4, size: 1.7, grow: 1.3, life: 0.9 });
    }
  }

  // --- eruption: rocks ----------------------------------------------------------
  _leaderS(cars) {
    let best = null;
    for (const c of cars) {
      if (!c || !c.prog || c.finished) continue;
      if (!best || c.prog.total > best.prog.total) best = c;
    }
    if (!best) for (const c of cars) if (c && c.prog) { best = c; break; }
    return best ? best.prog.s : 0;
  }

  _releaseRocks(ev, raceTime, leaderCars) {
    while (this._spawned < ev.rocks.length) {
      const spec = ev.rocks[this._spawned];
      const dropT = ev.t + spec.dt;
      if (raceTime < dropT) break;
      const k = this._spawned++;
      // too late to show (time jumped past its whole life): skip it
      if (raceTime > dropT + T.FALL + T.COOL + T.SINK) continue;
      const r = this.rocks.find((x) => !x.alive) || this.rocks[k % POOL];
      const s = this._leaderS(leaderCars) + spec.ahead;
      const pose = this.track.poseFor(s, spec.lat);
      r.alive = true; r.landed = false;
      r.x = pose.x; r.z = pose.z; r.y = pose.y; r.s = pose.s; r.lat = spec.lat;
      r.size = spec.size; r.spin = spec.spin; r.dropT = dropT; r.ev = ev.index; r.k = k;
      r.mesh.visible = true;
      r.mesh.scale.set(spec.size, spec.size * 0.8, spec.size);
    }
  }

  _animateRocks(dt, raceTime, cars, ctx) {
    const P = ctx.particles;
    for (const r of this.rocks) {
      if (!r.alive) continue;
      const age = raceTime - r.dropT;
      const m = r.mesh, mat = m.material;
      if (age >= T.FALL + T.COOL + T.SINK || age < -0.5) { r.alive = false; r.landed = false; m.visible = false; continue; }
      if (age < T.FALL) {
        // falling: accelerating drop with a smoke / ember trail
        const u = Math.max(0, age) / T.FALL;
        const h = T.DROP_H * (1 - u * u);
        m.position.set(r.x, r.y + r.size * 0.55 + h, r.z);
        m.rotation.set(r.spin + age * 5, r.spin * 0.5 + age * 3, 0);
        this._setHeat(mat, 1);
        if (P) {
          P.burst(r.x, m.position.y, r.z, 0xff8a2a, 0.4, 1, "spark");
          if (((r.k + Math.floor(age * 30)) & 1) === 0) P.burst(r.x, m.position.y, r.z, 0x4a3a36, 0.6, 1, "smoke", { opacity: 0.45, size: 1.4, grow: 1.2, life: 0.8 });
        }
        continue;
      }
      if (!r.landed) {
        r.landed = true;
        if (P) {
          P.puff(r.x, r.y, r.z, 0x8c7a68, 14);
          P.burst(r.x, r.y + 0.4, r.z, 0xffa040, 0.8, 8, "spark");
        }
        if (ctx.sfx) ctx.sfx("land", 0.6);
      }
      const ground = age - T.FALL;
      const heat = Math.max(0, 1 - ground / T.COOL);
      this._setHeat(mat, heat * heat * (0.85 + 0.15 * Math.sin(raceTime * 9 + r.k)));
      const sink = ground > T.COOL ? (ground - T.COOL) / T.SINK : 0;
      m.position.set(r.x, r.y + r.size * 0.55 - sink * r.size * 1.6, r.z);
      m.rotation.set(r.spin, r.spin * 0.5, 0);
      if (sink < 0.5) this._collide(r, raceTime, cars);
    }
  }

  _setHeat(mat, heat) {
    mat.emissive.setRGB(COLD.r + (HOT.r - COLD.r) * heat, COLD.g + (HOT.g - COLD.g) * heat, COLD.b + (HOT.b - COLD.b) * heat);
    mat.emissiveIntensity = 0.2 + 2.0 * heat;
  }

  _collide(r, raceTime, cars) {
    for (const car of cars) {
      if (!car || car.finished || !car.grounded) continue;
      let dx = car.pos.x - r.x, dz = car.pos.z - r.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= T.HIT_R * T.HIT_R) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-4) { // dead centre: push out against the direction of travel
        const sp = Math.hypot(car.vel.x, car.vel.z);
        if (sp > 0.01) { dx = -car.vel.x / sp; dz = -car.vel.z / sp; } else { dx = Math.sin(car.heading + Math.PI); dz = Math.cos(car.heading + Math.PI); }
        d = 1;
      }
      const nx = dx / d, nz = dz / d;
      car.pos.x = r.x + nx * T.HIT_R;
      car.pos.z = r.z + nz * T.HIT_R;
      // kill the into-rock velocity component, then the impact penalty
      const vn = car.vel.x * nx + car.vel.z * nz;
      if (vn < 0) { car.vel.x -= nx * vn; car.vel.z -= nz * vn; }
      const last = this._hitT.get(car);
      if (last === undefined || raceTime - last > T.HIT_COOLDOWN || raceTime < last) {
        this._hitT.set(car, raceTime);
        car.vel.x *= T.HIT_SLOW;
        car.vel.z *= T.HIT_SLOW;
        car.wallHit = true;
      }
      if (car.syncMesh) car.syncMesh(0);
    }
  }
}
