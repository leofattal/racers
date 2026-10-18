// net.js — online play over WebRTC data channels, matched through Trystero.
// Trystero does peer discovery over public Nostr relays (no account, no
// server of ours) and then the game traffic is peer-to-peer, end-to-end
// encrypted. Everyone with the same invite code joins the same room; the
// host announces itself and guests talk only to the host.
//
// Topology: host-authoritative star. The host runs the whole simulation
// (its own car, every guest's car, the bots) from the guests' inputs and
// broadcasts compact snapshots; guests predict their own car locally and
// are corrected toward the host's version.
//
// Messages (plain objects on one action):
//   guest -> host : hello{name,car} · car{car} · input{...} · reset · ping
//   host -> guest : host · you{slot} · lobby{...} · start{...} · snap{...} · ev{...} · results{html} · menu · kick{reason}

import { joinRoom, selfId } from "trystero";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const APP_ID = "driftcircuit-v1";
export const MAX_PLAYERS = 4;

export function makeCode(len = 5) {
  let s = "";
  const rnd = new Uint8Array(len);
  (window.crypto || { getRandomValues: (a) => a.map(() => Math.random() * 256) }).getRandomValues(rnd);
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[rnd[i] % CODE_ALPHABET.length];
  return s;
}

export const netAvailable = () => typeof window !== "undefined" && typeof RTCPeerConnection === "function";

// STUN for direct connections; TURN relays (for strict NATs) come from the
// site's /api/turn endpoint when the operator has configured one.
export const RTC_CONFIG = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};
export const relayInfo = { loaded: false, source: "none", count: 0 };

// fetch relay servers once; tolerate static hosts with no /api (404, HTML)
export async function loadRelayServers(url = "/api/turn") {
  if (relayInfo.loaded) return relayInfo;
  relayInfo.loaded = true;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return relayInfo;
    const data = await r.json();
    const servers = Array.isArray(data.iceServers) ? data.iceServers.filter((s) => s && s.urls) : [];
    if (servers.length) {
      RTC_CONFIG.iceServers = [...RTC_CONFIG.iceServers, ...servers];
      relayInfo.source = data.source || "api";
      relayInfo.count = servers.length;
    }
  } catch (e) { /* no relay available: direct connections only */ }
  return relayInfo;
}

// "direct" | "relay" | "unknown": which path a live connection took
export async function linkType(conn) {
  try {
    const pc = conn && conn.peerConnection;
    if (!pc) return "unknown";
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((s) => { if (s.type === "candidate-pair" && (s.selected || s.nominated) && s.state === "succeeded") pair = s; });
    if (!pair) return "unknown";
    let local = null;
    stats.forEach((s) => { if (s.id === pair.localCandidateId) local = s; });
    return local && local.candidateType === "relay" ? "relay" : "direct";
  } catch (e) { return "unknown"; }
}

class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }
}

// a thin handle per remote peer so the rest of the game can ask whether it
// is open and read its RTCPeerConnection (link type, liveness)
class PeerConn {
  constructor(room, peerId) { this.room = room; this.peerId = peerId; this.open = true; }
  get peerConnection() { const peers = this.room.getPeers(); return peers ? peers[this.peerId] || null : null; }
}

function openRoom(code) {
  return joinRoom({ appId: APP_ID, rtcConfig: RTC_CONFIG }, `room-${code}`);
}

// ---------------------------------------------------------------------------
export class NetHost extends Emitter {
  constructor() {
    super();
    this.code = null;
    this.room = null;
    this.action = null;
    this.guests = new Map(); // peerId -> { conn, name, car, slot, input, lastSeen, link }
    this.open = false;
  }

  async start(code = makeCode()) {
    await loadRelayServers();
    this.code = code;
    const room = this.room = openRoom(code);
    this.action = room.makeAction("m");
    this.action.onMessage = (m, meta) => this._onMessage(m, meta && meta.peerId);
    // every arriving peer learns who the host is; guests reply with hello
    room.onPeerJoin = (peerId) => { this.action.send({ t: "host" }, { target: peerId }); };
    room.onPeerLeave = (peerId) => this._drop(peerId, "left");
    this.open = true;
    this.pruneTimer = setInterval(() => this.prune(), 2000);
    return code;
  }

  _onMessage(m, id) {
    if (!m || typeof m !== "object" || !id) return;
    let g = this.guests.get(id);
    if (m.t === "hello") {
      if (!g) {
        if (this.guests.size >= MAX_PLAYERS - 1) { this.action.send({ t: "kick", reason: "lobby full" }, { target: id }); return; }
        g = { conn: new PeerConn(this.room, id), name: "GUEST", car: "balanced", slot: this._freeSlot(), input: null, lastSeen: performance.now(), link: "" };
        this.guests.set(id, g);
      }
      g.name = String(m.name || "GUEST").slice(0, 10).toUpperCase() || "GUEST";
      g.car = m.car || "balanced";
      g.lastSeen = performance.now();
      // a refreshed guest comes back under a new peer id before the old
      // connection times out: drop the dead twin so its seat frees up
      for (const [oid, og] of this.guests) if (oid !== id && og.name === g.name && this._isDead(og)) this._drop(oid, "stale twin");
      this.action.send({ t: "you", slot: g.slot }, { target: id }); // first thing a guest learns: which seat is theirs
      this.emit("join", id, g);
      this.emit("lobbyChange");
      return;
    }
    if (!g) return;
    g.lastSeen = performance.now();
    switch (m.t) {
      case "car": g.car = m.car || "balanced"; this.emit("lobbyChange"); break;
      case "input": g.input = { steer: +m.s || 0, throttle: +m.g || 0, brake: +m.b || 0, handbrake: !!m.h }; break;
      case "reset": this.emit("reset", id); break;
      case "ping": break;
    }
  }

  _freeSlot() {
    const used = new Set([...this.guests.values()].map((g) => g.slot));
    for (let s = 1; s < MAX_PLAYERS; s++) if (!used.has(s)) return s;
    return MAX_PLAYERS - 1;
  }

  _drop(id, reason = "") {
    const g = this.guests.get(id);
    if (!g) return;
    console.warn(`[net] dropping ${g.name} (slot ${g.slot}): ${reason}`);
    g.conn.open = false;
    this.guests.delete(id);
    this.emit("leave", id);
  }

  // liveness comes from the transport, never from message cadence: a guest in
  // a background tab sends nothing for a long time and is still connected
  _isDead(g) {
    if (!g.conn.open) return true;
    const pc = g.conn.peerConnection;
    if (!pc) return performance.now() - g.lastSeen > 15000; // room no longer lists the peer
    const ice = pc.iceConnectionState;
    if (ice === "failed" || ice === "closed") return true;
    if (ice === "disconnected") { g.disconnectedSince = g.disconnectedSince || performance.now(); return performance.now() - g.disconnectedSince > 10000; }
    g.disconnectedSince = null;
    return false;
  }

  prune() {
    for (const [id, g] of [...this.guests]) if (this._isDead(g)) this._drop(id, "dead link");
  }

  send(id, msg) { const g = this.guests.get(id); if (g && g.conn.open) this.action.send(msg, { target: id }); }
  broadcast(msg) { for (const [id, g] of this.guests) if (g.conn.open) this.action.send(msg, { target: id }); }

  destroy() {
    clearInterval(this.pruneTimer);
    for (const g of this.guests.values()) g.conn.open = false;
    this.guests.clear();
    if (this.room) { try { this.room.leave(); } catch (e) { /* noop */ } }
    this.room = null;
    this.open = false;
  }
}

// ---------------------------------------------------------------------------
export class NetClient extends Emitter {
  constructor() {
    super();
    this.room = null;
    this.action = null;
    this.conn = null;        // PeerConn to the host
    this.hostId = null;
    this.code = null;
    this.connected = false;
    this.inputSeq = 0;
    this.mySlot = null;
  }

  async join(code, name, car) {
    await loadRelayServers();
    this.code = code.toUpperCase().trim();
    const room = this.room = openRoom(this.code);
    this.action = room.makeAction("m");
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => { if (settled) return; settled = true; this.destroy(); reject(err); };
      const timer = setTimeout(() => fail(new Error("no answer from that code")), 25000);
      this.action.onMessage = (m, meta) => {
        const from = meta && meta.peerId;
        if (!m || typeof m !== "object" || !from) return;
        if (m.t === "host" && !this.hostId) {
          // the host announced itself: this is who we talk to
          this.hostId = from;
          this.conn = new PeerConn(room, from);
          this.action.send({ t: "hello", name, car }, { target: from });
          return;
        }
        if (from !== this.hostId) return;
        if (m.t === "you") {
          this.mySlot = m.slot;
          if (!settled) { clearTimeout(timer); settled = true; this.connected = true; this.pingTimer = setInterval(() => this.send({ t: "ping" }), 1500); resolve(); }
        }
        this.emit("msg", m);
      };
      room.onPeerLeave = (peerId) => {
        if (peerId !== this.hostId) return;
        const was = this.connected;
        this.connected = false;
        if (this.conn) this.conn.open = false;
        if (was) this.emit("disconnect"); else fail(new Error("the host went away"));
      };
    });
  }

  send(msg) { if (this.connected && this.hostId && this.action) this.action.send(msg, { target: this.hostId }); }

  sendInput(inp) {
    this.send({ t: "input", q: ++this.inputSeq, s: +inp.steer.toFixed(3), g: +inp.throttle.toFixed(2), b: +inp.brake.toFixed(2), h: inp.handbrake ? 1 : 0 });
  }

  destroy() {
    clearInterval(this.pingTimer);
    if (this.room) { try { this.room.leave(); } catch (e) { /* noop */ } }
    if (this.conn) this.conn.open = false;
    this.room = null;
    this.action = null;
    this.connected = false;
  }
}

export { selfId };

// ---------------------------------------------------------------------------
// snapshot packing: one flat array per car keeps the 20 Hz stream small
export function packCar(id, car) {
  const p = car.prog || { total: 0, lap: 0, s: 0 };
  const flags = (car.drifting ? 1 : 0) | (car.grounded ? 2 : 0) | (car.finished ? 4 : 0) | (car.braking ? 8 : 0) | (car.wallHit ? 16 : 0);
  return [id, r2(car.pos.x), r2(car.pos.y), r2(car.pos.z), r3(car.heading), r2(car.vel.x), r2(car.vel.z), flags,
    r3(car.slipAngle), r1(p.total), p.lap, r1(p.s), Math.round(car.score), r2(car.combo), r2(car.boostFlash), r2(car.padBoost), r2(car.vy), r2(car.vLat)];
}
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

export function unpackCar(a) {
  return {
    id: a[0], x: a[1], y: a[2], z: a[3], heading: a[4], vx: a[5], vz: a[6],
    drifting: !!(a[7] & 1), grounded: !!(a[7] & 2), finished: !!(a[7] & 4), braking: !!(a[7] & 8), wallHit: !!(a[7] & 16),
    slip: a[8], total: a[9], lap: a[10], s: a[11], score: a[12], combo: a[13], boostFlash: a[14], padBoost: a[15], vy: a[16], vLat: a[17],
  };
}

// Apply a remote car's snapshot to a local Car used purely as a puppet:
// dead-reckon between snapshots, blend out the error on arrival.
export function applyRemote(car, snap, hard = false) {
  const dx = snap.x - car.pos.x, dz = snap.z - car.pos.z;
  const err = Math.hypot(dx, dz);
  if (hard || err > 4) { car.pos.set(snap.x, snap.y, snap.z); car.heading = snap.heading; }
  else { car.netCorr = { x: dx, y: snap.y - car.pos.y, z: dz }; }
  car.vel.set(snap.vx, 0, snap.vz);
  car.netHeading = snap.heading;
  car.drifting = snap.drifting;
  car.grounded = snap.grounded;
  car.finished = snap.finished;
  car.braking = snap.braking;
  car.wallHit = snap.wallHit;
  car.slipAngle = snap.slip;
  car.vLat = snap.vLat;
  car.vLong = Math.hypot(snap.vx, snap.vz);
  car.score = snap.score;
  car.combo = snap.combo;
  car.boostFlash = snap.boostFlash;
  car.padBoost = snap.padBoost;
  car.vy = snap.vy;
  if (!car.prog) car.prog = { s: 0, total: 0, lap: 0, gate: 1, lastGate: 0, gateHits: 0 };
  car.prog.total = snap.total; car.prog.lap = snap.lap; car.prog.s = snap.s;
}

// per-frame puppet motion between snapshots
export function stepRemote(car, dt) {
  car.pos.x += car.vel.x * dt;
  car.pos.z += car.vel.z * dt;
  if (car.netCorr) {
    const k = Math.min(1, 12 * dt);
    car.pos.x += car.netCorr.x * k; car.pos.y += car.netCorr.y * k; car.pos.z += car.netCorr.z * k;
    car.netCorr.x *= 1 - k; car.netCorr.y *= 1 - k; car.netCorr.z *= 1 - k;
  }
  if (car.netHeading !== undefined) {
    let dh = car.netHeading - car.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    car.heading += dh * Math.min(1, 14 * dt);
  }
  car.boostFlash = Math.max(0, car.boostFlash - dt);
  car.syncMesh(dt);
}
