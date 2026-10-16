// main.js — entry point: renderer/scene setup, race state machine
// (menu -> [lobby] -> countdown -> racing -> finished, with pause), local
// one/two-player (split-screen) and online play (host-authoritative over
// WebRTC, see net.js), and the game loop that owns all updates.
import * as THREE from "three";
import { Car, resolveCarContacts, CONFIG, CAR_CLASSES } from "./car.js";
import { Keyboard } from "./input.js";
import { Track, TRACKS, makeRandomTrack, LapCounter } from "./track.js";
import { ChaseCam } from "./camera.js";
import { AIDriver, AI_TIERS, finishCars } from "./ai.js";
import { GhostSystem } from "./ghost.js";
import { PlayerHUD, SharedHUD } from "./hud.js";
import { AudioSys } from "./audio.js";
import { Particles } from "./particles.js";
import { SkidMarks } from "./skidmarks.js";
import { Environment, makeLabel } from "./env.js";
import { loadCarModel, applyCarModel } from "./models.js";
import { NetHost, NetClient, netAvailable, packCar, unpackCar, applyRemote, stepRemote, MAX_PLAYERS } from "./net.js";
import { loadMem, saveMem } from "./memory.js";
import { Inline3D } from "./xr.js";
import { Hazards } from "./hazards.js";

// --- debug flags (URL query): ?norender skips drawing, ?autopilot lets the AI
// drive the human seats. Both exist so a full race can run headlessly in tests.
const DEBUG = new URLSearchParams(location.search);
const NORENDER = DEBUG.has("norender");
const AUTOPILOT = DEBUG.has("autopilot");

// --- settings (persisted) ---------------------------------------------------
const DIFFICULTY = { easy: 0.9, normal: 1.0, hard: 1.14 };
let LAPS = loadMem("laps", 3);
let difficulty = loadMem("difficulty", "normal");
if (!(difficulty in DIFFICULTY)) difficulty = "normal";
let numPlayers = loadMem("players", 1) === 2 ? 2 : 1;
let carChoice = loadMem("cars", ["balanced", "balanced"]);
if (!Array.isArray(carChoice) || carChoice.length !== 2) carChoice = ["balanced", "balanced"];
let myName = String(loadMem("name", "") || "").toUpperCase().slice(0, 10);
let hazardsOn = loadMem("hazards", true) !== false; // local setting (host / local races)
let hostHazards = true;      // online guest: the host's choice, from its "start" message
const classById = (id) => CAR_CLASSES.find((c) => c.id === id) || CAR_CLASSES[0];

// --- renderer / scene -------------------------------------------------------
const canvas = document.getElementById("game-canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
// glasses-free stereo on a DisplayXR display; inert (no download) elsewhere
const stereo = new Inline3D();

// --- world ------------------------------------------------------------------
let track = null;
const env = new Environment(scene, renderer);
const shared = new SharedHUD();
const keyboard = new Keyboard();
const audio = new AudioSys();
const ghost = new GhostSystem(scene);
const particles = new Particles(scene);
const skids = new SkidMarks(scene);
const hazards = new Hazards(scene);
const ERUPT_TINT = new THREE.Color(0xff3a10);
let sunTinted = false;
const colorHex = (c) => "#" + c.toString(16).padStart(6, "0");

// a human seat: car + lap bookkeeping (+ remote id when online)
const PLAYER_COLORS = [0x39a0ff, 0xff4fa3, 0xffd34d, 0x67f0ff];
class Player {
  constructor(slot) {
    this.slot = slot;
    this.name = `P${slot + 1}`;
    this.car = new Car(scene, PLAYER_COLORS[slot], this.name);
    this.car.netId = `h${slot}`;
    this.remoteId = null;      // online: the guest's peer id (host side)
    this.label = makeLabel(this.name, colorHex(this.car.color));
    if (this.label) { this.label.position.set(0, 2.0, 0); this.label.visible = false; this.car.mesh.add(this.label); }
    this.resetRace();
  }
  setName(n) {
    this.name = n;
    if (this.label) { this.label.parent.remove(this.label); }
    this.label = makeLabel(n, colorHex(this.car.color));
    if (this.label) { this.label.position.set(0, 2.0, 0); this.car.mesh.add(this.label); }
  }
  resetRace() {
    this.lapBegin = false;    // crossed the line once: lap 1 under way
    this.lapStartT = 0;
    this.lastLap = null;
    this.lapsCounted = 0;     // completed laps credited so far (mirrors this.laps.laps)
    this.laps = track ? new LapCounter(track) : null;
    this.finished = false;
    this.wrongWayT = 0;
    this.prevGrounded = true;
  }
}
// a local screen: camera + chase cam + HUD, pointed at one player
class View {
  constructor(slot) {
    this.slot = slot;
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2000);
    this.cam = new ChaseCam(this.camera);
    this.hud = new PlayerHUD(slot);
    this.player = null;
  }
}
const players = Array.from({ length: MAX_PLAYERS }, (_, i) => new Player(i));
const views = [new View(0), new View(1)];
let humans = [players[0]];     // seats racing right now (local + remote)
let locals = [];               // [{player, view}] driven from this machine
const aiCars = AI_TIERS.map((t, i) => { const c = new Car(scene, t.color, t.name); c.netId = `ai${i}`; return c; });
const ais = aiCars.map((c, i) => new AIDriver(c, null, AI_TIERS[i]));
for (const c of aiCars) {
  const label = makeLabel(c.name, colorHex(c.color));
  if (label) { label.position.set(0, 2.0, 0); c.mesh.add(label); }
}
const allCars = [...players.map((p) => p.car), ...aiCars];
const carById = Object.fromEntries(allCars.map((c) => [c.netId, c]));
let cars = [];                 // cars in the current race (humans first, then bots)
const bests = Object.create(null); // per-track best lap times (session memory)

// real car model (optional): swap every car's procedural body for the glTF
loadCarModel().then((tpl) => {
  for (const c of allCars) applyCarModel(c.mesh, tpl, c.color);
  console.log("car model loaded");
}).catch((e) => console.warn("car model unavailable, keeping procedural cars", e));
window.addEventListener("keydown", () => audio.ensure(), { once: false });
window.addEventListener("pointerdown", () => audio.ensure(), { once: false });

function resize() {
  if (stereo.woven) { stereo.resize(); return; } // the side-by-side store is sized there
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  for (const v of views) {
    v.camera.aspect = locals.length === 2 ? w / (h / 2) : w / h;
    v.camera.updateProjectionMatrix();
  }
}
window.addEventListener("resize", resize);

// --- race / net state --------------------------------------------------------
let state = "menu";            // menu | lobby | countdown | racing | finished | paused
let mode = "local";            // local | host | client
let net = null;                // NetHost or NetClient
let lobbyPlayers = [];         // client-side copy of the lobby roster
let countdownT = 3.0;
let raceTime = 0;
let trackIndex = loadMem("track", 0);
let randomDef = null;          // the current randomly generated layout (index TRACKS.length)
const RANDOM_INDEX = TRACKS.length;
const defAt = (i) => (i === RANDOM_INDEX ? randomDef : TRACKS[i]);
let finishOrder = [];          // cars in the order they completed the race
let lastTick = 0;              // last countdown digit that beeped
let hintT = 0;                 // seconds of racing; the controls hint fades after a while
let snapAcc = 0;               // host: time since the last snapshot
let lastSnapAt = 0;            // client: performance.now() of the last snapshot
let finishDeadline = null;     // raceTime by which everyone else must finish once someone has
const FINISH_GRACE_S = 60;
let netStatus = "";

const ordinal = (n) => n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th");
const humanName = (pl) => (mode === "local" && numPlayers === 1 ? "YOU" : pl.name);
const carName = (car) => { const pl = players.find((p) => p.car === car); return pl ? humanName(pl) : car.name; };
const isOnline = () => mode !== "local";
const localCount = () => (mode === "local" ? numPlayers : 1);

// --- hazards (earthquakes / eruptions) ------------------------------------
const hazardsEnabled = () => (mode === "client" ? hostHazards : hazardsOn);
const hazardCtx = {
  kickCams: (amount) => { for (const l of locals) l.view.cam.kick(amount); },
  flash: (text, seconds) => { for (const l of locals) l.view.hud.flashMsg(text, seconds); },
  sfx: (name, arg) => audio.sfx(name, arg),
  particles,
  leaderCars: null,
};
// eruption: pulse the sun toward lava red (restored once the glow is gone)
function tintSky() {
  if (!env.sun || !env.palette) return;
  if (hazards.glow > 0.001) {
    env.sun.color.setHex(env.palette.sun).lerp(ERUPT_TINT, hazards.glow * 0.55);
    sunTinted = true;
  } else if (sunTinted) {
    env.sun.color.setHex(env.palette.sun);
    sunTinted = false;
  }
}

// apply the menu/lobby choices: who is racing, which car class, screen layout
function applySettings() {
  if (mode === "local") {
    humans = players.slice(0, numPlayers);
    players[0].setName("P1"); players[1].setName("P2");
    locals = humans.map((p, i) => ({ player: p, view: views[i] }));
  } else if (mode === "host") {
    const guests = [...net.guests.values()].sort((a, b) => a.slot - b.slot);
    humans = [players[0], ...guests.map((g) => players[g.slot])];
    players[0].setName(myName || "HOST");
    players[0].remoteId = null;
    for (const g of guests) { players[g.slot].setName(g.name); players[g.slot].remoteId = [...net.guests.keys()].find((k) => net.guests.get(k) === g); }
    locals = [{ player: players[0], view: views[0] }];
  } else { // client: roster came from the host
    humans = lobbyPlayers.map((lp) => { const p = players[lp.slot]; p.setName(lp.name); return p; }).sort((a, b) => a.slot - b.slot);
    const me = players[net.mySlot] || players[1];
    if (!humans.includes(me)) humans.push(me); // roster not in yet: still watch my own seat
    locals = [{ player: me, view: views[0] }];
  }
  cars = [...humans.map((p) => p.car), ...aiCars];
  document.body.classList.toggle("split", locals.length === 2);
  for (const v of views) { v.player = null; v.hud.setVisible(false); }
  for (const l of locals) { l.view.player = l.player; l.view.hud.setVisible(true); }
  for (const p of players) {
    const active = humans.includes(p);
    p.car.mesh.visible = active;
    if (p.car.shadow) p.car.shadow.visible = active;
    if (p.label) p.label.visible = humans.length > 1;
    let cls = "balanced";
    if (mode === "local") cls = carChoice[p.slot] || "balanced";
    else if (mode === "host") cls = p.slot === 0 ? carChoice[0] : ((p.remoteId && net.guests.get(p.remoteId)) || {}).car || "balanced";
    else { const lp = lobbyPlayers.find((x) => x.slot === p.slot); cls = lp ? lp.car : "balanced"; }
    const c = classById(cls);
    p.car.tuning = { engine: c.engine, topSpeed: c.topSpeed };
  }
  for (const ai of ais) ai.setSkill(DIFFICULTY[difficulty]);
  const padHint = `<b>Pad</b> stick steer &nbsp; R2/RT gas &nbsp; L2/LT brake &nbsp; ✕/A handbrake &nbsp; Options/Start pause`;
  views[0].hud.setHint(locals.length === 1
    ? `<b>WASD / Arrows</b> drive &nbsp; <b>Space</b> handbrake &nbsp; <b>S</b> airbrake<br>` +
      `<b>R</b> reset &nbsp; <b>L</b> line &nbsp; <b>G</b> ghost &nbsp; <b>Esc</b> ${isOnline() ? "menu" : "pause"}<br>${padHint}`
    : `<b>WASD</b> drive &nbsp; <b>Space</b> handbrake &nbsp; <b>R</b> reset &nbsp; <b>Esc</b> pause`);
  views[1].hud.setHint(`<b>Arrows</b> drive &nbsp; <b>Right Shift</b> handbrake &nbsp; <b>Backspace</b> reset &nbsp; or gamepad`);
  resize();
  syncStereo();
}

function placeOnGrid() {
  cars.forEach((car, i) => {
    const row = Math.floor(i / 2);
    const lat = (i % 2 === 0 ? -1 : 1) * 2.6;
    const pose = track.poseFor(track.length - 16 - row * 8, lat);
    car.place(pose.x, pose.z, pose.heading, pose.y);
    track.initProgress(car);
    car.netProg = { total: car.prog.total, lap: 0, s: car.prog.s };
  });
  for (const l of locals) l.view.cam.snapTo(l.player.car);
}

function restartRace() {
  applySettings();
  state = "countdown";
  countdownT = 3.0;
  raceTime = 0;
  finishOrder = [];
  lastTick = 0;
  hintT = 0;
  snapAcc = 0;
  finishDeadline = null;
  lastSnapAt = performance.now();
  for (const p of players) { p.resetRace(); }
  for (const v of views) v.hud.elHint.style.opacity = "1";
  for (const c of allCars) { c.score = 0; c.finished = false; c.netCorr = null; }
  for (const c of aiCars) { c.mesh.visible = true; if (c.shadow) c.shadow.visible = true; }
  placeOnGrid();
  skids.clear();
  ghost.setTrack(track.id);
  hazards.setTrack(track, hazardsEnabled());
  tintSky();
  shared.hideFinish();
  shared.hideMenu();
  shared.hideLobby();
  pausePanel.style.display = "none";
  track.setStartLights(0);
  for (const l of locals) l.view.hud.flashMsg(track.name, 1.2);
}

function loadTrackDef(def) {
  if (track) track.dispose(scene);
  track = new Track(scene, def);
  env.build(track);
  sunTinted = false;
  hazards.setTrack(track, hazardsEnabled());
  for (const ai of ais) ai.track = track;
  ghost.setTrack(track.id);
  shared.setTrack(track.outline(), track.name);
  track.lineMesh.visible = loadMem("racing-line", true);
  if (!(track.id in bests)) bests[track.id] = loadMem(`bestlap-${track.id}`, null);
  skids.clear();
  applySettings();
  placeOnGrid();
  track.setStartLights(0);
}

function loadTrack(i) {
  const count = TRACKS.length + 1; // + the random slot
  trackIndex = ((i % count) + count) % count;
  saveMem("track", trackIndex);
  if (trackIndex === RANDOM_INDEX) randomDef = makeRandomTrack(); // every visit rolls a new layout
  loadTrackDef(defAt(trackIndex));
}

// --- menu ----------------------------------------------------------------
const menuOutlines = TRACKS.map((def) => new Track(null, def, false).outline());
function showMenu() {
  state = mode === "client" ? "lobby" : (mode === "host" ? "lobby" : "menu");
  shared.hideFinish();
  pausePanel.style.display = "none";
  for (const c of aiCars) { c.finished = false; c.mesh.visible = true; if (c.shadow) c.shadow.visible = true; }
  applySettings();
  for (const v of views) v.hud.setVisible(false);
  placeOnGrid();
  hazards.reset();
  tintSky();
  const randomOutline = randomDef ? new Track(null, randomDef, false).outline() : null;
  const carItems = CAR_CLASSES.map((c) => [c.name, c.id]);
  const options = [];
  if (mode === "local") {
    options.push({ key: "players", label: "PLAYERS", items: [["1", 1], ["2 SPLIT", 2]], value: numPlayers });
  }
  if (mode !== "client") {
    options.push({ key: "difficulty", label: "DIFFICULTY", items: [["EASY", "easy"], ["NORMAL", "normal"], ["HARD", "hard"]], value: difficulty });
    options.push({ key: "laps", label: "LAPS", items: [["1", 1], ["3", 3], ["5", 5]], value: LAPS });
    options.push({ key: "hazards", label: "HAZARDS", items: [["ON", true], ["OFF", false]], value: hazardsOn });
  }
  options.push({ key: "car0", label: mode === "local" && numPlayers === 2 ? "P1 CAR" : "CAR", items: carItems, value: carChoice[0] });
  if (mode === "local" && numPlayers === 2) options.push({ key: "car1", label: "P2 CAR", items: carItems, value: carChoice[1], cls: "p2" });
  const blurb = CAR_CLASSES.map((c) => `${c.name}: ${c.blurb}`).join("   ·   ");
  shared.showMenu({
    tracks: [
      ...TRACKS.map((def, i) => ({ id: def.id, name: def.name, outline: menuOutlines[i], best: loadMem(`bestlap-${def.id}`, null) })),
      { id: "random", name: randomDef ? randomDef.name : "RANDOM", outline: randomOutline, best: null, random: true },
    ],
    trackIndex, options, blurb,
    onTrack: (i) => { if (mode === "client") return; if (i !== trackIndex || i === RANDOM_INDEX) loadTrack(i); showMenu(); },
    onOption: (key, value) => {
      if (key === "players") { numPlayers = value; saveMem("players", value); }
      else if (key === "difficulty") { difficulty = value; saveMem("difficulty", value); }
      else if (key === "laps") { LAPS = value; saveMem("laps", value); }
      else if (key === "hazards") { hazardsOn = !!value; saveMem("hazards", hazardsOn); }
      else if (key === "car0") { carChoice[0] = value; saveMem("cars", carChoice); if (mode === "client") net.send({ t: "car", car: value }); }
      else if (key === "car1") { carChoice[1] = value; saveMem("cars", carChoice); }
      showMenu();
    },
    onRace: () => { audio.ensure(); startRace(); },
    raceLabel: mode === "client" ? "WAITING FOR THE HOST TO START…" : mode === "host" ? "START ONLINE RACE&nbsp;&nbsp;[ENTER]" : undefined,
    raceDisabled: mode === "client",
  });
  shared.setOnlineStatus(netStatus, netStatus.startsWith("!"));
  if (isOnline()) renderLobby();
  if (mode === "host") broadcastLobby();
}

// RACE pressed (menu) / START pressed (lobby)
function startRace() {
  if (mode === "client") return;
  if (mode === "host") {
    const def = track.def;
    const roster = rosterFor();
    for (const [id, g] of net.guests) net.send(id, { t: "start", def, laps: LAPS, difficulty, hazards: hazardsOn, players: roster, you: g.slot });
  }
  restartRace();
}

// --- online: lobby --------------------------------------------------------
function rosterFor() {
  const list = [{ slot: 0, name: myName || "HOST", car: carChoice[0], host: true }];
  if (mode === "host") for (const g of net.guests.values()) list.push({ slot: g.slot, name: g.name, car: g.car, host: false });
  return list;
}

function renderLobby() {
  const roster = mode === "host" ? rosterFor() : lobbyPlayers;
  const mySlot = mode === "host" ? 0 : net.mySlot;
  shared.showLobby({
    code: net && net.code,
    isHost: mode === "host",
    players: roster.map((p) => ({ name: p.name, color: colorHex(PLAYER_COLORS[p.slot]), car: classById(p.car).name, host: p.host, me: p.slot === mySlot })),
    note: mode === "host"
      ? `Share the code. Pick track, laps and difficulty in the menu behind, then START. ${roster.length}/${MAX_PLAYERS} racers.`
      : `${net.hostTrack || "Host is picking the track"} · ${net.hostLaps || LAPS} laps · pick your CAR in the menu. Waiting for the host to start…`,
    onStart: () => { audio.ensure(); startRace(); },
    onLeave: () => leaveOnline("left the lobby"),
  });
}

function broadcastLobby() {
  if (mode !== "host") return;
  net.broadcast({ t: "lobby", code: net.code, players: rosterFor(), track: track.name, laps: LAPS });
}

async function hostLobby(name) {
  if (!netAvailable()) { netStatus = "!online play needs the PeerJS script (no network?)"; shared.setOnlineStatus(netStatus, true); return; }
  if (name) { myName = name.toUpperCase().slice(0, 10); saveMem("name", myName); }
  leaveOnline();
  const host = new NetHost();
  shared.setOnlineStatus("opening lobby…");
  try {
    await host.start();
  } catch (e) {
    netStatus = "!could not open a lobby: " + (e.type || e.message || e);
    shared.setOnlineStatus(netStatus, true);
    return;
  }
  net = host;
  mode = "host";
  netStatus = `hosting · code ${host.code}`;
  host.on("join", (id, g) => { renderLobby(); broadcastLobby(); views[0].hud.flashMsg(`${g.name} JOINED`, 1.5); })
    .on("lobbyChange", () => { if (state === "lobby") { applySettings(); renderLobby(); } broadcastLobby(); })
    .on("leave", (id) => {
      const p = players.find((x) => x.remoteId === id);
      if (p && state !== "lobby") {
        p.finished = true; p.car.finished = true; p.car.mesh.visible = false; if (p.car.shadow) p.car.shadow.visible = false;
        views[0].hud.flashMsg(`${p.name} LEFT`, 1.5);
        if (state === "racing" && humans.every((h) => h.finished)) endRace();
      }
      if (state === "lobby") { applySettings(); renderLobby(); placeOnGrid(); }
      broadcastLobby();
    })
    .on("reset", (id) => { const p = players.find((x) => x.remoteId === id); if (p && state === "racing") resetToCheckpoint(p); })
    .on("error", (e) => console.warn("net", e));
  showMenu();
}

async function joinLobby(code, name) {
  if (!netAvailable()) { netStatus = "!online play needs the PeerJS script (no network?)"; shared.setOnlineStatus(netStatus, true); return; }
  if (!code || code.length < 4) { shared.setOnlineStatus("enter the 5-letter invite code", true); return; }
  if (name) { myName = name.toUpperCase().slice(0, 10); saveMem("name", myName); }
  leaveOnline();
  const client = new NetClient();
  shared.setOnlineStatus(`joining ${code.toUpperCase()}…`);
  const queued = []; // messages that arrive before we are fully in client mode
  client.on("msg", (m) => { if (mode === "client" && net === client) onHostMessage(m); else queued.push(m); })
    .on("disconnect", () => { if (net === client) leaveOnline("host left"); });
  try {
    await client.join(code, myName || "GUEST", carChoice[0]);
  } catch (e) {
    netStatus = "!could not join: " + (e.type === "peer-unavailable" ? "no lobby with that code" : (e.message || e));
    shared.setOnlineStatus(netStatus, true);
    return;
  }
  net = client;
  mode = "client";
  if (net.mySlot == null) net.mySlot = 1;
  netStatus = `joined ${client.code}`;
  showMenu();
  for (const m of queued) onHostMessage(m);
}

function leaveOnline(reason) {
  if (net) { net.destroy(); net = null; }
  if (mode !== "local") {
    mode = "local";
    netStatus = reason ? `!${reason}` : "";
    lobbyPlayers = [];
    for (const p of players) p.remoteId = null;
    shared.hideLobby();
    showMenu();
  }
}

// --- online: client side ----------------------------------------------------
function onHostMessage(m) {
  switch (m.t) {
    case "lobby":
      lobbyPlayers = m.players;
      net.code = m.code;
      net.hostTrack = m.track;
      net.hostLaps = m.laps;
      if (state === "lobby") { applySettings(); renderLobby(); }
      break;
    case "you":
      net.mySlot = m.slot;
      if (state === "lobby") { applySettings(); renderLobby(); }
      break;
    case "kick":
      leaveOnline(m.reason || "removed by host");
      break;
    case "start": {
      lobbyPlayers = m.players;
      if (typeof m.you === "number") net.mySlot = m.you; // my seat, carried with the start itself
      LAPS = m.laps;
      difficulty = m.difficulty;
      hostHazards = m.hazards !== false; // older hosts omit it: on
      const def = m.def;
      loadTrackDef(def);
      restartRace();
      break;
    }
    case "snap":
      if (state === "lobby" || state === "menu") break;
      applySnapshot(m);
      break;
    case "ev":
      onClientEvent(m);
      break;
    case "results":
      state = "finished";
      shared.showFinish(m.html);
      break;
    case "menu":
      if (state !== "lobby") { showMenu(); }
      break;
  }
}

function onClientEvent(m) {
  const me = locals[0].player;
  const hud = views[0].hud;
  if (m.kind === "begin") { me.lapBegin = true; me.lapStartT = raceTime; }
  else if (m.kind === "lap" || m.kind === "best") {
    me.lastLap = m.lapTime; me.lapStartT = raceTime; me.lapsCounted = m.lap;
    if (!bests[track.id] || m.lapTime < bests[track.id]) { bests[track.id] = m.lapTime; if (!track.def.random) saveMem(`bestlap-${track.id}`, m.lapTime); }
    hud.flashMsg(m.kind === "best" ? `NEW BEST ${shared.fmtTime(m.lapTime)}` : `LAP ${m.lap + 1} — ${shared.fmtTime(m.lapTime)}`);
    audio.sfx(m.kind === "best" ? "best" : "lap");
  } else if (m.kind === "finish") {
    me.finished = true; me.lastLap = m.lapTime;
    hud.flashMsg(`FINISHED ${ordinal(m.pos)}`, 2.5);
    audio.sfx("finish");
  }
}

function applySnapshot(m) {
  lastSnapAt = performance.now();
  const prev = state;
  if (m.state === "countdown" || m.state === "racing") state = m.state;
  countdownT = m.cd;
  raceTime = m.rt;
  if (prev === "countdown" && state === "racing") { views[0].hud.flashMsg("GO!", 0.9); audio.sfx("go"); track.setStartLights(5, true); }
  if (state === "racing" && raceTime > 2.5) track.setStartLights(0);
  const me = locals[0].player.car;
  finishOrder = (m.fin || []).map((id) => carById[id]).filter(Boolean);
  for (const a of m.cars) {
    const snap = unpackCar(a);
    const car = carById[snap.id];
    if (!car) continue;
    car.netProg = { total: snap.total, lap: snap.lap, s: snap.s };
    if (car === me) {
      // prediction correction: snap on big error, blend small ones
      const err = Math.hypot(snap.x - car.pos.x, snap.z - car.pos.z);
      if (err > 3) { car.pos.set(snap.x, snap.y, snap.z); car.vel.set(snap.vx, 0, snap.vz); car.heading = snap.heading; }
      else car.netCorr = { x: (snap.x - car.pos.x) * 0.5, y: 0, z: (snap.z - car.pos.z) * 0.5 };
      car.score = snap.score; car.combo = snap.combo; car.finished = snap.finished;
      if (snap.boostFlash > car.boostFlash + 0.3) car.boostFlash = snap.boostFlash;
    } else {
      applyRemote(car, snap);
      car.mesh.visible = !snap.finished && cars.includes(car);
      if (car.shadow) car.shadow.visible = car.mesh.visible;
    }
  }
}

// --- lap handling ------------------------------------------------------
function finishPlayer(pl, lapTime) {
  pl.finished = true;
  pl.car.finished = true;
  finishOrder.push(pl.car);
  const pos = finishOrder.length;
  const local = locals.find((l) => l.player === pl);
  if (local) { local.view.hud.flashMsg(`FINISHED ${ordinal(pos)}`, 2.5); if (local.view.slot === 0) audio.sfx("finish"); }
  if (mode === "host" && pl.remoteId) net.send(pl.remoteId, { t: "ev", kind: "finish", lapTime, pos });
  if (!humans.every((h) => h.finished)) {
    // the rest get a grace period, then the race is called with DNFs
    if (finishDeadline == null) finishDeadline = raceTime + FINISH_GRACE_S;
    return;
  }
  endRace();
}

// everyone home (or out of time): results for all
function endRace() {
  if (state === "finished") return;
  // everyone home: results
  state = "finished";
  const rest = cars.filter((c) => !finishOrder.includes(c)).sort((a, b) => b.prog.total - a.prog.total);
  const standings = [...finishOrder, ...rest].map((c, i) => {
    const me = humans.some((h) => h.car === c);
    return `<span style="color:${me ? "#ffd34d" : "#cfe0f2"}"><span style="display:inline-block;width:36px">${ordinal(i + 1)}</span>` +
      `<i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${colorHex(c.color)};margin-right:8px"></i>` +
      `${carName(c)}${c.finished || me ? "" : " <span style='color:#7a8ba0'>(DNF)</span>"}</span>`;
  }).join("<br>");
  const rows = humans.map((h) =>
    `${humanName(h)} &nbsp;<b>${ordinal(finishOrder.indexOf(h.car) + 1)}</b> &nbsp; LAST ${h.lastLap ? shared.fmtTime(h.lastLap) : "--"} &nbsp; DRIFT ${Math.floor(h.car.score).toLocaleString()}`).join("<br>");
  const html = `${rows}<br>BEST &nbsp;${bests[track.id] ? shared.fmtTime(bests[track.id]) : "--"}` +
    `<div style="margin-top:12px;font-size:14px;line-height:1.7;text-align:left">${standings}</div>`;
  shared.showFinish(html);
  if (mode === "host") net.broadcast({ t: "results", html });
}

// lapEv comes from the player's LapCounter: "begin" (rolling start) or "lap"
function onCrossedLine(pl, lapEv) {
  const local = locals.find((l) => l.player === pl);
  const primary = local && local.view.slot === 0;
  if (lapEv === "begin") {
    // rolling start: crossing the line the first time begins lap 1
    pl.lapBegin = true;
    pl.lapStartT = raceTime;
    if (primary) { ghost.startRecording(); ghost.startPlayback(); }
    if (mode === "host" && pl.remoteId) net.send(pl.remoteId, { t: "ev", kind: "begin" });
    return;
  }
  if (pl.finished) return;
  pl.lapsCounted = pl.laps.laps;
  const lapNow = pl.lapsCounted;
  const lapTime = raceTime - pl.lapStartT;
  pl.lapStartT = raceTime;
  pl.lastLap = lapTime;
  let best = false;
  if (!bests[track.id] || lapTime < bests[track.id]) {
    bests[track.id] = lapTime;
    best = true;
    if (!track.def.random) saveMem(`bestlap-${track.id}`, lapTime);
  }
  const newGhost = primary ? ghost.finishRecording(lapTime) : false; // keeps only the best
  if (lapNow >= LAPS) {
    finishPlayer(pl, lapTime);
  } else {
    if (local) local.view.hud.flashMsg(newGhost ? `NEW BEST ${shared.fmtTime(lapTime)}` : `LAP ${lapNow + 1} — ${shared.fmtTime(lapTime)}`);
    if (primary) { audio.sfx(newGhost ? "best" : "lap"); ghost.startRecording(); ghost.startPlayback(); }
    if (mode === "host" && pl.remoteId) net.send(pl.remoteId, { t: "ev", kind: best ? "best" : "lap", lapTime, lap: lapNow });
  }
}

// R: back to the last checkpoint (track.resetToCheckpoint keeps lap totals exact)
function resetToCheckpoint(pl) {
  if (mode === "client") { net.send({ t: "reset" }); return; }
  const car = pl.car;
  const pose = track.resetToCheckpoint(car);
  const local = locals.find((l) => l.player === pl);
  if (local && local.view.slot === 0) ghost.voidRecording(); // this lap can no longer be the ghost/best lap
  particles.puff(pose.x, pose.y, pose.z);
  if (local) local.view.cam.snapTo(car);
}

// --- hotkeys + lifecycle --------------------------------------------------
const pausePanel = document.getElementById("pause-panel");
let pausedAt = null;
function setPaused(v) {
  if (isOnline()) { // online: the race never stops; the panel is just a menu
    if (state === "lobby" || state === "menu") return;
    pausePanel.style.display = v ? "block" : "none";
    return;
  }
  if (v && state !== "paused" && state !== "menu") { pausedAt = state; state = "paused"; pausePanel.style.display = "block"; }
  else if (!v && state === "paused") { state = pausedAt || "racing"; pausedAt = null; pausePanel.style.display = "none"; }
}
const panelOpen = () => pausePanel.style.display === "block";
// clicking out of the tab / switching apps pauses the race instead of eating walls
window.addEventListener("blur", () => { if (!isOnline()) setPaused(true); });
document.addEventListener("visibilitychange", () => { if (document.hidden && !isOnline()) setPaused(true); });
window.addEventListener("keydown", (e) => {
  if (state === "menu" || state === "lobby") {
    if (e.code === "Enter" || (e.code === "Space" && mode === "local")) { audio.ensure(); startRace(); }
    else if (e.code === "Escape" && isOnline()) leaveOnline("left the lobby");
    else if (mode === "client") return;
    else if (e.code === "ArrowRight" || e.code === "KeyD") { loadTrack(trackIndex + 1); showMenu(); }
    else if (e.code === "ArrowLeft" || e.code === "KeyA") { loadTrack(trackIndex - 1); showMenu(); }
    else if (e.code === "ArrowUp" || e.code === "ArrowDown" || e.code === "KeyW" || e.code === "KeyS") {
      const order = ["easy", "normal", "hard"];
      const dir = (e.code === "ArrowUp" || e.code === "KeyW") ? 1 : -1;
      difficulty = order[(order.indexOf(difficulty) + dir + 3) % 3];
      saveMem("difficulty", difficulty);
      showMenu();
    }
    else if (e.code === "Digit1" || e.code === "Digit3" || e.code === "Digit5") { LAPS = +e.code.slice(-1); saveMem("laps", LAPS); showMenu(); }
    else if (e.code === "KeyR") { loadTrack(RANDOM_INDEX); showMenu(); }
    else if (e.code === "KeyP" && mode === "local") { numPlayers = numPlayers === 1 ? 2 : 1; saveMem("players", numPlayers); showMenu(); }
    else if (e.code === "KeyC" || e.code === "KeyV") {
      const slot = e.code === "KeyC" ? 0 : 1;
      if (slot < localCount()) {
        const i = CAR_CLASSES.findIndex((c) => c.id === carChoice[slot]);
        carChoice[slot] = CAR_CLASSES[(i + 1) % CAR_CLASSES.length].id;
        saveMem("cars", carChoice);
        showMenu();
      }
    }
    return;
  }
  if (e.code === "Escape") {
    if (state === "finished" && mode !== "client") startRace(); // results screen: Esc / pad Start = race again
    else if (state === "finished") return;
    else setPaused(!panelOpen());
    return;
  }
  if (e.code === "KeyM" && (panelOpen() || state === "finished")) { quitToMenu(); return; }
  if (state === "paused" || panelOpen()) {
    if (e.code === "Enter" && mode !== "client") { setPaused(false); startRace(); }
    return;
  }
  if (e.code === "KeyL") { track.lineMesh.visible = !track.lineMesh.visible; saveMem("racing-line", track.lineMesh.visible); }
  if (e.code === "KeyG") ghost.toggle();
  if (state === "racing") {
    // R (keyboard or a pad's Back/Share, tagged with its slot) resets that player; Backspace = P2
    if (e.code === "KeyR") { const l = locals[e.padSlot ?? 0]; if (l) resetToCheckpoint(l.player); }
    if (e.code === "Backspace" && locals[1]) resetToCheckpoint(locals[1].player);
  }
  if (e.code === "Enter" && state === "finished" && mode !== "client") startRace();
});
function quitToMenu() {
  setPaused(false);
  if (mode === "host") net.broadcast({ t: "menu" });
  showMenu();
}
document.getElementById("pause-resume").addEventListener("click", () => setPaused(false));
document.getElementById("pause-restart").addEventListener("click", () => { if (mode !== "client") { setPaused(false); startRace(); } });
document.getElementById("pause-menu").addEventListener("click", quitToMenu);
shared.bindOnline({ onHost: hostLobby, onJoin: joinLobby }, myName);

loadTrack(trackIndex);
showMenu();

// --- helpers -------------------------------------------------------------
const progOf = (c) => (mode === "client" ? (c.netProg || c.prog) : c.prog);
function liveStandings() {
  const rest = cars.filter((c) => !finishOrder.includes(c)).sort((a, b) => progOf(b).total - progOf(a).total);
  return [...finishOrder, ...rest];
}

// the single full-screen view: aim the shadow frustum, return its camera
function focusView0() {
  const v = views[0];
  env.setFocus(state === "menu" || state === "lobby" ? v.camera.position : v.player.car.pos);
  return v.camera;
}

// one viewport per local screen (top/bottom in split-screen)
function renderViews() {
  if (NORENDER) return;
  const w = window.innerWidth, h = window.innerHeight;
  if (locals.length !== 2 || state === "menu" || state === "lobby") {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.render(scene, focusView0());
    return;
  }
  renderer.setScissorTest(true);
  for (const l of locals) {
    const v = l.view;
    const y = v.slot === 0 ? Math.ceil(h / 2) : 0;
    const vh = v.slot === 0 ? h - Math.ceil(h / 2) : Math.ceil(h / 2);
    renderer.setViewport(0, y, w, vh);
    renderer.setScissor(0, y, w, vh);
    env.setFocus(l.player.car.pos); // shadows follow each viewport's car
    renderer.render(scene, v.camera);
  }
  renderer.setScissorTest(false);
}

function hostSnapshot() {
  net.broadcast({
    t: "snap", state, cd: +countdownT.toFixed(3), rt: +raceTime.toFixed(3),
    fin: finishOrder.map((c) => c.netId),
    cars: cars.map((c) => packCar(c.netId, c)),
  });
}

// --- the loop ----------------------------------------------------------------
let last = performance.now();

let lastFrameAt = performance.now();
let frameCount = 0;
// read-only debug readout (useful from the console / automated checks)
window.__drift = { get state() { return state; }, get mode() { return mode; }, get raceTime() { return raceTime; }, get countdown() { return countdownT; }, get frames() { return frameCount; },
  get mySlot() { return net ? net.mySlot : null; },
  get prog0() { const c = locals[0] && locals[0].player.car; return c && c.prog ? { s: +c.prog.s.toFixed(1), total: +c.prog.total.toFixed(1), lap: c.prog.lap, L: +track.length.toFixed(1) } : null; },
  get hazard() { return hazards && hazards.active ? hazards.active.type : null; }, steps: { raf: 0, timer: 0, maxDt: 0 },
  get laps() { return humans.map((p) => `${p.name}:counted=${p.lapsCounted}:lap=${(mode === "client" ? (p.car.netProg || p.car.prog) : p.car.prog).lap}:fin=${p.finished}`); },
  get finishPanel() { return getComputedStyle(document.getElementById("finish-panel")).display === "block"; }, get guests() { return net && net.guests ? [...net.guests.values()].map((g) => g.name + ":" + g.slot + ":" + (g.conn.open ? "open" : "closed") + ":" + Math.round(performance.now() - g.lastSeen)) : null; }, get netStatus() { return netStatus; }, get localCar() { return locals[0] && locals[0].player ? locals[0].player.car.netId : null; },
  get humans() { return humans.map((p) => p.car.netId + ":" + p.name); }, get carsPos() { return cars.map((c) => [c.netId, +c.pos.x.toFixed(1), +c.pos.z.toFixed(1), c.mesh.visible]); },
  xr: { get available() { return stereo.available; }, get woven() { return stereo.woven; }, get scale() { return stereo.scale; }, get firstWoven() { return stereo.firstWoven; } } };

// the 2D loop; it stands down while the DisplayXR session drives frames
let monoLoop = true;
function frame(now) {
  if (!monoLoop) return;
  requestAnimationFrame(frame); // always re-arm first: a skipped duplicate must not end the chain
  if (isDuplicate(now)) return; // timer and rAF both fired: skip the duplicate
  window.__drift.steps.raf++;
  if (step(now)) renderViews();
}
function startMonoLoop() {
  if (monoLoop) return;
  monoLoop = true;
  requestAnimationFrame(frame);
}
// A rAF timestamp is the frame's START, so it can be earlier than a
// performance.now() taken by a task in between (the boot code, the stall
// timer, the woven loop). Treating "earlier" as a duplicate ended the chain
// for good — seen in headless Chrome, where the menu never got a frame. Only
// a near-equal stamp is a duplicate; an earlier one just yields dt <= 0.
const isDuplicate = (now) => Math.abs(now - lastFrameAt) < 4;

// one simulation step; false when there is nothing new to draw
function step(now) {
  if (isDuplicate(now)) return false;
  lastFrameAt = now;
  frameCount++;
  let dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (dt <= 0) return false;
  if (dt > window.__drift.steps.maxDt) window.__drift.steps.maxDt = dt;

  if (state === "paused") {
    // frozen world: same frame re-rendered, sim and timers halted
    return true;
  }

  if (state === "menu" || state === "lobby") {
    // living backdrop: the rivals lap the circuit while you pick a track
    for (const ai of ais) ai.car.update(dt, ai.update(dt, null), track);
    resolveCarContacts(aiCars);
    for (const c of aiCars) { track.resolveCollision(c); track.updateProgress(c); }
    particles.update(dt, aiCars, track);
    skids.update(aiCars);
    track.update(dt);
    views[0].cam.orbit(dt, track);
    env.update(dt);
    return true;
  }

  const idle = { steer: 0, throttle: 0, brake: 0, handbrake: false };
  const inputs = new Map(); // player -> input
  for (const l of locals) {
    if (AUTOPILOT && state !== "countdown") {
      if (!l.pilot || l.pilot.track !== track || l.pilot.car !== l.player.car) l.pilot = new AIDriver(l.player.car, track, { name: "AUTO", pace: 1.0, driftiness: 0.6 });
      inputs.set(l.player, l.pilot.update(dt, null));
    } else inputs.set(l.player, keyboard.sample(l.view.slot, locals.length === 2));
  }
  if (mode === "host") for (const p of humans) if (p.remoteId) inputs.set(p, (net.guests.get(p.remoteId) || {}).input || idle);
  const myInput = inputs.get(locals[0].player) || idle;

  if (mode === "client") {
    // guest: predict own car, puppet everything else, send inputs
    clientFrame(dt, myInput);
  } else {
    if (state === "countdown") {
      countdownT -= dt;
      const n = Math.ceil(countdownT);
      if (countdownT > 0 && n >= 1 && countdownT < 3.05) {
        for (const l of locals) l.view.hud.flashMsg(`${n}`, 0.95);
        if (n !== lastTick) { lastTick = n; audio.sfx("tick"); }
        track.setStartLights(Math.min(5, 1 + Math.floor((3 - countdownT) / 3 * 5)));
      }
      if (countdownT <= 0) {
        state = "racing";
        for (const l of locals) l.view.hud.flashMsg("GO!", 0.9);
        audio.sfx("go");
        track.setStartLights(5, true);
      }
    }

    if (state !== "countdown") {
      raceTime += dt;
      if (raceTime > 2.5 && raceTime - dt <= 2.5) track.setStartLights(0);
      hintT += dt;
      if (hintT > 12 && hintT - dt <= 12) for (const v of views) v.hud.elHint.style.opacity = "0";

      // players + AI all run the identical physics step
      for (const p of humans) if (!p.car.finished || !p.remoteId) p.car.update(dt, inputs.get(p) || idle, track);
      const p1Total = players[0].car.prog.total;
      for (const ai of ais) {
        if (!ai.car.finished) ai.car.update(dt, ai.update(dt, { playerTotal: p1Total }), track);
      }

      // bots vanish once they've finished their laps
      const activeAI = finishCars(aiCars, LAPS);
      for (const c of aiCars) if (c.finished && !finishOrder.includes(c)) finishOrder.push(c);
      const activeCars = [...humans.filter((p) => p.car.mesh.visible).map((p) => p.car), ...activeAI];

      // contacts and walls (a sudden velocity change on a local player = a bump)
      const pv = locals.map((l) => [l.player.car.vel.x, l.player.car.vel.z]);
      resolveCarContacts(activeCars);
      locals.forEach((l, i) => {
        const bump = Math.hypot(l.player.car.vel.x - pv[i][0], l.player.car.vel.z - pv[i][1]);
        if (bump > 1.2) { if (l.view.slot === 0) audio.sfx("contact", Math.min(bump / 6, 1.2)); l.view.cam.kick(Math.min(bump / 8, 0.6)); }
      });
      for (const car of cars) track.resolveCollision(car);
      // hazards: jolts / rock hits land on wallHit before the kick + spark checks
      hazardCtx.leaderCars = activeCars;
      hazards.update(dt, raceTime, activeCars, hazardCtx);
      tintSky();
      for (const l of locals) {
        const p = l.player;
        if (p.car.wallHit) l.view.cam.kick(Math.min(0.2 + p.car.speed / 40, 0.9));
        if (p.car.grounded && !p.prevGrounded) {
          l.view.cam.kick(0.35);
          particles.puff(p.car.pos.x, p.car.pos.y, p.car.pos.z, 0xd8d2c4, 8);
        }
        p.prevGrounded = p.car.grounded;
      }

      // progress / laps
      for (const car of cars) {
        const before = car.prog.total;
        const ev = track.updateProgress(car);
        const pl = humans.find((h) => h.car === car);
        if (pl) {
          if (!pl.laps || pl.laps.track !== track) pl.laps = new LapCounter(track);
          const lapEv = pl.laps.update(car, ev);
          if (lapEv) onCrossedLine(pl, lapEv);
          const l = locals.find((x) => x.player === pl);
          if (l) {
            // wrong-way warning: sustained backwards travel at speed
            const backwards = car.prog.total - before < -0.08 && car.speed > 4;
            pl.wrongWayT = backwards ? pl.wrongWayT + dt : 0;
            if (pl.wrongWayT > 0.8 && state === "racing") l.view.hud.flashMsg("WRONG WAY", 0.15);
          }
        }
      }

      // once someone has finished, the stragglers' clock is running
      if (finishDeadline != null && raceTime > finishDeadline && state === "racing") {
        for (const h of humans) if (!h.finished) { h.finished = true; h.car.finished = true; }
        endRace();
      }

      // ghost: record this lap, replay the best (screen 1)
      if (ghost.recording) ghost.recordFrame(dt, locals[0].player.car);
      ghost.update(dt);

      particles.update(dt, activeCars, track);
      skids.update(activeCars);
    }
    audio.update(dt, locals[0].player.car, myInput);
    if (mode === "host") {
      snapAcc += dt;
      if (snapAcc >= 0.05) { snapAcc = 0; hostSnapshot(); }
    }
  }

  track.update(dt);
  for (const l of locals) l.view.cam.update(dt, l.player.car);
  env.update(dt);

  // HUD (also live through countdown so the grid is visible)
  const ranked = liveStandings();
  const leader = ranked[0];
  const rows = ranked.map((c, i) => ({
    car: c,
    pos: i + 1,
    name: carName(c),
    color: colorHex(c.color),
    gap: c.finished || finishOrder.includes(c) ? "FIN" : i === 0 ? "" : `+${((progOf(leader).total - progOf(c).total) / 28).toFixed(1)}s`,
  }));
  for (const l of locals) {
    const p = l.player, car = p.car, pr = progOf(car);
    l.view.hud.update(dt, {
      speedKmh: car.speedKmh,
      speedFrac: car.speed / (CONFIG.TOP_SPEED * car.tuning.topSpeed),
      lap: p.lapsCounted + 1,
      laps: LAPS,
      finished: p.finished,
      curLap: p.lapBegin && !p.finished ? raceTime - p.lapStartT : null,
      lastLap: p.lastLap, bestLap: bests[track.id] ?? null,
      pos: ranked.indexOf(car) + 1,
      board: rows.map((r) => ({ ...r, me: r.car === car })),
      drifting: car.drifting,
      driftScore: car.score,
      combo: car.combo,
      driftCharge: car.drifting ? car.driftTime / CONFIG.BOOST_TIME_REF : 0,
      boostFlash: car.boostFlash,
      padBoost: car.padBoost,
    });
  }
  // online indicator / connection watchdog
  if (mode === "host") shared.setNetStatus(`ONLINE · ${humans.length} RACER${humans.length === 1 ? "" : "S"}`);
  else if (mode === "client") {
    const silent = (performance.now() - lastSnapAt) / 1000;
    shared.setNetStatus(silent > 3 ? `CONNECTION LOST · ${Math.floor(silent)}s` : `ONLINE · ${humans.length} RACERS`, silent > 3);
  } else shared.setNetStatus("");
  for (const l of locals) if (l.player.finished && state === "racing" && l.view.hud.msgTimer <= 0 && finishDeadline != null) {
    l.view.hud.flashMsg(`WAITING FOR OTHERS · ${Math.max(0, Math.ceil(finishDeadline - raceTime))}s`, 0.3);
  }
  shared.drawMap([
    ...aiCars.filter((c) => !c.finished).map((c) => ({ x: c.pos.x, z: c.pos.z, color: colorHex(c.color), r: 3 })),
    ...(ghost.mesh.visible ? [{ x: ghost.mesh.position.x, z: ghost.mesh.position.z, color: "#67f0ff", r: 2.5 }] : []),
    ...humans.filter((p) => !locals.some((l) => l.player === p) && p.car.mesh.visible).map((p) => ({ x: p.car.pos.x, z: p.car.pos.z, color: colorHex(p.car.color), r: 3.5 })),
    ...locals.map((l) => ({ x: l.player.car.pos.x, z: l.player.car.pos.z, color: l.view.slot === 0 ? "#ffffff" : colorHex(l.player.car.color), r: 4, ring: true })),
  ]);
  return true;
}

// guest's frame: local prediction for own car, puppets for the rest
const clientSelf = [null]; // reused one-car list for hazards.update
function clientFrame(dt, myInput) {
  const me = locals[0].player, car = me.car;
  net.sendInput(myInput);
  if (state === "countdown") {
    const n = Math.ceil(countdownT);
    if (countdownT > 0 && n >= 1 && countdownT < 3.05) {
      views[0].hud.flashMsg(`${n}`, 0.95);
      if (n !== lastTick) { lastTick = n; audio.sfx("tick"); }
      track.setStartLights(Math.min(5, 1 + Math.floor((3 - countdownT) / 3 * 5)));
    }
  } else {
    raceTime += dt;
    hintT += dt;
    if (hintT > 12 && hintT - dt <= 12) views[0].hud.elHint.style.opacity = "0";
    car.update(dt, myInput, track);
    track.resolveCollision(car);
    track.updateProgress(car); // local s for surfaces/height; laps come from the host
    if (car.netCorr) {
      const k = Math.min(1, 10 * dt);
      car.pos.x += car.netCorr.x * k; car.pos.z += car.netCorr.z * k;
      car.netCorr.x *= 1 - k; car.netCorr.z *= 1 - k;
    }
    for (const c of cars) if (c !== car && c.mesh.visible) stepRemote(c, dt);
    // hazards: jolt / collide only my own car (puppets move by the host's
    // snapshots); the leader for rock placement comes from every visible car
    clientSelf[0] = car;
    hazardCtx.leaderCars = cars;
    hazards.update(dt, raceTime, clientSelf, hazardCtx);
    tintSky();
    if (car.wallHit) views[0].cam.kick(Math.min(0.2 + car.speed / 40, 0.9));
    if (car.grounded && !me.prevGrounded) { views[0].cam.kick(0.35); particles.puff(car.pos.x, car.pos.y, car.pos.z, 0xd8d2c4, 8); }
    me.prevGrounded = car.grounded;
    const active = cars.filter((c) => c.mesh.visible);
    particles.update(dt, active, track);
    skids.update(active);
  }
  audio.update(dt, car, myInput);
}
requestAnimationFrame(frame);
// browsers stop or throttle animation frames in hidden/background tabs; a
// host must keep simulating and sending snapshots for everyone else, so
// tick on a timer whenever frames have stalled. While woven this only
// simulates: a second painter over the side-by-side buffer corrupts it.
setInterval(() => {
  if (!isOnline() || performance.now() - lastFrameAt <= 90) return;
  const now = performance.now();
  window.__drift.steps.timer++;
  if (stereo.woven) step(now);
  else if (step(now)) renderViews(); // never through frame(): that would start a second rAF chain
}, 1000 / 30);

// --- DisplayXR stereo ----------------------------------------------------------
// Split-screen is two viewports in one canvas and cannot be woven, so stereo
// runs only with one local view (single player and online). The menu orbit is
// woven too.
function stereoConvergence() {
  // where the eye should rest sits on the glass: the car in a race, the
  // orbit's radius in the menu (both well past the comfort floor)
  if (state === "menu" || state === "lobby" || !views[0].player) return 22;
  return views[0].camera.position.distanceTo(views[0].player.car.pos);
}
function syncStereo() {
  const want = stereo.available && locals.length !== 2;
  if (want && !stereo.woven) {
    const ok = stereo.start({
      renderer, scene, THREE, canvas,
      getCamera: () => views[0].camera,
      getConvergence: stereoConvergence,
      simulate: (now) => { step(now); focusView0(); },
      renderMono: renderViews,
      onStop: () => { resize(); startMonoLoop(); },
      overlays: [
        document.getElementById("hud-map"), document.getElementById("hud-track"),
        document.getElementById("menu"), ...document.querySelectorAll(".panel"),
        ...document.querySelectorAll(".player-hud .hud:not(.vignette):not(.boost-glow)"),
      ],
    });
    // only now: a refused activation must leave the 2D loop running
    if (ok) monoLoop = false;
  } else if (!want && stereo.woven) {
    stereo.stop();
  }
}
stereo.init().then(syncStereo);
