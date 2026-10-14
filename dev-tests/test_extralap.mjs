// Reproduce the user's "extra lap" report: run a full 3-lap race with the
// AI autopiloting the player, log every line crossing + lap display, then
// test R-reset mid-race for the gate bookkeeping bug.
import * as THREE from "three";
import { Car, resolveCarContacts } from "./src/car.js";
import { Track, TRACKS } from "./src/track.js";
import { AIDriver, AI_TIERS } from "./src/ai.js";

const scene = new THREE.Scene();
const track = new Track(scene, TRACKS[0]);
const LAPS = 3;

const player = new Car(scene, 0x39a0ff, "YOU");
const pilot = new AIDriver(player, track, { name: "AUTO", pace: 1.0, driftiness: 1.0 });
const pose = track.poseFor(track.length - 16, -2.6);
player.place(pose.x, pose.z, pose.heading, pose.y);
track.initProgress(player);

let raceTime = 0, lapStartT = 0, lapBegin = false;
const log = [];

function onCrossedLine() {
  if (!lapBegin) {
    lapBegin = true;
    lapStartT = raceTime;
    log.push(`crossed #${log.length + 1}: ROLLING START lap=${player.prog.lap} display=${Math.min(player.prog.lap + 1, LAPS)}/${LAPS} total=${player.prog.total.toFixed(1)}`);
    return;
  }
  const lapTime = raceTime - lapStartT;
  lapStartT = raceTime;
  const lapDone = player.prog.lap;
  log.push(`crossed #${log.length + 1}: lap ${lapDone} DONE in ${lapTime.toFixed(1)}s total=${player.prog.total.toFixed(1)} display=${Math.min(lapDone + 1, LAPS)}/${LAPS}${lapDone >= LAPS ? "  >>> FINISH" : ""}`);
}

const dt = 1 / 60;
let steps = 0;
while (player.prog.lap < LAPS && steps < 60 * 260) {
  raceTime += dt;
  steps++;
  player.update(dt, pilot.update(dt, { playerTotal: player.prog.total + 1 }), track);
  track.resolveCollision(player);
  const ev = track.updateProgress(player);
  if (ev.crossed) onCrossedLine();
}
console.log("---- clean run ----");
log.forEach((l) => console.log(l));
console.log(`total laps driven: ${log.length - 1}, final lap counter: ${player.prog.lap}`);
