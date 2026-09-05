// main.js — entry point: renderer/scene setup, race state machine
// (countdown -> racing -> finished), and the game loop that owns all updates.
import * as THREE from "three";
import { Car, resolveCarContacts } from "./car.js";
import { Keyboard } from "./input.js";
import { Track, TRACKS } from "./track.js";
import { ChaseCam } from "./camera.js";
import { AIDriver, AI_TIERS } from "./ai.js";
import { GhostSystem } from "./ghost.js";
import { HUD } from "./hud.js";
import { AudioSys } from "./audio.js";
import { Particles } from "./particles.js";
import { loadMem, saveMem } from "./memory.js";

const LAPS = 3;

// --- renderer / scene -------------------------------------------------------
const canvas = document.getElementById("game-canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb4d9);
scene.fog = new THREE.Fog(0x8fb4d9, 90, 340);
scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x35482e, 0.85));
const sun = new THREE.DirectionalLight(0xffeec2, 1.15);
sun.position.set(80, 120, 40);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 800);
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// --- world ------------------------------------------------------------------
let track = null;
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
const bests = Object.create(null); // per-track best lap times (session memory)
window.addEventListener("keydown", () => audio.ensure(), { once: false });
window.addEventListener("pointerdown", () => audio.ensure(), { once: false });

// --- race state --------------------------------------------------------
let state = "countdown";
let countdownT = 3.0;
let raceTime = 0;
let lapStartT = 0;
let lapBegin = false;      // player has crossed the line to start lap 1
let lastLap = null;
let trackIndex = 0;
let finishedPos = null;

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

function restartRace() {
  state = "countdown";
  countdownT = 3.0;
  raceTime = 0;
  lapBegin = false;
  lastLap = null;
  finishedPos = null;
  player.score = 0;
  for (const c of cars) { c.score = 0; }
  placeOnGrid();
  hud.hideFinish();
}

function loadTrack(i) {
  if (track) track.dispose(scene);
  trackIndex = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
  track = new Track(scene, TRACKS[trackIndex]);
  for (const ai of ais) ai.track = track;
  ghost.setTrack(track.id);
  hud.setTrack(track.outline(), track.name);
  track.lineMesh.visible = loadMem("racing-line", true);
  if (!(track.id in bests)) bests[track.id] = loadMem(`bestlap-${track.id}`, null);
  restartRace();
  hud.flashMsg(track.name, 1.8);
}
loadTrack(0);

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
    finishedPos = 1 + aiCars.filter((a) => a.prog.total > player.prog.total).length;
    const suffix = finishedPos === 1 ? "st" : finishedPos === 2 ? "nd" : finishedPos === 3 ? "rd" : "th";
    hud.showFinish(
      `POS &nbsp;<b>${finishedPos}${suffix}</b><br>` +
      `LAST &nbsp;${hud.fmtTime(lapTime)}<br>BEST &nbsp;${hud.fmtTime(bests[track.id])}<br>` +
      `DRIFT &nbsp;${Math.floor(player.score).toLocaleString()}`
    );
  } else {
    hud.flashMsg(newGhost ? `NEW BEST ${hud.fmtTime(lapTime)}` : `LAP ${lapDone + 1} — ${hud.fmtTime(lapTime)}`);
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
  cam.snapTo(player);
}

// --- hotkeys + lifecycle --------------------------------------------------
const pausePanel = document.getElementById("pause-panel");
let pausedAt = null;
function setPaused(v) {
  if (v && state !== "paused") { pausedAt = state; state = "paused"; pausePanel.style.display = "block"; }
  else if (!v && state === "paused") { state = pausedAt || "racing"; pausedAt = null; pausePanel.style.display = "none"; }
}
// clicking out of the tab / switching apps pauses the race instead of eating walls
window.addEventListener("blur", () => setPaused(true));
document.addEventListener("visibilitychange", () => { if (document.hidden) setPaused(true); });
window.addEventListener("keydown", (e) => {
  if (e.code === "Escape") { setPaused(state !== "paused"); return; }
  if (state === "paused") return;
  if (e.code === "KeyL") { track.lineMesh.visible = !track.lineMesh.visible; saveMem("racing-line", track.lineMesh.visible); }
  if (e.code === "KeyG") ghost.toggle();
  if (e.code === "KeyR" && state === "racing") resetToCheckpoint();
  if (e.code === "KeyT") loadTrack(trackIndex + 1);
  if (e.code === "Enter" && state === "finished") restartRace();
});
document.getElementById("pause-resume").addEventListener("click", () => setPaused(false));
document.getElementById("pause-restart").addEventListener("click", () => { setPaused(false); restartRace(); });
document.getElementById("pause-track").addEventListener("click", () => { setPaused(false); loadTrack(trackIndex + 1); });

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

  if (state === "countdown") {
    countdownT -= dt;
    const n = Math.ceil(countdownT);
    if (countdownT > 0 && n >= 1 && countdownT < 3.05) hud.flashMsg(`${n}`, 0.95);
    if (countdownT <= 0) {
      state = "racing";
      hud.flashMsg("GO!", 0.9);
    }
  }

  if (state !== "countdown") {
    raceTime += dt;

    // player + AI all run the identical physics step
    player.update(dt, keyboard.sample(), track);
    for (const ai of ais) {
      const input = ai.update(dt, { playerTotal: player.prog.total });
      ai.car.update(dt, input, track);
    }

    // contacts and walls
    resolveCarContacts(cars);
    for (const car of cars) track.resolveCollision(car);

    // progress / laps
    for (const car of cars) {
      const ev = track.updateProgress(car);
      if (car === player && ev.crossed) onCrossedLine();
    }

    // ghost: record this lap, replay the best
    if (ghost.recording) ghost.recordFrame(dt, player);
    ghost.update(dt);

    particles.update(dt, cars, track);
    cam.update(dt, player);
    audio.update(dt, player);
  }

  // HUD (also live through countdown so the grid is visible)
  const ranked = [...cars].sort((a, b) => b.prog.total - a.prog.total);
  const pos = ranked.indexOf(player) + 1;
  hud.update(dt, {
    speedKmh: player.speedKmh,
    lap: player.prog.lap + 1,
    laps: LAPS,
    curLap: lapBegin ? raceTime - lapStartT : null,
    lastLap, bestLap: bests[track.id] ?? null,
    trackName: track.name,
    pos,
    drifting: player.drifting,
    driftScore: player.score,
    combo: player.combo,
    boostFlash: player.boostFlash,
    dots: [
      ...aiCars.map((c) => ({ x: c.pos.x, z: c.pos.z, color: "#" + c.color.toString(16).padStart(6, "0"), r: 3 })),
      ...(ghost.mesh.visible ? [{ x: ghost.mesh.position.x, z: ghost.mesh.position.z, color: "#67f0ff", r: 2.5 }] : []),
      { x: player.pos.x, z: player.pos.z, color: "#ffffff", r: 4 },
    ],
  });

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
