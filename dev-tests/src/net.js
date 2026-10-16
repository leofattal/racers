// net.js — online play over WebRTC data channels. PeerJS (loaded as a
// classic script in index.html, exposing window.Peer) handles signalling
// through its public broker; after that, traffic is peer-to-peer.
//
// Topology: host-authoritative star. The host runs the whole simulation
// (its own car, every guest's car, the bots) from the guests' inputs and
// broadcasts compact snapshots; guests predict their own car locally and
// are corrected toward the host's version. Invite code = the host's peer id.
//
// Messages (JSON):
//   guest -> host : hello{name,car} · car{car} · input{...} · reset
//   host -> guest : lobby{...} · start{...} · snap{...} · ev{...} · results{html} · menu · kick{reason}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const PREFIX = "driftcircuit-";
export const MAX_PLAYERS = 4;

export function makeCode(len = 5) {
  let s = "";
  const rnd = new Uint8Array(len);
  (window.crypto || { getRandomValues: (a) => a.map(() => Math.random() * 256) }).getRandomValues(rnd);
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[rnd[i] % CODE_ALPHABET.length];
  return s;
}

export const netAvailable = () => typeof window !== "undefined" && !!window.Peer;

// PeerJS ships STUN only; without a relay two players behind strict home or
// mobile NATs never connect (the join just times out). Open Relay is a free
// public TURN service; the game falls back to it when a direct path fails.
export const PEER_OPTIONS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
      { urls: "stun:openrelay.metered.ca:80" },
      { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
      { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
      { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
    ],
  },
};

class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }
}

// ---------------------------------------------------------------------------
export class NetHost extends Emitter {
  constructor() {
    super();
    this.code = null;
    this.peer = null;
    this.guests = new Map(); // peerId -> { conn, name, car, slot, input, lastSeen }
    this.open = false;
  }

  start(code = makeCode()) {
    return new Promise((resolve, reject) => {
      this.code = code;
      this.pruneTimer = setInterval(() => this.prune(), 2000);
      const peer = this.peer = new window.Peer(PREFIX + code, PEER_OPTIONS);
      const fail = (err) => { this.destroy(); reject(err); };
      peer.on("open", () => { this.open = true; resolve(code); });
      peer.on("error", (err) => {
        if (!this.open) fail(err); else this.emit("error", err);
      });
      peer.on("connection", (conn) => this._accept(conn));
      peer.on("disconnected", () => { try { peer.reconnect(); } catch (e) { /* noop */ } });
    });
  }

  _accept(conn) {
    const id = conn.peer;
    conn.on("open", () => {
      if (this.guests.size >= MAX_PLAYERS - 1) { conn.send({ t: "kick", reason: "lobby full" }); setTimeout(() => conn.close(), 200); return; }
      const g = { conn, name: "GUEST", car: "balanced", slot: this._freeSlot(), input: null, lastSeen: performance.now() };
      this.guests.set(id, g);
      conn.send({ t: "you", slot: g.slot }); // first thing a guest learns: which seat is theirs
      this.emit("join", id, g);
    });
    conn.on("data", (m) => {
      const g = this.guests.get(id);
      if (!g || !m || typeof m !== "object") return;
      g.lastSeen = performance.now();
      switch (m.t) {
        case "hello":
          g.name = String(m.name || "GUEST").slice(0, 10).toUpperCase() || "GUEST"; g.car = m.car || "balanced";
          // a refreshed guest comes back under a new peer id before the old
          // connection times out: drop the dead twin so its seat frees up
          for (const [oid, og] of this.guests) if (oid !== id && og.name === g.name && this._isDead(og)) this._drop(oid, "stale twin");
          this.emit("lobbyChange");
          break;
        case "ping": break;
        case "car": g.car = m.car || "balanced"; this.emit("lobbyChange"); break;
        case "input": g.input = { steer: +m.s || 0, throttle: +m.g || 0, brake: +m.b || 0, handbrake: !!m.h }; break;
        case "reset": this.emit("reset", id); break;
      }
    });
    conn.on("close", () => this._drop(id, "closed"));
    conn.on("error", (e) => this._drop(id, "error: " + (e && (e.type || e.message) || e)));
  }

  _drop(id, reason = "") {
    const g = this.guests.get(id);
    if (!g) return;
    console.warn(`[net] dropping ${g.name} (slot ${g.slot}): ${reason}`);
    this.guests.delete(id);
    try { g.conn.close(); } catch (e) { /* noop */ }
    this.emit("leave", id);
  }

  // liveness comes from the transport, never from message cadence: a guest in
  // a background tab sends nothing for a long time and is still connected
  _isDead(g) {
    if (!g.conn.open) return true;
    const pc = g.conn.peerConnection;
    const ice = pc ? pc.iceConnectionState : "connected";
    if (ice === "failed" || ice === "closed") return true;
    if (ice === "disconnected") { g.disconnectedSince = g.disconnectedSince || performance.now(); return performance.now() - g.disconnectedSince > 10000; }
    g.disconnectedSince = null;
    return false;
  }

  // dead links (closed laptop, lost network) are pruned so their seat frees up
  prune() {
    for (const [id, g] of [...this.guests]) if (this._isDead(g)) this._drop(id, `dead link (${g.conn.open ? g.conn.peerConnection?.iceConnectionState : "channel closed"})`);
  }

  _freeSlot() {
    const used = new Set([...this.guests.values()].map((g) => g.slot));
    for (let s = 1; s < MAX_PLAYERS; s++) if (!used.has(s)) return s;
    return MAX_PLAYERS - 1;
  }

  send(id, msg) { const g = this.guests.get(id); if (g && g.conn.open) g.conn.send(msg); }
  broadcast(msg) { for (const g of this.guests.values()) if (g.conn.open) g.conn.send(msg); }

  destroy() {
    clearInterval(this.pruneTimer);
    for (const g of this.guests.values()) { try { g.conn.close(); } catch (e) { /* noop */ } }
    this.guests.clear();
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* noop */ } }
    this.peer = null;
    this.open = false;
  }
}

// ---------------------------------------------------------------------------
export class NetClient extends Emitter {
  constructor() {
    super();
    this.peer = null;
    this.conn = null;
    this.code = null;
    this.connected = false;
    this.inputSeq = 0;
  }

  join(code, name, car) {
    return new Promise((resolve, reject) => {
      this.code = code.toUpperCase().trim();
      this.mySlot = null;
      const peer = this.peer = new window.Peer(undefined, PEER_OPTIONS);
      let settled = false;
      const fail = (err) => { if (settled) return; settled = true; this.destroy(); reject(err); };
      const timer = setTimeout(() => fail(new Error("no answer from that code (host offline, or the connection could not be established)")), 20000);
      peer.on("error", (err) => { if (!settled) fail(err); else this.emit("error", err); });
      peer.on("open", () => {
        const conn = this.conn = peer.connect(PREFIX + this.code, { reliable: true, serialization: "json" });
        conn.on("open", () => {
          clearTimeout(timer);
          settled = true;
          this.connected = true;
          conn.send({ t: "hello", name, car });
          this.pingTimer = setInterval(() => this.send({ t: "ping" }), 1500);
          resolve();
        });
        // the seat assignment is handled here so it is never lost to handler
        // ordering: it arrives before the lobby roster and before any start
        conn.on("data", (m) => {
          if (!m || typeof m !== "object") return;
          if (m.t === "you") this.mySlot = m.slot;
          this.emit("msg", m);
        });
        const gone = () => { const was = this.connected; this.connected = false; if (was) this.emit("disconnect"); else fail(new Error("could not reach host")); };
        conn.on("close", gone);
        conn.on("error", gone);
      });
    });
  }

  send(msg) { if (this.conn && this.conn.open) this.conn.send(msg); }

  sendInput(inp) {
    this.send({ t: "input", q: ++this.inputSeq, s: +inp.steer.toFixed(3), g: +inp.throttle.toFixed(2), b: +inp.brake.toFixed(2), h: inp.handbrake ? 1 : 0 });
  }

  destroy() {
    clearInterval(this.pingTimer);
    if (this.conn) { try { this.conn.close(); } catch (e) { /* noop */ } }
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* noop */ } }
    this.conn = null;
    this.peer = null;
    this.connected = false;
  }
}

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
