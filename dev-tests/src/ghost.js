// ghost.js — records the player's car every frame of a lap; when that lap
// beats the session best, the recording becomes the replayed ghost.
// The ghost is translucent, has no collision, and replays in sync from the
// moment the player crosses the start line. Bests are per-track (in-memory).

import * as THREE from "three";
import { buildCarMesh } from "./car.js";
import { loadMem, saveMem } from "./memory.js";

// ghost frames are quantized before persisting so each lap stays small enough
// for localStorage (a full 60fps lap otherwise runs into the hundreds of KB)
const q = (v, p = 3) => Math.round(v * 10 ** p) / 10 ** p;

export class GhostSystem {
  constructor(scene) {
    this.trackId = null;
    this.bests = Object.create(null); // trackId -> { time, t[], x[], y[], z[], h[] }
    this.best = null;                 // best for the active track
    this.recording = null;            // active recording buffers
    this.enabled = loadMem("ghost-enabled", true);
    this.playT = 0;
    this.playing = false;
    this.mesh = buildCarMesh(0x67f0ff, true);
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // switch active track: restore that track's stored best (persisted in
  // localStorage so it survives page reloads)
  setTrack(id) {
    this.trackId = id;
    if (!this.bests[id]) {
      const g = loadMem(`ghost-${id}`, null);
      if (g && g.t && g.t.length > 9) this.bests[id] = g;
    }
    this.best = this.bests[id] || null;
    this.recording = null;
    this.playing = false;
    this.mesh.visible = false;
  }

  startRecording() {
    this.recording = { t: [], x: [], y: [], z: [], h: [], time: 0 };
  }

  // a mid-lap checkpoint reset makes the lap's recording invalid
  voidRecording() {
    this.recording = null;
  }

  recordFrame(dt, car) {
    const r = this.recording;
    if (!r) return;
    r.time += dt;
    r.t.push(r.time);
    r.x.push(car.pos.x);
    r.y.push(car.pos.y);
    r.z.push(car.pos.z);
    r.h.push(car.heading);
  }

  // returns true if this lap set a new session best for this track
  finishRecording(lapTime) {
    const r = this.recording;
    this.recording = null;
    if (!r || r.t.length < 10) return false;
    if (!this.best || lapTime < this.best.time) {
      this.best = { time: lapTime, t: r.t, x: r.x, y: r.y, z: r.z, h: r.h };
      this.bests[this.trackId] = this.best;
      if (!String(this.trackId).startsWith("random-")) { // random layouts are one-offs
        saveMem(`ghost-${this.trackId}`, { time: lapTime, t: r.t.map(q), x: r.x.map(q), y: r.y.map(q), z: r.z.map(q), h: r.h.map(q) });
      }
      return true;
    }
    return false;
  }

  startPlayback() {
    this.playT = 0;
    this.playing = !!this.best && this.enabled;
    this.mesh.visible = this.playing;
  }

  toggle() {
    this.enabled = !this.enabled;
    saveMem("ghost-enabled", this.enabled);
    if (!this.enabled) this.mesh.visible = false;
    else if (this.best && this.playing) this.mesh.visible = true;
    return this.enabled;
  }

  update(dt) {
    if (!this.playing || !this.best) return;
    this.playT += dt;
    const b = this.best;
    if (this.playT >= b.t[b.t.length - 1]) {
      this.playing = false;
      this.mesh.visible = false;
      return;
    }
    // binary search the frame window around playT
    let lo = 0, hi = b.t.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (b.t[mid] <= this.playT) lo = mid; else hi = mid;
    }
    const span = Math.max(b.t[hi] - b.t[lo], 1e-6);
    const f = Math.min(Math.max((this.playT - b.t[lo]) / span, 0), 1);
    const x = b.x[lo] + (b.x[hi] - b.x[lo]) * f;
    const y = b.y[lo] + (b.y[hi] - b.y[lo]) * f;
    const z = b.z[lo] + (b.z[hi] - b.z[lo]) * f;
    // shortest-arc angle interpolation
    let dh = b.h[hi] - b.h[lo];
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const h = b.h[lo] + dh * f;
    this.mesh.position.set(x, y, z);
    this.mesh.rotation.y = h;
  }
}
