// car.js — arcade drift physics. ONE Car class drives the player AND every AI.
// Also exports the car visual builder (shared with the ghost) and car-vs-car
// contact resolution. Imports nothing but three (no cycles).

import * as THREE from "three";

// ============================================================================
// DRIFT TUNING — all feel lives here. Units: meters, seconds, radians.
// ============================================================================
export const CONFIG = {
  // --- engine / brakes ---
  ENGINE: 16.0,            // forward acceleration (m/s^2) at full throttle
  ENGINE_DRIFT_EFF: 0.82,  // fraction of engine power that reaches the wheels mid-drift
  BRAKE: 26.0,             // braking deceleration (m/s^2)
  REVERSE_SPEED: 9.0,      // max reverse speed (m/s)
  TOP_SPEED: 40.0,         // soft top speed (m/s) ~144 km/h
  HARD_CAP: 50.0,          // absolute speed ceiling (boost can pass TOP_SPEED)
  DRAG: 0.22,              // linear drag coefficient
  QUAD_DRAG: 0.0038,       // quadratic drag coefficient (sets soft top speed)

  // --- steering ---
  YAW_GAIN: 2.0,           // yaw rate target (rad/s) at full lock, gripping
  YAW_GAIN_DRIFT: 2.7,     // yaw rate target at full lock while drifting
  YAW_RESPONSE: 6.0,       // how fast yawRate chases its target (1/s)
  YAW_RESPONSE_HB: 11.0,   // snappier yaw response while handbraking
  STEER_SPEED: 8.0,        // steering input smoothing rate (1/s)
  STEER_SPEED_REF: 7.0,    // speed at which steering reaches full authority (m/s)
  HIGH_SPEED_FALLOFF: 0.016, // yaw gain falls off with speed: 1/(1 + v*this)

  // --- grip: the heart of drifting ---
  GRIP_NORMAL: 8.0,        // lateral velocity decay rate (1/s) while gripping
  GRIP_DRIFT: 3.0,         // how fast lateral velocity chases the commanded slip target
  GRIP_DRIFT_HB: 4.5,      // faster chase while handbraking — the tail snaps out
  DRIFT_STEER_SLIP: 0.5,   // while drifting, full steer commands this slip (ratio of vLat/vLong)
  DRIFT_YAW_DAMP: 2.5,     // relaxes rotation when slip overshoots the commanded angle
  SLIP_ENTER: 0.26,        // slip angle (rad ~15deg) that latches drift state
  SLIP_EXIT: 0.11,         // slip angle below which the drift ends
  SLIP_MAX: 0.85,          // soft cap: extra grip past this slip (~49deg) stops spins
  SLIP_CAP_GRIP: 7.0,      // extra grip rate applied past SLIP_MAX
  DRIFT_MIN_SPEED: 7.0,    // cannot be drifting slower than this (m/s)

  // --- drift control ---
  COUNTERSTEER: 1.0,       // small auto nose-alignment while drifting (keyboard help)
  ASSIST_GRIP: 0.9,        // same assist, normal driving (keeps keyboard driving stable)
  ASSIST_MAX_RATE: 3.0,    // cap on the automatic alignment yaw rate (rad/s)
  YAW_RATE_MAX: 3.0,       // absolute cap on yaw rate (rad/s)
  HANDBRAKE_YAW_KICK: 1.9, // extra yaw target while handbraking — initiates rotation
  HANDBRAKE_DECEL: 7.0,    // forward deceleration while handbrake held

  // --- boost ---
  BOOST_MAX: 7.0,          // speed bonus (m/s) for a max-length drift
  BOOST_TIME_REF: 1.6,     // drift seconds needed for the full boost
  BOOST_MIN_TIME: 0.25,    // shorter drifts give nothing

  // --- score ---
  SCORE_RATE: 12.0,        // points per (|slip| * speed) per second
  COMBO_RATE: 0.35,        // combo growth per second of continuous drift
  COMBO_MAX: 5.0,          // combo ceiling
  COMBO_GRACE: 0.6,        // seconds of straightening before the combo breaks

  // --- jumps (track height field) ---
  GRAVITY: 22.0,           // arcade gravity while airborne (m/s^2)
  JUMP_SLOPE_DROP: 2.6,    // ground must fall away faster than this to launch (m/s)
  JUMP_MEMORY: 3.0,        // how fast recent up-slope momentum decays (1/s) — kicker launch carry
  JUMP_MAX_VY: 14.0,       // cap on launch vertical velocity (anti-catapult)
  JUMP_MIN_SPEED: 6.0,     // below this you just roll over the ramp — no air
  JUMP_MIN_VY: 1.4,        // momentum carry must beat this before a launch counts
  JUMP_VY_PER_V: 0.45,     // launch vertical velocity is capped proportionally to speed
  GROUND_SNAP_MAX: 24.0,   // vertical follow rate cap — telemetry jitter becomes a bump, never a pop
  LANDING_SCRUB: 0.97,     // speed kept after landing
  TRICK_BOOST_RATE: 0.14,  // velocity multiplier per second of air time
  TRICK_BOOST_MAX: 0.6,    // air time (s) counted for the trick boost
  AIRBRAKE_DRAG: 1.6,      // Trackmania airbrake: horizontal velocity decay in flight
  AIRBRAKE_DROP: 8.0,      // extra descent rate while airbraking (drops you short)

  // --- boost pads ---
  PAD_FORCE: 22.0,         // extra acceleration while pad boost is active (m/s^2)
  PAD_TIME: 0.75,          // boost duration after leaving the pad (s)
};

// ---------------------------------------------------------------------------
// SURFACES — physics multipliers per road surface (track.js uses .tint for
// the road vertex color). engine/grip scale the base constants; drag is a
// flat decel (m/s^2) while rolling.
// ---------------------------------------------------------------------------
export const SURFACES = {
  asphalt: { grip: 1.0,  engine: 1.0,  drag: 0,   tint: [0.24, 0.25, 0.28] },
  dirt:    { grip: 0.5,  engine: 0.62, drag: 7.0, tint: [0.5, 0.36, 0.2] },
  ice:     { grip: 0.3,  engine: 0.55, drag: 0,   tint: [0.5, 0.72, 0.88] },
  kerb:    { grip: 0.85, engine: 0.8,  drag: 3.0, tint: [0.75, 0.2, 0.2] },
};

const clamp = THREE.MathUtils.clamp;

// ---------------------------------------------------------------------------
// Shared car visual. ghost=true builds a translucent collision-free clone.
// ---------------------------------------------------------------------------
export function buildCarMesh(color = 0x3ea6ff, ghost = false) {
  const group = new THREE.Group();
  const mat = (c) => ghost
    ? new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.32, depthWrite: false })
    : new THREE.MeshPhongMaterial({ color: c, shininess: 70, specular: 0x4a5a6d });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.42, 2.9), mat(color));
  body.position.y = 0.5;
  group.add(body);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.24, 0.7), mat(color));
  nose.position.set(0, 0.4, 1.68);
  group.add(nose);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.36, 1.3), mat(ghost ? color : 0x18222c));
  cabin.position.set(0, 0.86, -0.3);
  group.add(cabin);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.4), mat(ghost ? color : 0x111418));
  wing.position.set(0, 0.86, -1.5);
  group.add(wing);

  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 12);
  wheelGeo.rotateZ(Math.PI / 2); // cylinder axis -> x, so rotating on x spins the wheel
  const wheelMat = mat(ghost ? color : 0x14161a);
  const wheels = [];
  const fl = new THREE.Group();
  const fr = new THREE.Group();
  fl.position.set(-0.78, 0.34, 1.1);
  fr.position.set(0.78, 0.34, 1.1);
  fl.add(new THREE.Mesh(wheelGeo, wheelMat));
  fr.add(new THREE.Mesh(wheelGeo, wheelMat));
  wheels.push(fl.children[0], fr.children[0]);
  for (const x of [-0.78, 0.78]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.position.set(x, 0.34, -1.15);
    group.add(w);
    wheels.push(w);
  }
  group.add(fl, fr);

  group.userData.wheels = wheels;
  group.userData.frontAxle = [fl, fr];
  group.userData.body = body;
  return group;
}

// ---------------------------------------------------------------------------
// The car. Physics is planar (XZ): velocity lives in world space, the nose
// (heading) rotates independently, and lateral grip re-aligns them. Drifting
// is what happens when that grip is deliberately too weak.
// ---------------------------------------------------------------------------
export class Car {
  constructor(scene, color, name = "car") {
    this.name = name;
    this.color = color;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.heading = 0;
    this.yawRate = 0;
    this.steerSmooth = 0;
    this.slipAngle = 0;
    this.vLong = 0;
    this.vLat = 0;

    // drift / scoring state
    this.drifting = false;
    this.driftTime = 0;
    this.combo = 1;
    this.comboGrace = 0;
    this.score = 0;
    this.boostFlash = 0;   // HUD flash timer when a boost fires

    this.wallHit = false;  // set by track.resolveCollision, consumed here
    this.engineScale = 1;  // AI rubber-band hook (player stays 1)
    this.wheelSpin = 0;

    // vertical state (jumps)
    this.vy = 0;
    this.grounded = true;
    this.airTime = 0;
    this.pitch = 0;
    this._lastGround = undefined;
    this._launchVy = 0;
    this._dropFrames = 0;
    this.padBoost = 0;

    this.mesh = buildCarMesh(color);
    scene.add(this.mesh);

    // soft blob shadow that grounds the car visually (stays on the terrain)
    const shadowGeo = new THREE.CircleGeometry(1.55, 20);
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(shadowGeo,
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false }));
    this.shadow.renderOrder = 4;
    scene.add(this.shadow);

    this.prog = null;      // attached by track.initProgress
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.z); }
  get speedKmh() { return this.speed * 3.6; }

  forwardX() { return Math.sin(this.heading); }
  forwardZ() { return Math.cos(this.heading); }

  place(x, z, heading, y = 0) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.heading = heading;
    this.yawRate = 0;
    this.steerSmooth = 0;
    this.slipAngle = 0;
    this.drifting = false;
    this.driftTime = 0;
    this.combo = 1;
    this.comboGrace = 0;
    this.wallHit = false;
    this.vy = 0;
    this.grounded = true;
    this.airTime = 0;
    this.pitch = 0;
    this._lastGround = undefined;
    this._launchVy = 0;
    this._dropFrames = 0;
    this.padBoost = 0;
    this.syncMesh(0);
  }

  update(dt, input, track = null) {
    const C = CONFIG;
    if (dt <= 0) return;

    // --- smooth the (binary keyboard) steering input a little ---
    const steerIn = clamp(input.steer || 0, -1, 1);
    this.steerSmooth += (steerIn - this.steerSmooth) * Math.min(1, C.STEER_SPEED * dt);

    // --- airborne: ballistic arc. Brake in flight = Trackmania airbrake:
    // strong aero drag + drops you short. No grip/engine authority in the air.
    if (!this.grounded) {
      this.airTime += dt;
      this.vy -= C.GRAVITY * dt;
      this.vel.multiplyScalar(Math.exp(-0.05 * dt));
      if (input.brake) {
        this.vel.multiplyScalar(Math.exp(-C.AIRBRAKE_DRAG * dt));
        this.vy -= C.AIRBRAKE_DROP * dt;
      }
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      this.pos.y += this.vy * dt;
      const pitchT = clamp(-this.vy * 0.02, -0.3, 0.35);
      this.pitch += (pitchT - this.pitch) * Math.min(1, 6 * dt);
      if (track) {
        const g = track.heightAt(this.prog ? this.prog.s : 0);
        if (this.pos.y <= g) {
          // touchdown: small scrub, trick boost by air time
          this.pos.y = g;
          this.grounded = true;
          this.vy = 0;
          this._lastGround = g;   // stale takeoff ground must not fake a re-launch
          this._dropFrames = 0;
          const trick = 1 + Math.min(this.airTime, C.TRICK_BOOST_MAX) * C.TRICK_BOOST_RATE;
          this.vel.x *= C.LANDING_SCRUB * (this.airTime > 0.3 ? trick : 1);
          this.vel.z *= C.LANDING_SCRUB * (this.airTime > 0.3 ? trick : 1);
          if (this.airTime > 0.3) this.boostFlash = 0.8;
          this.airTime = 0;
          this.pitch = 0;
        }
      }
      this.syncMesh(dt);
      return;
    }

    // surface under the tires right now (asphalt / dirt / ice)
    const surfType = track ? track.surfaceAt(this.prog ? this.prog.s : 0) : "asphalt";
    const S = SURFACES[surfType] || SURFACES.asphalt;

    const sinH = Math.sin(this.heading), cosH = Math.cos(this.heading);
    const fx = sinH, fz = cosH;   // forward (matches mesh rotation.y = heading)
    const rx = cosH, rz = -sinH;  // right
    const vLong = this.vel.x * fx + this.vel.z * fz;
    const vLat = this.vel.x * rx + this.vel.z * rz;
    const speed = this.speed;
    this.vLong = vLong;
    this.vLat = vLat;
    this.slipAngle = Math.atan2(vLat, Math.max(Math.abs(vLong), 0.5));

    // --- drift state: slip-based hysteresis + handbrake/brake latch. Drift
    // initiates by handbrake OR by braking hard into a corner with real tail
    // slip (weight transfer). Handbrake latches instantly; everything else
    // must break traction via actual slip.
    const wasDrifting = this.drifting;
    const absSlip = Math.abs(this.slipAngle);
    const hbActive = input.handbrake && vLong > C.DRIFT_MIN_SPEED * 0.7;
    const brakeSlide = (input.brake || 0) > 0.4 && Math.abs(this.steerSmooth) > 0.35 && absSlip > C.SLIP_EXIT * 0.5 && vLong > C.DRIFT_MIN_SPEED;
    if (!this.drifting) {
      if ((vLong > C.DRIFT_MIN_SPEED && absSlip > C.SLIP_ENTER) ||
          (input.handbrake && Math.abs(this.steerSmooth) > 0.3 && vLong > C.DRIFT_MIN_SPEED)) {
        this.drifting = true;
      }
    } else if (vLong < C.DRIFT_MIN_SPEED * 0.7 || (absSlip < C.SLIP_EXIT && !hbActive && !brakeSlide)) {
      this.drifting = false;
    }

    // --- clean drift exit => boost, scaled by how long the slide was held ---
    let pendingBoost = 0;
    if (wasDrifting && !this.drifting &&
        this.driftTime > C.BOOST_MIN_TIME && !this.wallHit) {
      pendingBoost = C.BOOST_MAX * Math.min(1, this.driftTime / C.BOOST_TIME_REF);
    }

    // --- lateral grip: while gripping, lateral velocity simply decays (the
    // velocity chases the nose). While sliding (drift latched or handbrake),
    // the steering instead COMMANDS a slip angle that the slide hunts toward —
    // this is what lets the player hold a sustained, controllable drift, and
    // what makes the handbrake snap the tail out.
    let nvLat;
    const sliding = this.drifting || hbActive || brakeSlide;
    if (sliding) {
      // steering INTO the corner commands the slide; physics sign: steering
      // left (+1) slides the tail right => negative lateral chase target.
      const latTarget = -this.steerSmooth * vLong * C.DRIFT_STEER_SLIP;
      const chase = (hbActive ? C.GRIP_DRIFT_HB : C.GRIP_DRIFT) * S.grip;
      nvLat = vLat + (latTarget - vLat) * Math.min(1, chase * dt);
    } else {
      nvLat = vLat * Math.exp(-C.GRIP_NORMAL * S.grip * dt);
    }
    // soft slip cap: past SLIP_MAX the tires "catch" — very hard to spin out
    if (Math.abs(Math.atan2(nvLat, Math.max(Math.abs(vLong), 0.5))) > C.SLIP_MAX) {
      nvLat *= Math.exp(-C.SLIP_CAP_GRIP * dt);
    }

    // --- longitudinal ---
    let nvLong = vLong;
    const eff = this.drifting ? C.ENGINE_DRIFT_EFF : 1;
    if (input.throttle) nvLong += C.ENGINE * S.engine * input.throttle * this.engineScale * eff * dt;
    if (input.brake) {
      if (nvLong > 0.4) nvLong -= C.BRAKE * input.brake * dt;
      else nvLong = Math.max(nvLong - C.BRAKE * 0.45 * input.brake * dt, -C.REVERSE_SPEED);
    }
    if (input.handbrake && nvLong > 0) nvLong = Math.max(0, nvLong - C.HANDBRAKE_DECEL * dt);
    // boost pads kick hard, fading as the timer runs out
    if (this.padBoost > 0) {
      nvLong += C.PAD_FORCE * (this.padBoost / C.PAD_TIME) * dt;
      this.padBoost -= dt;
      this.boostFlash = Math.max(this.boostFlash, 0.2);
    }
    nvLong -= nvLong * C.DRAG * dt;
    nvLong -= nvLong * Math.abs(nvLong) * C.QUAD_DRAG * dt;
    if (S.drag > 0 && Math.abs(nvLong) > 0.5) nvLong -= Math.sign(nvLong) * S.drag * dt; // dirt/rough drag
    nvLong = clamp(nvLong, -C.REVERSE_SPEED, C.HARD_CAP);
    if (pendingBoost > 0) {
      nvLong = Math.min(nvLong + pendingBoost, C.HARD_CAP);
      this.boostFlash = 0.9;
    }
    this.boostFlash = Math.max(0, this.boostFlash - dt);

    // --- drift score & combo ---
    if (this.drifting) {
      this.driftTime += dt;
      this.combo = Math.min(C.COMBO_MAX, 1 + this.driftTime * C.COMBO_RATE);
      this.comboGrace = C.COMBO_GRACE;
      this.score += Math.abs(this.slipAngle) * speed * C.SCORE_RATE * this.combo * dt;
    } else {
      this.comboGrace -= dt;
      if (this.comboGrace <= 0) { this.combo = 1; this.driftTime = 0; }
    }
    if (this.wallHit) { this.combo = 1; this.driftTime = 0; this.comboGrace = 0; }

    // --- yaw dynamics ---
    const dirSign = nvLong >= 0 ? 1 : -1; // steering mirrors in reverse
    // low-speed pivot assist: parked against a wall you can still rotate out
    const spdFac = Math.max(Math.min(Math.abs(nvLong) / C.STEER_SPEED_REF, 1), input.throttle ? 0.32 : 0.05) * dirSign;
    const falloff = 1 / (1 + Math.abs(nvLong) * C.HIGH_SPEED_FALLOFF);
    const yawGain = this.drifting ? C.YAW_GAIN_DRIFT : C.YAW_GAIN;
    let yawTarget = this.steerSmooth * yawGain * spdFac * falloff;
    if (this.drifting) {
      // over/under-rotation feedback: rotation eases off once the actual slip
      // reaches the commanded one — the closed loop that keeps it holdable.
      const cmdSlip = Math.atan2(-this.steerSmooth * Math.max(Math.abs(vLong), 1) * C.DRIFT_STEER_SLIP, Math.max(Math.abs(vLong), 1));
      yawTarget += (this.slipAngle - cmdSlip) * C.DRIFT_YAW_DAMP * dirSign;
    }
    if (input.handbrake) yawTarget += this.steerSmooth * C.HANDBRAKE_YAW_KICK * dirSign;
    const resp = input.handbrake ? C.YAW_RESPONSE_HB : C.YAW_RESPONSE;
    this.yawRate += (yawTarget - this.yawRate) * Math.min(1, resp * dt);
    this.yawRate = clamp(this.yawRate, -C.YAW_RATE_MAX, C.YAW_RATE_MAX);
    this.heading += this.yawRate * dt;

    // --- countersteer assist: rotate the nose toward the velocity direction.
    // Strong while drifting (this is what makes keyboard drifting holdable),
    // gentle otherwise (stability). Never reverses the slide, only caps it. ---
    const assist = this.drifting ? C.COUNTERSTEER : C.ASSIST_GRIP;
    const assistRate = clamp(this.slipAngle * assist, -C.ASSIST_MAX_RATE, C.ASSIST_MAX_RATE);
    this.heading += assistRate * dt * Math.min(speed / C.STEER_SPEED_REF, 1);

    // --- recompose velocity in the PRE-rotation axes. The heading turned but
    // the momentum did not — that lag *is* the drift. ---
    this.vel.set(fx * nvLong + rx * nvLat, 0, fz * nvLong + rz * nvLat);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // --- ground following / jump launch detection / boost pads ---
    if (track) {
      const sNow = this.prog ? this.prog.s : 0;
      const g1 = track.heightAt(sNow);
      if (this._lastGround !== undefined) {
        const slopeVy = clamp((g1 - this._lastGround) / dt, -30, 30);
        // launch momentum memory: recent up-slope vy, decaying ~0.3s, so a
        // ramp lip with a short flat still throws you off the climb's carry
        this._launchVy = Math.max(this._launchVy * Math.exp(-C.JUMP_MEMORY * dt), Math.max(slopeVy, 0));
        // require a SUSTAINED drop (or a very sharp one): sliding across a
        // hairpin makes the s-telemetry jump between branches temporarily,
        // and a single jitter frame must never launch the car
        this._dropFrames = slopeVy < -C.JUMP_SLOPE_DROP ? this._dropFrames + 1 : 0;
        const wantsLaunch = this._dropFrames >= 2 || slopeVy < -8;
        if (wantsLaunch && speed > C.JUMP_MIN_SPEED && this._launchVy > C.JUMP_MIN_VY) {
          // ground falls away fast AND we're carrying speed: launched. Jump
          // height scales with how fast you were going.
          this.grounded = false;
          this.vy = clamp(this._launchVy, 0, Math.min(C.JUMP_MAX_VY, C.JUMP_VY_PER_V * speed));
          this._launchVy = 0;
          this.airTime = 0;
          this.drifting = false;
          this._dropFrames = 0;
        } else {
          // rate-limited ground follow: telemetry jitter shows as a bump,
          // never a vertical pop
          this.pos.y += clamp(g1 - this.pos.y, -C.GROUND_SNAP_MAX * dt, C.GROUND_SNAP_MAX * dt);
          this.vy = slopeVy;
          this.pitch += (clamp(slopeVy / Math.max(speed, 4), -0.35, 0.35) - this.pitch) * Math.min(1, 8 * dt);
        }
      } else {
        this.pos.y = g1;
        this.vy = 0;
        this._launchVy = 0;
      }
      this._lastGround = g1;
      // glowing dash panels
      if (track.padAt(sNow) && vLong > 2) this.padBoost = C.PAD_TIME;
    }

    this.wallHit = false; // consumed
    this.syncMesh(dt);
  }

  syncMesh(dt) {
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.heading;
    this.mesh.rotation.x = -this.pitch; // nose up when climbing/launching
    this.wheelSpin += (this.grounded ? this.vLong : Math.hypot(this.vel.x, this.vel.z)) * dt / 0.34;
    const wheels = this.mesh.userData.wheels;
    for (let i = 0; i < wheels.length; i++) wheels[i].rotation.x = this.wheelSpin % (Math.PI * 2);
    const axle = this.mesh.userData.frontAxle;
    const steerVis = this.steerSmooth * 0.5;
    axle[0].rotation.y = steerVis;
    axle[1].rotation.y = steerVis;
    // a little body lean sells the slide
    this.mesh.userData.body.rotation.z = clamp(-this.steerSmooth * 0.06 - this.slipAngle * 0.05, -0.14, 0.14);
    // blob shadow: on the surface while grounded, left behind on the ground while airborne
    const groundY = this.grounded ? this.pos.y : (this._lastGround !== undefined ? this._lastGround : 0);
    this.shadow.position.set(this.pos.x, groundY + 0.03, this.pos.z);
    this.shadow.material.opacity = this.grounded ? 0.3 : Math.max(0.04, 0.3 - (this.pos.y - groundY) * 0.05);
  }
}

// ---------------------------------------------------------------------------
// Car-vs-car contact: equal masses, push-out + real impulse. Nobody passes
// through anybody.
// ---------------------------------------------------------------------------
const CAR_RADIUS = 1.35;
export function resolveCarContacts(cars) {
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i], b = cars[j];
      if (Math.abs(a.pos.y - b.pos.y) > 1.4) continue; // can't bump a flying car
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      const minD = CAR_RADIUS * 2;
      if (d2 >= minD * minD || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      const overlap = minD - d;
      // separate equally
      a.pos.x -= nx * overlap * 0.5;
      a.pos.z -= nz * overlap * 0.5;
      b.pos.x += nx * overlap * 0.5;
      b.pos.z += nz * overlap * 0.5;
      // impulse along the normal (restitution 0.25)
      const rvn = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
      if (rvn < 0) {
        const jimp = -(1 + 0.25) * rvn * 0.5;
        a.vel.x -= nx * jimp;
        a.vel.z -= nz * jimp;
        b.vel.x += nx * jimp;
        b.vel.z += nz * jimp;
      }
      a.syncMesh(0);
      b.syncMesh(0);
    }
  }
}
