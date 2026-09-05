// Consolidated headless test battery for Drift Circuit.
// Run: node dev-tests/run.mjs   (from the project root — imports use ./dev-tests/src)
import * as THREE from "three";
import { Car, resolveCarContacts, SURFACES } from "./src/car.js";
import { Track, TRACKS } from "./src/track.js";
import { AIDriver, AI_TIERS } from "./src/ai.js";
import { GhostSystem } from "./src/ghost.js";

let totalFailures = 0;
const section = (name) => console.log(`\n=== ${name} ===`);
const check = (cond, label) => {
  if (!cond) { totalFailures++; console.log("FAIL " + label); }
};
const bearingTo = (car, tx, tz) => {
  const dx = tx - car.pos.x, dz = tz - car.pos.z;
  const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
  return Math.atan2(dx * fz - dz * fx, dx * fx + dz * fz);
};
const clamp = (v, l, h) => Math.max(l, Math.min(h, v));

/* ================= 1) DRIFT PHYSICS (hairpin hold, combo, boost) ============ */
section("drift physics");
{
  const scene = new THREE.Scene();
  const apexDef = { ...TRACKS[0], surfaces: [] }; // strip ice for isolation
  const track = new Track(scene, apexDef);
  const car = new Car(scene, 0x39a0ff, "TEST");
  const hpIdx = track.indexOf(112 * 1.45, 158 * 1.45);
  let apex = hpIdx, cMin = Infinity;
  for (let o = -40; o <= 40; o++) {
    const i = (hpIdx + o + track.N) % track.N;
    if (track.cornerSpeed[i] < cMin) { cMin = track.cornerSpeed[i]; apex = i; }
  }
  const apexS = apex / track.N * track.length;
  const turnSign = Math.sign(track.kappa[apex]);
  const startPose = track.poseFor(apexS - 170, 0);
  car.place(startPose.x, startPose.z, startPose.heading);
  track.initProgress(car);
  const codriver = new AIDriver(car, track, { name: "co", pace: 0.95, driftiness: 0.05 });
  const dt = 1 / 60;
  let t = 0, phase = "approach", tInit = 0;
  let maxSlip = 0, minSpeedInDrift = Infinity, maxHeadVelAngle = 0;
  let walls = 0, sawBoost = false, peakCombo = 1, comboBroke = false, maxScore = 0, latched = false;
  for (let step = 0; step < 60 * 25; step++) {
    track.updateProgress(car);
    const s = car.prog.s;
    const toApex = ((apexS - s) % track.length + track.length) % track.length;
    const inp = { steer: 0, throttle: 1, brake: 0, handbrake: false };
    if (phase === "approach") {
      Object.assign(inp, codriver.update(dt, { playerTotal: car.prog.total + 1 }));
      if (toApex < 30 && car.speed < cMin + 6) { phase = "initiate"; tInit = t; }
    } else if (phase === "initiate") {
      inp.steer = -turnSign * 0.9; inp.throttle = 0; inp.handbrake = true;
      if (Math.abs(car.slipAngle) > 0.34 || t - tInit > 0.45) { phase = "hold"; latched = true; }
    } else if (phase === "hold") {
      const psiCorner = -turnSign * car.slipAngle;
      const p = track.poseFor(s + 9, -2.0 * turnSign);
      inp.steer = clamp(-turnSign * clamp((0.42 - psiCorner) * 3.5 + 0.35, -1, 1) + bearingTo(car, p.x, p.z) * 0.15, -1, 1);
      if (toApex > track.length / 2) phase = "post";
    } else {
      const p = track.poseFor(s + 12, 0);
      inp.steer = clamp(bearingTo(car, p.x, p.z) * 2.6, -1, 1);
    }
    car.update(dt, inp, track);
    track.resolveCollision(car);
    if (car.wallHit) walls++;
    const slip = Math.abs(car.slipAngle);
    maxSlip = Math.max(maxSlip, slip);
    if (car.drifting) minSpeedInDrift = Math.min(minSpeedInDrift, car.speed);
    if (car.boostFlash > 0) sawBoost = true;
    peakCombo = Math.max(peakCombo, car.combo);
    maxScore = Math.max(maxScore, car.score);
    if (!comboBroke && peakCombo > 1.2 && car.combo === 1 && !car.drifting && phase === "post") comboBroke = true;
    if (car.speed > 5) {
      const vh = Math.atan2(car.vel.x, car.vel.z);
      let dh = Math.abs(car.heading - vh) % (Math.PI * 2);
      if (dh > Math.PI) dh = Math.PI * 2 - dh;
      maxHeadVelAngle = Math.max(maxHeadVelAngle, dh);
    }
    t += dt;
    if (phase === "post" && comboBroke && t > 12) break;
  }
  console.log(`latched=${latched} maxSlip=${maxSlip.toFixed(2)} minDriftV=${minSpeedInDrift.toFixed(1)} maxHV=${maxHeadVelAngle.toFixed(2)} combo=${peakCombo.toFixed(2)} score=${maxScore.toFixed(0)} boost=${sawBoost} broke=${comboBroke} walls=${walls}`);
  check(latched && maxSlip > 0.35 && maxSlip < 1.15 && minSpeedInDrift > 5.5 && maxHeadVelAngle < 1.15 &&
    peakCombo > 1.25 && maxScore > 250 && sawBoost && comboBroke && walls < 25,
    "hairpin: handbrake in, held drift, no spin, boost on exit, combo builds & breaks");
}

/* ================= 2) TRACK STRUCTURE ===================================== */
section("track structure");
for (const def of TRACKS) {
  const scene = new THREE.Scene();
  const track = new Track(scene, def);
  let minH = Infinity, maxH = -Infinity, maxK = 0, badVerts = 0;
  for (let i = 0; i < track.N * 4; i++) { const h = track.heightAt(i / 4); minH = Math.min(minH, h); maxH = Math.max(maxH, h); }
  for (let i = 0; i < track.N; i++) maxK = Math.max(maxK, Math.abs(track.kappa[i]));
  for (const m of track.meshes) {
    const p = m.geometry && m.geometry.attributes.position;
    if (!p) continue;
    for (let i = 0; i < p.array.length; i++) if (!Number.isFinite(p.array[i])) badVerts++;
  }
  const road = track.meshes[0];
  const strips = track.meshes.filter((m) => m.geometry && m.geometry.constructor === THREE.BufferGeometry);
  console.log(`${def.name.padEnd(16)} len=${track.length.toFixed(0)} ramps=${track.rampsWorld.length} pads=${track.padsWorld.length} surfZones=${track.surfacesWorld.length} hRange=[${minH.toFixed(1)},${maxH.toFixed(1)}] maxKappa=${maxK.toFixed(3)}`);
  check(track.rampsWorld.some((r) => r.type === "kicker"), `${def.name}: launch kicker`);
  check(maxH > 3.0, `${def.name}: kicker >3m`);
  check(track.padsWorld.length >= 4, `${def.name}: >=4 pads`);
  check(track.surfacesWorld.length >= 2, `${def.name}: >=2 surface zones`);
  check(track.length > 1400, `${def.name}: big course`);
  check(maxH - minH > 3, `${def.name}: rolling depth`);
  check(minH >= -0.01, `${def.name}: terrain not below ground plane`);
  check(badVerts === 0, `${def.name}: no NaN verts`);
  check(maxK < 0.12, `${def.name}: no kinks`);
  check(road.material.side === THREE.DoubleSide, `${def.name}: road two-sided`);
  check(strips.every((m) => m.material.side === THREE.DoubleSide), `${def.name}: strips two-sided`);
  track.dispose(scene);
}

/* ================= 3) SPEED-GATED JUMPS =================================== */
section("jumps: speed gates air");
function flatRun(targetSpeed, defIdx = 0) {
  const scene = new THREE.Scene();
  const track = new Track(scene, TRACKS[defIdx]);
  const ramp = track.rampsWorld.reduce((a, b) => (b.h > a.h ? b : a));
  const car = new Car(scene, 0x39a0ff, "J");
  const pose = track.poseFor(ramp.s0 - 70, 0);
  car.place(pose.x, pose.z, pose.heading, pose.y);
  track.initProgress(car);
  let launched = false, maxAir = 0, launchVy = 0, landed = false, boostSeen = false, prevAir = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 12; i++) {
    const tp = track.pointAt(car.prog.s + Math.max(car.speed * 0.5, 8));
    const steer = clamp(bearingTo(car, tp.x, tp.z) * 2.6, -1, 1);
    // drive to a fixed cruise speed, hold it through the ramp
    const throttle = car.speed < targetSpeed ? 1 : 0;
    const wasG = car.grounded;
    car.padBoost = 0; // isolate jump physics from the pad lane (pads tested separately)
    car.update(dt, { steer, throttle, brake: 0, handbrake: false }, track);
    track.resolveCollision(car);
    track.updateProgress(car);
    if (wasG && !car.grounded) { launched = true; launchVy = Math.max(launchVy, car.vy); }
    if (!car.grounded) maxAir = Math.max(maxAir, car.airTime);
    if (!wasG && car.grounded) { landed = true; if (prevAir > 0.3 && car.boostFlash > 0) boostSeen = true; }
    prevAir = car.airTime;
  }
  return { launched, maxAir, launchVy, landed, boostSeen };
}
{
  const slow = flatRun(4);
  const mid = flatRun(14);
  const fast = flatRun(34);
  console.log(`slow(4): air=${slow.maxAir.toFixed(2)}s launched=${slow.launched} | mid(14): air=${mid.maxAir.toFixed(2)} vy=${mid.launchVy.toFixed(1)} | fast(34): air=${fast.maxAir.toFixed(2)}s vy=${fast.launchVy.toFixed(1)} boost=${fast.boostSeen}`);
  check(!slow.launched || slow.maxAir < 0.2, "crawling over a kicker does NOT launch you");
  check(mid.launchVy < 6, "mid speed (14 m/s): mid-size arc, vy<6");
  check(fast.launched && fast.launchVy > 6 && fast.maxAir > 0.45, "fast run soars with real momentum");
  check(fast.boostSeen, "trick boost on landing");
  check(fast.launchVy > mid.launchVy + 2, "jump height scales with speed");
}
{
  // airbrake drops you short
  const scene = new THREE.Scene();
  const track = new Track(scene, TRACKS[0]);
  const ramp = track.rampsWorld.reduce((a, b) => (b.h > a.h ? b : a));
  const fly = (brake) => {
    const car = new Car(scene, 0x39a0ff, "f");
    const pose = track.poseFor(ramp.s0 - 70, 0);
    car.place(pose.x, pose.z, pose.heading, pose.y);
    track.initProgress(car);
    let airS = null, landS = null;
    for (let i = 0; i < 60 * 14; i++) {
      const tp = track.pointAt(car.prog.s + 8);
      const steer = clamp(bearingTo(car, tp.x, tp.z) * 2.6, -1, 1);
      car.update(1 / 60, { steer, throttle: 1, brake: brake && !car.grounded ? 1 : 0, handbrake: false }, track);
      track.updateProgress(car);
      if (!car.grounded) { if (!airS) airS = [car.pos.x, car.pos.z]; landS = [car.pos.x, car.pos.z]; }
    }
    return airS && landS ? Math.hypot(landS[0] - airS[0], landS[1] - airS[1]) : 0;
  };
  const dFree = fly(false), dBraked = fly(true);
  console.log(`airbrake: free=${dFree.toFixed(0)}m braked=${dBraked.toFixed(0)}m`);
  check(dBraked < dFree * 0.75, "airbrake drops you short");
}

/* ================= 4) WALLS: wedge escape + slide + no escape ============== */
section("walls");
for (const def of TRACKS) {
  const scene = new THREE.Scene();
  const track = new Track(scene, def);
  const spots = [];
  for (const f of [0.05, 0.12, 0.3, 0.5, 0.62, 0.78, 0.9, 0.97]) spots.push(Math.round(track.length * f));
  for (const s of spots) {
    // wedge escape: nose into wall at crawl, pursuit recovery
    const row = track.poseFor(s, -5.5);
    const car = new Car(scene, 0x39a0ff, "w");
    car.place(row.x, row.z, row.heading - 0.6, row.y);
    track.initProgress(car);
    car.vel.set(Math.sin(row.heading - 0.6) * 2, 0, Math.cos(row.heading - 0.6) * 2);
    const x0 = car.pos.x, z0 = car.pos.z;
    let maxDy = 0, prevY = row.y, prevG = true;
    for (let i = 0; i < 60 * 4.5; i++) {
      const tp = track.pointAt(car.prog.s + Math.max(car.speed * 0.5, 6));
      const steer = clamp(bearingTo(car, tp.x, tp.z) * 2.6, -1, 1);
      car.update(1 / 60, { steer, throttle: 1, brake: 0, handbrake: false }, track);
      track.resolveCollision(car);
      track.updateProgress(car);
      if (car.grounded && prevG) maxDy = Math.max(maxDy, Math.abs(car.pos.y - prevY));
      prevY = car.pos.y; prevG = car.grounded;
    }
    const moved = Math.hypot(car.pos.x - x0, car.pos.z - z0);
    check(car.speed > 6 && moved > 15, `${def.name} s=${s}: wedged escape (v=${car.speed.toFixed(1)} moved=${moved.toFixed(1)})`);
    check(maxDy < 0.55, `${def.name} s=${s}: no y pops`);
  }
  // shallow wall hit keeps momentum, never escapes ribbon (on a straight)
  let s2 = 0, bestCS = 0;
  for (let i = 0; i < track.N; i++) {
    const ss = (i / track.N) * track.length;
    const cs = track.minCornerSpeed(ss, 120);
    if (cs > bestCS) { bestCS = cs; s2 = Math.round(ss); }
  }
  const car2 = new Car(scene, 0x39a0ff, "s");
  const row2 = track.poseFor(s2, 0);
  const vh = row2.heading + 0.12;
  car2.place(row2.x, row2.z, vh, row2.y);
  track.initProgress(car2);
  car2.vel.set(Math.sin(vh) * 16, 0, Math.cos(vh) * 16);
  let maxOff = 0, vAfter = 0;
  for (let i = 0; i < 60 * 2; i++) {
    car2.update(1 / 60, { steer: -0.4, throttle: 1, brake: 0, handbrake: false }, track);
    track.resolveCollision(car2);
    track.updateProgress(car2);
    const idx = track.indexOfCar(car2);
    maxOff = Math.max(maxOff, Math.abs((car2.pos.x - track.px[idx]) * track.nx[idx] + (car2.pos.z - track.pz[idx]) * track.nz[idx]));
    if (i === 100) vAfter = car2.speed;
  }
  check(vAfter > 9, `${def.name}: shallow wall hit deflects, keeps speed (v=${vAfter.toFixed(1)})`);
  check(maxOff < track.halfWidth + 0.6, `${def.name}: stayed on ribbon`);
  track.dispose(scene);
}

/* ================= 5) SURFACES ============================================ */
section("surfaces");
{
  const scene = new THREE.Scene();
  const track = new Track(scene, TRACKS[0]);
  const dirt = track.surfacesWorld.find((z) => z.type === "dirt");
  const ice = track.surfacesWorld.find((z) => z.type === "ice");
  const placeCar = (s, v) => {
    const car = new Car(scene, 0x39a0ff, "t");
    const p = track.poseFor(s, 0);
    car.place(p.x, p.z, p.heading, p.y);
    track.initProgress(car);
    car.vel.set(Math.sin(p.heading) * v, 0, Math.cos(p.heading) * v);
    return car;
  };
  const throttleRun = (s0) => {
    const car = placeCar(s0, 12);
    for (let i = 0; i < 60 * 2.5; i++) { car.update(1 / 60, { steer: 0, throttle: 1, brake: 0, handbrake: false }, track); track.updateProgress(car); }
    return car.speed;
  };
  const midDirt = (dirt.s0 + dirt.s1) / 2;
  const vA = throttleRun(midDirt - 140), vD = throttleRun(midDirt - 30);
  console.log(`asphalt exit ${vA.toFixed(1)} vs dirt exit ${vD.toFixed(1)} m/s`);
  check(vD < vA - 2.5, "dirt slows meaningfully");
  const turnRate = (sCenter) => {
    const car = placeCar(sCenter - 45, 22);
    const a0 = Math.atan2(car.vel.x, car.vel.z);
    for (let i = 0; i < 60 * 0.7; i++) { car.update(1 / 60, { steer: 1, throttle: 0.4, brake: 0, handbrake: false }, track); track.resolveCollision(car); track.updateProgress(car); }
    let da = Math.atan2(car.vel.x, car.vel.z) - a0;
    while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    return Math.abs(da);
  };
  const midIce = (ice.s0 + ice.s1) / 2;
  const tI = turnRate(midIce), tA = turnRate(midIce - (ice.s1 - ice.s0) - 160);
  console.log(`velocity rotation 0.7s: asphalt ${(tA * 57.3).toFixed(0)}deg vs ice ${(tI * 57.3).toFixed(0)}deg`);
  check(tI < tA * 0.6 && tI > 0.1, "ice slippery but not frictionless");
}

/* ================= 6) AI: laps + visible drift + contacts ================= */
section("AI");
{
  const scene = new THREE.Scene();
  const track = new Track(scene, TRACKS[0]);
  const cars = AI_TIERS.map((t) => new Car(scene, t.color, t.name));
  const ais = cars.map((c, i) => new AIDriver(c, track, AI_TIERS[i]));
  cars.forEach((car, i) => {
    const pose = track.poseFor(track.length - 16 - Math.floor(i / 2) * 8, (i % 2 ? 1 : -1) * 2.6);
    car.place(pose.x, pose.z, pose.heading, pose.y);
    track.initProgress(car);
  });
  const hpS = track.indexOf(112 * 1.45, 158 * 1.45) / track.N * track.length;
  const IN_HP = (s) => {
    const d = Math.min(Math.abs(s - hpS), track.length - Math.abs(s - hpS));
    return d < 45;
  };
  const stats = cars.map(() => ({ walls: 0, frames: 0, hpSlip: 0 }));
  for (let step = 0; step < 60 * 200; step++) {
    for (let i = 0; i < ais.length; i++) cars[i].update(1 / 60, ais[i].update(1 / 60, { playerTotal: -20 }), track);
    resolveCarContacts(cars);
    for (let i = 0; i < cars.length; i++) {
      track.resolveCollision(cars[i]);
      track.updateProgress(cars[i]);
      stats[i].frames++;
      if (cars[i].wallHit) stats[i].walls++;
      if (IN_HP(cars[i].prog.s)) stats[i].hpSlip = Math.max(stats[i].hpSlip, Math.abs(cars[i].slipAngle));
    }
  }
  for (let i = 0; i < cars.length; i++) {
    console.log(`${cars[i].name.padEnd(6)} laps=${cars[i].prog.lap} wallFrac=${(stats[i].walls / stats[i].frames).toFixed(3)} hpSlip=${stats[i].hpSlip.toFixed(2)}`);
    check(cars[i].prog.lap >= 2, `${cars[i].name} 2 laps`);
    check(stats[i].walls / stats[i].frames < 0.15, `${cars[i].name} no wall-riding`);
    check(stats[i].hpSlip > 0.22, `${cars[i].name} drifts the hairpin`);
  }
}
for (const def of TRACKS) {
  const scene = new THREE.Scene();
  const track = new Track(scene, def);
  const car = new Car(scene, 0xff0000, "AI");
  const ai = new AIDriver(car, track, AI_TIERS[0]);
  const pose = track.poseFor(track.length - 16, 0);
  car.place(pose.x, pose.z, pose.heading, pose.y);
  track.initProgress(car);
  let air = 0, frames = 0;
  for (let i = 0; i < 60 * 210 && car.prog.lap < 1; i++) {
    car.update(1 / 60, ai.update(1 / 60, { playerTotal: car.prog.total }), track);
    track.resolveCollision(car);
    track.updateProgress(car);
    frames++;
    if (!car.grounded) air++;
  }
  check(car.prog.lap >= 1, `${def.name}: AI completes a lap`);
  check(air > 0, `${def.name}: AI also flies`);
}

/* ================= 6b) Bay jump #2 freeze regression ====================== */
section("breeze jump #2 landing");
{
  const scene = new THREE.Scene();
  const track = new Track(scene, TRACKS[2]);
  const ramp = track.rampsWorld[1]; // the table near [-124, 28]
  const car = new Car(scene, 0xff9d00, "J2");
  const ai = new AIDriver(car, track, AI_TIERS[1]);
  const pose = track.poseFor(ramp.s0 - 200, 0);
  car.place(pose.x, pose.z, pose.heading, pose.y);
  track.initProgress(car);
  let landFrame = -1, airFramesTotal = 0, frames = 0;
  const dt = 1 / 60;
  // drive through the jump; after landing, demand: regains speed + responds to steering
  for (let i = 0; i < 60 * 20; i++, frames++) {
    car.update(dt, ai.update(dt, { playerTotal: car.prog.total }), track);
    track.resolveCollision(car);
    track.updateProgress(car);
    if (!car.grounded) airFramesTotal++;
    if (!car.grounded && landFrame < 0 && car.prog.s > ramp.s1 - 10) landFrame = frames;
    if (landFrame > 0 && frames > landFrame + 60 * 4) break;
  }
  const dropFrames = 0;
  console.log(`after J2 landing: v=${car.speed.toFixed(1)} grounded=${car.grounded} lap progress s=${car.prog.s.toFixed(0)}`);
  check(car.grounded, "car is grounded 4s after landing");
  check(car.speed > 8, `car drives on after landing (v=${car.speed.toFixed(1)})`);
  check(car.prog.s > ramp.s1, "car made progress past the ramp");
}

/* ================= 7) GHOST + CONTACTS ==================================== */
section("ghost + contacts");
{
  const scene = new THREE.Scene();
  const track = new Track(scene, TRACKS[0]);
  const car = new Car(scene, 0x39a0ff, "P");
  const pose = track.poseFor(track.length - 10, 0);
  car.place(pose.x, pose.z, pose.heading, pose.y);
  track.initProgress(car);
  const ghost = new GhostSystem(scene);
  ghost.setTrack(track.id);
  ghost.startRecording();
  const dt = 1 / 60, T = 5.0;
  const rec = [];
  for (let t = 0; t < T; t += dt) {
    car.update(dt, { steer: 0.4, throttle: 1, brake: 0, handbrake: false }, track);
    track.updateProgress(car);
    ghost.recordFrame(dt, car);
    rec.push([car.pos.x, car.pos.y, car.pos.z]);
  }
  check(ghost.finishRecording(T), "first best stored");
  ghost.startRecording();
  for (let t = 0; t < T + 1; t += dt) ghost.recordFrame(dt, car);
  check(!ghost.finishRecording(T + 1), "slower lap rejected");
  ghost.startPlayback();
  ghost.enabled = true;
  let maxErr = 0;
  for (let i = 0; i < rec.length - 3; i++) {
    ghost.update(dt);
    maxErr = Math.max(maxErr, Math.hypot(ghost.mesh.position.x - rec[i][0], ghost.mesh.position.y - rec[i][1], ghost.mesh.position.z - rec[i][2]));
  }
  check(maxErr < 0.05, `ghost replays exactly (err=${maxErr.toFixed(3)})`);
}
{
  const scene = new THREE.Scene();
  const a = new Car(scene, 0xff0000, "a"), b = new Car(scene, 0x00ff00, "b");
  a.place(0, 0, 0); b.place(1.0, 0, 0);
  resolveCarContacts([a, b]);
  const sep = a.pos.distanceTo(b.pos);
  a.place(0, 0, 0); b.place(0.9, 2.0, 0);
  a.vel.set(0, 0, 14); b.vel.set(0, 0, 6);
  const dt = 1 / 60;
  a.update(dt, { steer: 0, throttle: 0, brake: 0, handbrake: false });
  b.update(dt, { steer: 0, throttle: 0, brake: 0, handbrake: false });
  resolveCarContacts([a, b]);
  const aDefl = Math.abs(a.vel.x), bDefl = Math.abs(b.vel.x);
  console.log(`sep=${sep.toFixed(2)} deflA=${aDefl.toFixed(1)} deflB=${bDefl.toFixed(1)}`);
  check(sep > 2.5 && aDefl > 0.5 && bDefl > 0.5, "contacts: separate + impulses");
}

/* ================= 8) PERF ================================================ */
section("perf");
{
  const scene = new THREE.Scene();
  const track = new Track(scene, TRACKS[0]);
  const cars = AI_TIERS.map((t) => new Car(scene, t.color, t.name));
  const ais = cars.map((c, i) => new AIDriver(c, track, AI_TIERS[i]));
  cars.forEach((car, i) => {
    const p = track.poseFor(track.length - 16 - i * 7, (i % 2 ? 1 : -1) * 2.6);
    car.place(p.x, p.z, p.heading, p.y);
    track.initProgress(car);
  });
  const dt = 1 / 60, FRAMES = 60 * 20;
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    for (let i = 0; i < ais.length; i++) cars[i].update(dt, ais[i].update(dt, { playerTotal: -20 }), track);
    resolveCarContacts(cars);
    for (const c of cars) { track.resolveCollision(c); track.updateProgress(c); }
  }
  const ms = (performance.now() - t0) / FRAMES;
  console.log(`physics+AI+track 5 cars: ${ms.toFixed(3)} ms/frame`);
  check(ms < 4, "perf headroom");
}

console.log(`\n${totalFailures === 0 ? "ALL SUITES PASS" : totalFailures + " TOTAL FAILURES"}`);
process.exit(totalFailures ? 1 : 0);
