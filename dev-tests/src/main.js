// main.js — entry point: renderer/scene setup, race state machine
// (menu -> countdown -> racing -> finished, with pause), and the game loop
// that owns all updates.
import * as THREE from "three";
import { Car, resolveCarContacts, CONFIG } from "./car.js";
import { Keyboard } from "./input.js";
import { Track, TRACKS } from "./track.js";
import { ChaseCam } from "./camera.js";
import { AIDriver, AI_TIERS, finishCars } from "./ai.js";
import { GhostSystem } from "./ghost.js";
import { HUD } from "./hud.js";
import { AudioSys } from "./audio.js";
import { Particles } from "./particles.js";
import { SkidMarks } from "./skidmarks.js";
import { Environment, makeLabel } from "./env.js";
import { loadMem, saveMem } from "./memory.js";

const DIFFICULTY = { easy: 0.9, normal: 1.0, hard: 1.06 };
let LAPS = loadMem("laps", 3);
let difficulty = loadMem("difficulty", "normal");
if (!(difficulty in DIFFICULTY)) difficulty = "normal";

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
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 2000);
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// --- world ------------------------------------------------------------------
let track = null;
const env = new Environment(scene, renderer);
const player = new Car(scene, 0x39a0ff, "YOU");
const aiCars = AI_TIERS.map((t) => new Car(scene, t.color, t.name));
const ais = aiCars.map((c, i) => new AIDriver(c, null, AI_TIERS[i]));
const cars = [player, ...aiCars];
const ghost = new GhostSystem(scene);
const cam = new ChaseCam(camera);
const hud = new HUD();
const keyboard = new Keyboard();
const audio = new AudioSys();
const particles = new Particles(scene);
const skids = new SkidMarks(scene);
const bests = Object.create(null); // per-track best lap times (session memory)
const colorHex = (c) => "#" + c.toString(16).padStart(6, "0");
for (const c of aiCars) {
  const label = makeLabel(c.name, colorHex(c.color));
  if (label) { label.position.set(0, 2.0, 0); c.mesh.add(label); }
}
window.addEventListener("keydown", () => audio.ensure(), { once: false });
window.addEventListener("pointerdown", () => audio.ensure(), { once: false });

// --- race state --------------------------------------------------------
let state = "menu";
let countdownT = 3.0;
let raceTime = 0;
let lapStartT = 0;
let lapBegin = false;      // player has crossed the line to start lap 1
let lastLap = null;
let trackIndex = loadMem("track", 0);
let finishedPos = null;
let finishOrder = [];      // cars in the order they completed the race
let wrongWayT = 0;         // seconds the player has been driving backwards
let lastTick = 0;          // last countdown digit that beeped
let hintT = 0;             // seconds of racing; the controls hint fades after a while
let prevGrounded = true;

const ordinal = (n) => n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th");

function placeOnGrid() {
  cars.forEach((car, i) => {
    const row = Math.floor(i / 2);
    const lat = (i % 2 === 0 ? -1 : 1) * 2.6;
    const pose = track.poseFor(track.length - 16 - row * 8, lat);
    car.place(pose.x, pose.z, pose.heading, pose.y);
    track.initProgress(car);
  });
  cam.snapTo(player);
}

function applyDifficulty() {
  for (const ai of ais) ai.setSkill(DIFFICULTY[difficulty]);
}

function restartRace() {
  state = "countdown";
  countdownT = 3.0;
  raceTime = 0;
  lapBegin = false;
  lastLap = null;
  finishedPos = null;
  finishOrder = [];
  wrongWayT = 0;
  lastTick = 0;
  hintT = 0;
  player.score = 0;
  for (const c of cars) {
    c.score = 0;
    c.finished = false;
    c.mesh.visible = true;
    if (c.shadow) c.shadow.visible = true;
  }
  applyDifficulty();
  placeOnGrid();
  skids.clear();
  ghost.setTrack(track.id);
  hud.hideFinish();
  hud.hideMenu();
  hud.elHint.style.opacity = "1";
  track.setStartLights(0);
  hud.flashMsg(track.name, 1.2);
}

function loadTrack(i) {
  if (track) track.dispose(scene);
  trackIndex = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
  saveMem("track", trackIndex);
  track = new Track(scene, TRACKS[trackIndex]);
  env.build(track);
  for (const ai of ais) ai.track = track;
  ghost.setTrack(track.id);
  hud.setTrack(track.outline(), track.name);
  track.lineMesh.visible = loadMem("racing-line", true);
  if (!(track.id in bests)) bests[track.id] = loadMem(`bestlap-${track.id}`, null);
  skids.clear();
  placeOnGrid();
  track.setStartLights(0);
}

// --- menu ----------------------------------------------------------------
const menuOutlines = TRACKS.map((def) => {
  const t = new Track(new THREE.Scene(), def);
  const o = t.outline();
  t.dispose(new THREE.Scene());
  return o;
});
function showMenu() {
  state = "menu";
  hud.hideFinish();
  document.getElementById("pause-panel").style.display = "none";
  for (const c of cars) { c.finished = false; c.mesh.visible = true; if (c.shadow) c.shadow.visible = true; }
  placeOnGrid();
  hud.showMenu({
    tracks: TRACKS.map((def, i) => ({ id: def.id, name: def.name, outline: menuOutlines[i], best: loadMem(`bestlap-${def.id}`, null) })),
    trackIndex, difficulty, laps: LAPS,
    onTrack: (i) => { if (i !== trackIndex) loadTrack(i); showMenu(); },
    onDifficulty: (d) => { difficulty = d; saveMem("difficulty", d); showMenu(); },
    onLaps: (n) => { LAPS = n; saveMem("laps", n); showMenu(); },
    onRace: () => { audio.ensure(); restartRace(); },
  });
}
loadTrack(trackIndex);
showMenu();

// --- lap handling ------------------------------------------------------
function onCrossedLine() {
  if (!lapBegin) {
    // rolling start: crossing the line the first time begins lap 1
    lapBegin = true;
    lapStartT = raceTime;
    ghost.startRecording();
    ghost.startPlayback();
    return;
  }
  const lapTime = raceTime - lapStartT;
  lapStartT = raceTime;
  lastLap = lapTime;
  if (!bests[track.id] || lapTime < bests[track.id]) {
    bests[track.id] = lapTime;
    saveMem(`bestlap-${track.id}`, lapTime);
  }
  const newGhost = ghost.finishRecording(lapTime); // keeps only the best
  const lapDone = player.prog.lap;
  if (lapDone >= LAPS) {
    state = "finished";
    finishOrder.push(player);
    finishedPos = finishOrder.length;
    // full standings: everyone who has finished in order, then the rest by distance
    const rest = cars.filter((c) => !finishOrder.includes(c)).sort((a, b) => b.prog.total - a.prog.total);
    const standings = [...finishOrder, ...rest].map((c, i) => {
      const me = c === player;
      const label = me ? "YOU" : c.name;
      return `<span style="color:${me ? "#ffd34d" : "#cfe0f2"}"><span style="display:inline-block;width:36px">${ordinal(i + 1)}</span>` +
        `<i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${colorHex(c.color)};margin-right:8px"></i>` +
        `${label}${c.finished || me ? "" : " <span style='color:#7a8ba0'>(DNF)</span>"}</span>`;
    }).join("<br>");
    hud.showFinish(
      `POS &nbsp;<b>${ordinal(finishedPos)}</b><br>` +
      `LAST &nbsp;${hud.fmtTime(lapTime)}<br>BEST &nbsp;${hud.fmtTime(bests[track.id])}<br>` +
      `DRIFT &nbsp;${Math.floor(player.score).toLocaleString()}` +
      `<div style="margin-top:12px;font-size:14px;line-height:1.7;text-align:left">${standings}</div>`
    );
    audio.sfx("finish");
  } else {
    hud.flashMsg(newGhost ? `NEW BEST ${hud.fmtTime(lapTime)}` : `LAP ${lapDone + 1} — ${hud.fmtTime(lapTime)}`);
    audio.sfx(newGhost ? "best" : "lap");
    ghost.startRecording();
    ghost.startPlayback();
  }
}

function resetToCheckpoint() {
  const g = player.prog ? player.prog.lastGate : 0;
  const lap = player.prog.lap;
  const pose = track.poseFor(track.gates[g] + 2, 0);
  player.place(pose.x, pose.z, pose.heading, pose.y);
  track.initProgress(player);
  // keep the lap bookkeeping consistent (same lap, same total distance)
  player.prog.total = track.gates[g] + lap * track.length;
  player.prog.lap = lap;
  ghost.voidRecording(); // this lap can no longer be the ghost/best lap
  particles.puff(pose.x, pose.y, pose.z);
  cam.snapTo(player);
}

// --- hotkeys + lifecycle --------------------------------------------------
const pausePanel = document.getElementById("pause-panel");
let pausedAt = null;
function setPaused(v) {
  if (v && state !== "paused" && state !== "menu") { pausedAt = state; state = "paused"; pausePanel.style.display = "block"; }
  else if (!v && state === "paused") { state = pausedAt || "racing"; pausedAt = null; pausePanel.style.display = "none"; }
}
// clicking out of the tab / switching apps pauses the race instead of eating walls
window.addEventListener("blur", () => setPaused(true));
document.addEventListener("visibilitychange", () => { if (document.hidden) setPaused(true); });
window.addEventListener("keydown", (e) => {
  if (state === "menu") {
    if (e.code === "Enter" || e.code === "Space") { audio.ensure(); restartRace(); }
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
    return;
  }
  if (e.code === "Escape") {
    if (state === "finished") restartRace(); // results screen: Esc / pad Start = race again
    else setPaused(state !== "paused");
    return;
  }
  if (e.code === "KeyM" && (state === "paused" || state === "finished")) { showMenu(); return; }
  if (state === "paused") {
    if (e.code === "Enter") { setPaused(false); restartRace(); }
    return;
  }
  if (e.code === "KeyL") { track.lineMesh.visible = !track.lineMesh.visible; saveMem("racing-line", track.lineMesh.visible); }
  if (e.code === "KeyG") ghost.toggle();
  if (e.code === "KeyR" && state === "racing") resetToCheckpoint();
  if (e.code === "Enter" && state === "finished") restartRace();
});
document.getElementById("pause-resume").addEventListener("click", () => setPaused(false));
document.getElementById("pause-restart").addEventListener("click", () => { setPaused(false); restartRace(); });
document.getElementById("pause-menu").addEventListener("click", () => { setPaused(false); showMenu(); });

// --- helpers -------------------------------------------------------------
function liveStandings() {
  const rest = cars.filter((c) => !finishOrder.includes(c)).sort((a, b) => b.prog.total - a.prog.total);
  return [...finishOrder, ...rest];
}

// --- the loop ----------------------------------------------------------------
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (dt <= 0) return;

  if (state === "paused") {
    // frozen world: same frame re-rendered, sim and timers halted
    renderer.render(scene, camera);
    return;
  }

  if (state === "menu") {
    // living backdrop: the rivals lap the circuit while you pick a track
    for (const ai of ais) ai.car.update(dt, ai.update(dt, null), track);
    resolveCarContacts(aiCars);
    for (const c of aiCars) { track.resolveCollision(c); track.updateProgress(c); }
    particles.update(dt, aiCars, track);
    skids.update(aiCars);
    track.update(dt);
    cam.orbit(dt, track);
    env.update(dt, camera.position);
    renderer.render(scene, camera);
    return;
  }

  if (state === "countdown") {
    countdownT -= dt;
    const n = Math.ceil(countdownT);
    if (countdownT > 0 && n >= 1 && countdownT < 3.05) {
      hud.flashMsg(`${n}`, 0.95);
      if (n !== lastTick) { lastTick = n; audio.sfx("tick"); }
      track.setStartLights(Math.min(5, 1 + Math.floor((3 - countdownT) / 3 * 5)));
    }
    if (countdownT <= 0) {
      state = "racing";
      hud.flashMsg("GO!", 0.9);
      audio.sfx("go");
      track.setStartLights(5, true);
    }
  }

  if (state !== "countdown") {
    raceTime += dt;
    if (raceTime > 2.5 && raceTime - dt <= 2.5) track.setStartLights(0);
    hintT += dt;
    if (hintT > 12 && hintT - dt <= 12) hud.elHint.style.opacity = "0";

    // player + AI all run the identical physics step
    const input = keyboard.sample();
    player.update(dt, input, track);
    for (const ai of ais) {
      if (!ai.car.finished) ai.car.update(dt, ai.update(dt, { playerTotal: player.prog.total }), track);
    }

    // bots vanish once they've finished their laps
    const activeAI = finishCars(aiCars, LAPS);
    for (const c of aiCars) if (c.finished && !finishOrder.includes(c)) finishOrder.push(c);
    const activeCars = [player, ...activeAI];

    // contacts and walls (a sudden velocity change on the player = a bump)
    const pvx = player.vel.x, pvz = player.vel.z;
    resolveCarContacts(activeCars);
    const bump = Math.hypot(player.vel.x - pvx, player.vel.z - pvz);
    if (bump > 1.2) { audio.sfx("contact", Math.min(bump / 6, 1.2)); cam.kick(Math.min(bump / 8, 0.6)); }
    for (const car of cars) track.resolveCollision(car);
    if (player.wallHit) cam.kick(Math.min(0.2 + player.speed / 40, 0.9));
    if (player.grounded && !prevGrounded) {
      cam.kick(0.35);
      particles.puff(player.pos.x, player.pos.y, player.pos.z, 0xd8d2c4, 8);
    }
    prevGrounded = player.grounded;

    // progress / laps
    for (const car of cars) {
      const before = car.prog.total;
      const ev = track.updateProgress(car);
      if (car === player) {
        if (ev.crossed) onCrossedLine();
        // wrong-way warning: sustained backwards travel at speed
        const backwards = car.prog.total - before < -0.08 && car.speed > 4;
        wrongWayT = backwards ? wrongWayT + dt : 0;
        if (wrongWayT > 0.8 && state === "racing") hud.flashMsg("WRONG WAY", 0.15);
      }
    }

    // ghost: record this lap, replay the best
    if (ghost.recording) ghost.recordFrame(dt, player);
    ghost.update(dt);

    particles.update(dt, activeCars, track);
    skids.update(activeCars);
    audio.update(dt, player, input);
  } else {
    // countdown: engine idles (rev it with the throttle while you wait)
    audio.update(dt, player, keyboard.sample());
  }
  track.update(dt);
  cam.update(dt, player);
  env.update(dt, player.pos);

  // HUD (also live through countdown so the grid is visible)
  const ranked = liveStandings();
  const pos = ranked.indexOf(player) + 1;
  const leader = ranked[0];
  const board = ranked.map((c, i) => ({
    pos: i + 1,
    name: c === player ? "YOU" : c.name,
    color: colorHex(c.color),
    me: c === player,
    finished: c.finished,
    gap: c.finished || c === player && state === "finished" ? "FIN" : i === 0 ? "" : `+${((leader.prog.total - c.prog.total) / 28).toFixed(1)}s`,
  }));
  hud.update(dt, {
    speedKmh: player.speedKmh,
    speedFrac: player.speed / CONFIG.TOP_SPEED,
    lap: player.prog.lap + 1,
    laps: LAPS,
    curLap: lapBegin ? raceTime - lapStartT : null,
    lastLap, bestLap: bests[track.id] ?? null,
    pos,
    board,
    drifting: player.drifting,
    driftScore: player.score,
    combo: player.combo,
    driftCharge: player.drifting ? player.driftTime / CONFIG.BOOST_TIME_REF : 0,
    boostFlash: player.boostFlash,
    padBoost: player.padBoost,
    dots: [
      ...aiCars.filter((c) => !c.finished).map((c) => ({ x: c.pos.x, z: c.pos.z, color: colorHex(c.color), r: 3 })),
      ...(ghost.mesh.visible ? [{ x: ghost.mesh.position.x, z: ghost.mesh.position.z, color: "#67f0ff", r: 2.5 }] : []),
      { x: player.pos.x, z: player.pos.z, color: "#ffffff", r: 4, ring: true },
    ],
  });

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
