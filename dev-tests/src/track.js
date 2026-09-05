// track.js — closed circuits built from Catmull-Rom splines. Owns: road and
// wall geometry (with ramp elevation), checkpoints (gates), the toggleable
// racing-line hint, per-car progress/gate tracking, wall collision, and the
// height field that makes jumps work. Three courses; main.js switches by T key.

import * as THREE from "three";
import { SURFACES } from "./car.js";

// ---------------------------------------------------------------------------
// Course definitions. `points` traces the centerline (x, z). `ramps` are
// tabletop kickers placed by a nearby reference point: the car follows the
// height field while grounded, and goes ballistic when the ground falls away.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Course definitions. `points` traces the centerline (x, z). `ramps` are
// launch kickers (soaring flight) or tabletops (gentle hops) placed by a
// nearby reference point. `pads` are glowing boost panels. Every ramp gets a
// boost pad auto-placed on its approach, Mario-Kart style.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Course definitions. `points` traces the centerline (x, z); `scale` grows
// the whole course Mario-Kart-big. `hills` adds rolling terrain depth (two
// long sine swells). `ramps` are kickers/tabletops; `pads` are boost panels;
// `surfaces` are dirt/ice grip zones. Every kicker auto-gets an approach pad.
// ---------------------------------------------------------------------------
export const TRACKS = [
  {
    id: "apex",
    name: "APEX CIRCUIT",
    scale: 1.45,
    hills: { a: 2.4, b: 1.4 },
    points: [
      [0, -140], [90, -140], [140, -112], [158, -52],
      [126, -22], [108, 2], [126, 26],                        // chicane
      [114, 72], [150, 92], [152, 132], [112, 158], [66, 138], // hairpin
      [20, 110], [-30, 118], [-78, 88],                       // left sweepers
      [-100, 40], [-124, 8], [-92, -22],                      // left hairpin
      [-78, -72], [-38, -112],
    ],
    ramps: [
      { near: [120, 48], len: 46, h: 3.4, type: "kicker" },
      { near: [-55, -92], len: 62, h: 5.2, type: "kicker" },
    ],
    pads: [{ near: [55, -140], len: 12 }, { near: [30, 105], len: 11 }, { near: [-100, -45], len: 10 }],
    surfaces: [
      { near: [-45, 105], len: 110, type: "dirt" },
      { near: [40, 100], len: 80, type: "ice" },
    ],
  },
  {
    id: "skyway",
    name: "SKYWAY SPRINT",
    scale: 1.35,
    hills: { a: 2.8, b: 1.6 },
    points: [
      [0, -150], [90, -150], [150, -112], [165, -50],
      [132, -12], [100, -30], [85, 10], [115, 45],             // S-bends
      [150, 42], [170, 90], [135, 125], [80, 118],
      [40, 150], [5, 185], [-45, 185], [-90, 155],             // top hairpin
      [-125, 108], [-155, 60], [-150, 5], [-170, -45],
      [-140, -95], [-100, -125], [-50, -145],
    ],
    ramps: [
      { near: [62, -150], len: 70, h: 6.0, type: "kicker" }, // home-straight mega jump
      { near: [-162, -20], len: 50, h: 2.6, type: "table" },
    ],
    pads: [{ near: [152, 55], len: 12 }, { near: [40, 152], len: 11 }, { near: [-185, -60], len: 10 }],
    surfaces: [
      { near: [-25, 185], len: 120, type: "dirt" },
      { near: [140, 122], len: 90, type: "ice" },
    ],
  },
  {
    id: "breeze",
    name: "BREEZEWAY BAY",
    scale: 1.5,
    hills: { a: 2.2, b: 1.3 },
    points: [
      [0, -110], [65, -115], [115, -85], [130, -35],
      [100, 0], [65, -15], [35, 15],                           // chicane
      [70, 50], [115, 55], [135, 100], [100, 130],
      [50, 120], [5, 140], [-50, 135], [-95, 105],             // bay hairpin
      [-115, 55], [-130, 5], [-110, -45], [-80, -85], [-40, -105],
    ],
    ramps: [
      { near: [90, -100], len: 55, h: 4.4, type: "kicker" },
      { near: [-124, 28], len: 45, h: 2.4, type: "table" },
    ],
    pads: [{ near: [45, -114], len: 11 }, { near: [122, 80], len: 10 }],
    surfaces: [
      { near: [125, 105], len: 100, type: "dirt" },
      { near: [-120, 60], len: 80, type: "ice" },
    ],
  },
  {
    id: "rainbow",
    name: "RAINBOW RIDGE",
    scale: 1.0,
    hills: { a: 3.4, b: 2.0 }, // deepest terrain — the ridge course
    points: [
      [0, -160], [100, -160], [165, -125], [185, -60],
      [150, -10], [185, 30], [170, 85], [130, 118],            // S-flow
      [150, 160], [120, 205], [65, 195], [15, 225],
      [-45, 215], [-95, 235], [-150, 210], [-185, 160],
      [-150, 120], [-175, 75], [-200, 20], [-185, -40],
      [-145, -75], [-170, -110], [-140, -155], [-90, -140], [-40, -158],
    ],
    ramps: [
      { near: [95, -160], len: 80, h: 7.0, type: "kicker" }, // the mega ramp
      { near: [-195, 55], len: 60, h: 4.0, type: "kicker" },
      { near: [45, 208], len: 45, h: 2.6, type: "table" },
    ],
    pads: [{ near: [180, -90], len: 12 }, { near: [172, 60], len: 11 }, { near: [-160, 198], len: 11 }],
    surfaces: [
      { near: [-140, 205], len: 120, type: "dirt" },
      { near: [-185, 150], len: 90, type: "ice" },
    ],
  },
];

const SAMPLES = 512;
const HALF_WIDTH = 7.5;
const GATE_COUNT = 8;

// smoothstep01: 0->1 with zero slope at both ends
const ss = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
// tabletop profile: gentle rise, flat top, gentle fall — a safe little hop
const tableBump = (u) => ss(u / 0.32) * (1 - ss((u - 0.5) / 0.38));
// kicker profile: near-linear climb (real momentum at the lip), short crest,
// steep quick drop with a long flat runout to land in
const kickerBump = (u) => {
  const rise = Math.min(u / 0.45, 1) * ss(u / 0.06);
  return rise * (1 - ss((u - 0.52) / 0.13));
};
const rampProfile = (r, u) => (r.type === "table" ? tableBump(u) : kickerBump(u));

export class Track {
  constructor(scene, def = TRACKS[0]) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.N = SAMPLES;
    this.halfWidth = HALF_WIDTH;
    this.meshes = [];
    const scale = def.scale || 1;
    const pts = def.points.map(([x, z]) => new THREE.Vector3(x * scale, 0, z * scale));
    this.curve = new THREE.CatmullRomCurve3(pts, true, "centripetal");
    this.hillA = def.hills ? def.hills.a : 0;
    this.hillB = def.hills ? def.hills.b : 0;
    // lift the whole height field so rolling valleys never sink below the
    // ground plane (road surface base height stays >= 0)
    this.yOffset = this.hillA + this.hillB;

    // Arc-length spaced centerline samples (last == first on closed curves; drop it).
    const spaced = this.curve.getSpacedPoints(SAMPLES);
    const N = SAMPLES;
    this.px = new Float64Array(N);
    this.pz = new Float64Array(N);
    this.hh = new Float64Array(N);   // ground height at sample
    this.tx = new Float64Array(N);   // unit tangent (planar)
    this.tz = new Float64Array(N);
    this.nx = new Float64Array(N);   // "right" normal of the tangent
    this.nz = new Float64Array(N);
    this.ss = new Float64Array(N);   // cumulative arc length
    for (let i = 0; i < N; i++) {
      this.px[i] = spaced[i].x;
      this.pz[i] = spaced[i].z;
    }
    let total = 0;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const dx = this.px[j] - this.px[i];
      const dz = this.pz[j] - this.pz[i];
      this.ss[i] = total;
      total += Math.hypot(dx, dz);
      // central-difference tangent
      const k = (i - 1 + N) % N;
      let tx = this.px[j] - this.px[k];
      let tz = this.pz[j] - this.pz[k];
      const tl = Math.hypot(tx, tz) || 1;
      this.tx[i] = tx / tl;
      this.tz[i] = tz / tl;
      this.nx[i] = this.tz[i];
      this.nz[i] = -this.tx[i];
    }
    this.length = total;

    // Ramps mapped onto arc length (never overlap the start grid).
    this.rampsWorld = [];
    for (const r of def.ramps || []) {
      const sC = this.indexOf(r.near[0] * scale, r.near[1] * scale) / N * this.length;
      const s0 = sC - r.len / 2;
      this.rampsWorld.push({ s0, s1: s0 + r.len, h: r.h, type: r.type || "kicker" });
    }

    // Boost pads: explicit ones plus an auto pad on every kicker approach.
    this.padsWorld = [];
    for (const p of def.pads || []) {
      const sC = this.indexOf(p.near[0] * (def.scale || 1), p.near[1] * (def.scale || 1)) / N * this.length;
      this.padsWorld.push({ s0: sC - p.len / 2, s1: sC + p.len / 2 });
    }
    for (const r of this.rampsWorld) {
      this.padsWorld.push({ s0: r.s0 - 23, s1: r.s0 - 14 });
    }

    // Surface grip zones (dirt / ice).
    this.surfacesWorld = [];
    for (const z of def.surfaces || []) {
      const sC = this.indexOf(z.near[0] * (def.scale || 1), z.near[1] * (def.scale || 1)) / N * this.length;
      this.surfacesWorld.push({ s0: sC - z.len / 2, s1: sC + z.len / 2, type: z.type });
    }

    for (let i = 0; i < N; i++) this.hh[i] = this.heightAt(this.ss[i]);

    // Curvature (smoothed) -> per-point max corner speed for the AI.
    this.kappa = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i - 2 + N) % N, b = (i + 2) % N;
      const c1x = this.px[i] - this.px[a], c1z = this.pz[i] - this.pz[a];
      const c2x = this.px[b] - this.px[i], c2z = this.pz[b] - this.pz[i];
      const cross = c1x * c2z - c1z * c2x;
      const dot = c1x * c2x + c1z * c2z;
      const ang = Math.atan2(cross, dot);
      const len = Math.max((Math.hypot(c1x, c1z) + Math.hypot(c2x, c2z)) / 2, 1e-3);
      this.kappa[i] = ang / len;
    }
    for (let pass = 0; pass < 3; pass++) {
      const src = this.kappa.slice();
      for (let i = 0; i < N; i++) {
        let sum = 0;
        for (let o = -2; o <= 2; o++) sum += src[(i + o + N) % N];
        this.kappa[i] = sum / 5;
      }
    }
    this.cornerSpeed = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const surf = SURFACES[this.surfaceAt(this.ss[i])] || SURFACES.asphalt;
      this.cornerSpeed[i] = Math.min(60, Math.max(6, Math.sqrt(17 * surf.grip / Math.max(Math.abs(this.kappa[i]), 0.004))));
    }

    // Checkpoints / reset gates, evenly spaced by arc length.
    this.gates = [];
    for (let g = 0; g < GATE_COUNT; g++) this.gates.push(g / GATE_COUNT * this.length);

    this.buildMeshes(scene);
  }

  // ride height of the circuit surface at arc length s: rolling terrain
  // (two long sine swells, continuous across the lap seam) + ramp bumps,
  // offset so nothing ever dips below y=0
  heightAt(s) {
    s = ((s % this.length) + this.length) % this.length;
    let y = this.yOffset +
            this.hillA * Math.sin((Math.PI * 2 * 3 * s) / this.length) +
            this.hillB * Math.sin((Math.PI * 2 * 5 * s) / this.length + 1.3);
    for (const r of this.rampsWorld) {
      if (s >= r.s0 && s <= r.s1) {
        y += r.h * rampProfile(r, (s - r.s0) / (r.s1 - r.s0));
      }
    }
    return y;
  }

  // road surface type at arc length s (dirt / ice zones; asphalt default)
  surfaceAt(s) {
    s = ((s % this.length) + this.length) % this.length;
    for (const z of this.surfacesWorld) {
      if (s >= z.s0 && s <= z.s1) return z.type;
    }
    return "asphalt";
  }

  // is there a boost pad at arc length s?
  padAt(s) {
    s = ((s % this.length) + this.length) % this.length;
    for (const p of this.padsWorld) {
      if (s >= p.s0 && s <= p.s1) return true;
    }
    return false;
  }

  groundAt(x, z) {
    return this.heightAt(this.indexOf(x, z) / this.N * this.length);
  }

  // -- geometry queries ----------------------------------------------------

  indexOf(x, z) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.N; i++) {
      const dx = x - this.px[i], dz = z - this.pz[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // continuity-aware nearest: search a window around the last known index so
  // the lookup can't hop to a parallel leg (chicanes / S-bends). Falls back
  // to a global scan when the car has teleported far (respawns, big jumps).
  indexNear(x, z, hint, window = 48) {
    let best = hint, bestD = Infinity;
    for (let o = -window; o <= window; o++) {
      const i = ((hint + o) % this.N + this.N) % this.N;
      const dx = x - this.px[i], dz = z - this.pz[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return bestD < 2500 ? best : this.indexOf(x, z); // 50m fallback radius
  }

  indexOfCar(car) {
    if (!car.prog) return this.indexOf(car.pos.x, car.pos.z);
    const hint = ((Math.round(car.prog.s / this.length * this.N) % this.N) + this.N) % this.N;
    return this.indexNear(car.pos.x, car.pos.z, hint);
  }

  // pose on the racing line at arc length s, offset sideways by `lat`
  poseFor(s, lat = 0) {
    s = ((s % this.length) + this.length) % this.length;
    const f = s / this.length * this.N;
    const i0 = Math.floor(f) % this.N;
    const i1 = (i0 + 1) % this.N;
    const t = f - Math.floor(f);
    const x = this.px[i0] + (this.px[i1] - this.px[i0]) * t;
    const z = this.pz[i0] + (this.pz[i1] - this.pz[i0]) * t;
    let tx = this.tx[i0] + (this.tx[i1] - this.tx[i0]) * t;
    let tz = this.tz[i0] + (this.tz[i1] - this.tz[i0]) * t;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    return { x: x + tz * lat, z: z - tx * lat, y: this.heightAt(s), heading: Math.atan2(tx, tz), s };
  }

  pointAt(s) {
    const p = this.poseFor(s, 0);
    return { x: p.x, z: p.z, tx: Math.sin(p.heading), tz: Math.cos(p.heading) };
  }

  // minimum corner speed within [s0, s0 + dist] — the AI brakes for this
  minCornerSpeed(s0, dist) {
    const step = this.N;
    const i0 = Math.floor((((s0 % this.length) + this.length) % this.length) / this.length * step);
    const count = Math.max(1, Math.ceil(dist / this.length * step));
    let m = Infinity;
    for (let k = 0; k < count; k++) {
      const v = this.cornerSpeed[(i0 + k) % step];
      if (v < m) m = v;
    }
    return m;
  }

  // -- car progress / lap validation ----------------------------------------

  initProgress(car) {
    const i = this.indexOf(car.pos.x, car.pos.z);
    const s = i / this.N * this.length;
    car.prog = { s, total: s > this.length / 2 ? s - this.length : s, lap: 0, gate: 1, lastGate: 0, gateHits: 0 };
    return car.prog;
  }

  // advances car.prog; returns an event object for main.js
  updateProgress(car) {
    const p = car.prog;
    const prevIdx = ((Math.round(p.s / this.length * this.N) % this.N) + this.N) % this.N;
    const i = this.indexNear(car.pos.x, car.pos.z, prevIdx);
    const j = (i + 1) % this.N;
    const segLen = Math.hypot(this.px[j] - this.px[i], this.pz[j] - this.pz[i]) || 1;
    const frac = Math.max(0, Math.min(1,
      ((car.pos.x - this.px[i]) * this.tx[i] + (car.pos.z - this.pz[i]) * this.tz[i]) / segLen));
    const s = (i + frac) / this.N * this.length;
    let d = s - p.s;
    let crossed = false;
    if (d < -this.length / 2) { d += this.length; crossed = true; }
    else if (d > this.length / 2) d -= this.length;
    p.total += d;
    p.s = s;
    if (p.total > 0) p.lap = Math.floor(p.total / this.length);

    // gates must be passed in order for a lap to validate
    let gatePassed = -1;
    const g = p.gate;
    const gs = this.gates[g];
    let gd = Math.abs(s - gs);
    gd = Math.min(gd, this.length - gd);
    if (gd < 9 && d > -0.5) {
      gatePassed = g;
      p.lastGate = g;
      p.gate = (g + 1) % GATE_COUNT;
      p.gateHits++;
    }
    return { crossed, gatePassed, lapValid: p.gate === 0 || p.gate === 1 };
  }

  // -- walls: soft-spring slide. Smooth positional recovery (no 60fps jitter
  // against a hard clamp), into-wall speed killed without restitution, and a
  // hard absolute clamp that can never be tunneled through.
  resolveCollision(car) {
    const i = this.indexOfCar(car);
    const cX = this.px[i], cZ = this.pz[i];
    const nX = this.nx[i], nZ = this.nz[i];
    const off = (car.pos.x - cX) * nX + (car.pos.z - cZ) * nZ;
    const limit = this.halfWidth - 1.15;
    if (Math.abs(off) <= limit) return;
    const side = Math.sign(off);
    const excess = Math.abs(off) - limit;
    // soft spring push-out (capped per frame — smooth wall riding, no shaking)
    const push = Math.min(excess * 0.5, 0.35);
    car.pos.x -= nX * side * push;
    car.pos.z -= nZ * side * push;
    // absolute clamp: physically impossible to leave the ribbon
    if (Math.abs(off) > this.halfWidth - 0.4) {
      car.pos.x = cX + nX * side * (this.halfWidth - 0.4);
      car.pos.z = cZ + nZ * side * (this.halfWidth - 0.4);
    }
    // velocity: reflect the normal component with low restitution — banked
    // walls deflect you back onto the road, they don't stop you dead
    const vn = car.vel.x * (nX * side) + car.vel.z * (nZ * side);
    if (vn > 0) {
      car.vel.x -= nX * side * vn * 1.3; // restitution 0.3
      car.vel.z -= nZ * side * vn * 1.3;
      if (vn > 1.0) car.wallHit = true; // light scrapes don't break combos
    } else if (car.speed < 3 && excess > 0.05) {
      // nearly parked against the wall: gentle push-off instead of the
      // 60hz fight the hard clamp used to cause
      car.vel.x -= nX * side * 0.08;
      car.vel.z -= nZ * side * 0.08;
    }
    car.syncMesh(0);
  }

  // -- meshes ----------------------------------------------------------------

  addMesh(scene, mesh) {
    scene.add(mesh);
    this.meshes.push(mesh);
    return mesh;
  }

  dispose(scene) {
    for (const m of this.meshes) {
      scene.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    }
    this.meshes = [];
  }

  buildMeshes(scene) {
    const N = this.N, hw = this.halfWidth;
    const { px, pz, nx, nz, hh, ss: sArr } = this;

    const strip = (offA, offB, yOff, material, colors) => {
      const pos = [], col = [], idx = [];
      for (let i = 0; i < N; i++) {
        pos.push(px[i] + nx[i] * offA, hh[i] + yOff, pz[i] + nz[i] * offA);
        pos.push(px[i] + nx[i] * offB, hh[i] + yOff, pz[i] + nz[i] * offB);
        if (colors) {
          const c = colors(i);
          col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
        }
      }
      for (let i = 0; i < N; i++) {
        const a = 2 * i, b = 2 * i + 1, c = 2 * ((i + 1) % N), d = 2 * ((i + 1) % N) + 1;
        idx.push(a, b, c, b, d, c);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      if (colors) g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return this.addMesh(scene, new THREE.Mesh(g, material));
    };

    // Decals sit just above the road: polygonOffset + clearance beats
    // z-fighting, DoubleSide makes slopes opaque from every angle.
    const decal = (opts) => new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2,
      polygonOffsetUnits: -2, ...opts,
    });

    // road surface — ramps hazard-orange, dirt brown, ice pale blue
    const inRamp = (s) => this.rampsWorld.some((r) => s >= r.s0 && s <= r.s1);
    strip(-hw, hw, 0,
      new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      (i) => {
        if (inRamp(sArr[i])) return [0.95, 0.5, 0.12];
        const st = SURFACES[this.surfaceAt(sArr[i])] || SURFACES.asphalt;
        return st.tint;
      });

    // white edge lines
    strip(-hw + 0.15, -hw + 0.5, 0.045, decal({ color: 0xd8dde6 }));
    strip(hw - 0.5, hw - 0.15, 0.045, decal({ color: 0xd8dde6 }));

    // center dashes
    {
      const pos = [], idx = [];
      let v = 0;
      for (let i = 0; i < N; i += 10) {
        const j = (i + 4) % N;
        pos.push(px[i] - nx[i] * 0.18, hh[i] + 0.045, pz[i] - nz[i] * 0.18);
        pos.push(px[i] + nx[i] * 0.18, hh[i] + 0.045, pz[i] + nz[i] * 0.18);
        pos.push(px[j] - nx[j] * 0.18, hh[j] + 0.045, pz[j] - nz[j] * 0.18);
        pos.push(px[j] + nx[j] * 0.18, hh[j] + 0.045, pz[j] + nz[j] * 0.18);
        idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        v += 4;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      this.addMesh(scene, new THREE.Mesh(g, decal({ color: 0xb8a94e })));
    }

    // banked walls — they lean outward so cars slide up and off them.
    const red = [0.85, 0.24, 0.2], white = [0.94, 0.92, 0.86];
    for (const side of [-1, 1]) {
      const pos = [], col = [], idx = [];
      for (let i = 0; i < N; i++) {
        const c = ((i >> 4) & 1) ? red : white;
        pos.push(px[i] + nx[i] * hw * side, hh[i], pz[i] + nz[i] * hw * side);
        pos.push(px[i] + nx[i] * (hw + 1.6) * side, hh[i] + 1.05, pz[i] + nz[i] * (hw + 1.6) * side);
        col.push(...c, ...c);
      }
      for (let i = 0; i < N; i++) {
        const a = 2 * i, b = 2 * i + 1, c = 2 * ((i + 1) % N), d = 2 * ((i + 1) % N) + 1;
        if (side > 0) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      this.addMesh(scene, new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    }

    // start/finish checker strip
    {
      const pos = [], col = [], idx = [];
      const s0 = this.poseFor(0, 0), s1 = this.poseFor(1.4, 0);
      const n0x = Math.cos(s0.heading), n0z = -Math.sin(s0.heading);
      const n1x = Math.cos(s1.heading), n1z = -Math.sin(s1.heading);
      let v = 0;
      const cols = 14;
      for (let k = 0; k < cols; k++) {
        const o0 = -hw + (2 * hw) * (k / cols), o1 = -hw + (2 * hw) * ((k + 1) / cols);
        const c = (k & 1) ? [1, 1, 1] : [0.06, 0.06, 0.06];
        const c2 = (k & 1) ? [0.06, 0.06, 0.06] : [1, 1, 1];
        pos.push(s0.x + n0x * o0, s0.y + 0.05, s0.z + n0z * o0);
        pos.push(s0.x + n0x * o1, s0.y + 0.05, s0.z + n0z * o1);
        pos.push(s1.x + n1x * o0, s1.y + 0.05, s1.z + n1z * o0);
        pos.push(s1.x + n1x * o1, s1.y + 0.05, s1.z + n1z * o1);
        col.push(...c, ...c, ...c2, ...c2);
        idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        v += 4;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      this.addMesh(scene, new THREE.Mesh(g, decal({ vertexColors: true })));
    }

    // ground
    {
      const g = new THREE.PlaneGeometry(1400, 1400);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x22301f }));
      m.position.y = -0.08;
      this.addMesh(scene, m);
    }

    // glowing boost pads — alternating yellow/orange full-width bands
    {
      for (const p of this.padsWorld) {
        const pos = [], col = [], idx = [];
        const bands = 4;
        const yellow = [1.0, 0.85, 0.1], orange = [1.0, 0.45, 0.05];
        for (let b = 0; b < bands; b++) {
          const sA = p.s0 + (p.s1 - p.s0) * (b / bands);
          const sB = p.s0 + (p.s1 - p.s0) * ((b + 1) / bands);
          const A = this.poseFor(sA, 0), B = this.poseFor(sB, 0);
          const w = hw - 0.6, y = 0.06;
          const nAx = Math.cos(A.heading), nAz = -Math.sin(A.heading);
          const nBx = Math.cos(B.heading), nBz = -Math.sin(B.heading);
          const v0 = pos.length / 3;
          pos.push(
            A.x - nAx * w, A.y + y, A.z - nAz * w,
            A.x + nAx * w, A.y + y, A.z + nAz * w,
            B.x - nBx * w, B.y + y, B.z - nBz * w,
            B.x + nBx * w, B.y + y, B.z + nBz * w,
          );
          const c = (b & 1) ? yellow : orange;
          col.push(...c, ...c, ...c, ...c);
          idx.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        g.setIndex(idx);
        this.addMesh(scene, new THREE.Mesh(g, decal({ vertexColors: true })));
      }
    }

    // start/finish banner arch
    {
      const s0 = this.poseFor(0, 0);
      const n0x = Math.cos(s0.heading), n0z = -Math.sin(s0.heading);
      const postGeo = new THREE.CylinderGeometry(0.3, 0.35, 5.6, 8);
      const postMat = new THREE.MeshLambertMaterial({ color: 0xe8ecf2 });
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(s0.x + n0x * (hw + 1.2) * side, s0.y + 2.8, s0.z + n0z * (hw + 1.2) * side);
        this.addMesh(scene, post);
      }
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry((hw + 1.2) * 2 + 0.6, 1.0, 0.5),
        new THREE.MeshLambertMaterial({ color: 0x35e0c8 })
      );
      beam.position.set(s0.x, s0.y + 5.6, s0.z);
      beam.rotation.y = s0.heading;
      this.addMesh(scene, beam);
    }

    // low-poly pines scattered outside the walls
    {
      let seed = 0;
      for (const ch of this.def.id) seed = seed * 31 + ch.charCodeAt(0) >>> 0;
      const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a3d24 });
      const leafMat = new THREE.MeshLambertMaterial({ color: 0x2f6b35 });
      const count = Math.round(this.length / 36);
      for (let k = 0; k < count; k++) {
        const i = Math.floor((k / count) * N + rng() * (N / count));
        const side = rng() > 0.5 ? 1 : -1;
        const lat = (hw + 9 + rng() * 18) * side;
        const x = px[i] + nx[i] * lat, z = pz[i] + nz[i] * lat;
        const hgt = 3 + rng() * 2.5;
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 1.6, 5), trunkMat);
        trunk.position.set(x, 0.8, z);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(1.4 + rng() * 0.7, hgt, 6), leafMat);
        cone.position.set(x, 1.6 + hgt / 2, z);
        this.addMesh(scene, trunk);
        this.addMesh(scene, cone);
      }
    }

    // racing line hint (toggle with L) — wide, bright, lifted and
    // polygon-offset so it actually reads from the chase camera
    this.lineMesh = strip(-0.75, 0.75, 0.075,
      decal({ color: 0x3dff7a, transparent: true, opacity: 0.55 }));
  }

  // outline points for the HUD minimap
  outline() {
    const pts = [];
    for (let i = 0; i < this.N; i += 4) pts.push([this.px[i], this.pz[i]]);
    return pts;
  }
}
