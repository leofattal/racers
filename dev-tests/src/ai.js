// ai.js — rival drivers. They drive the SAME Car physics as the player
// (car.update with an input vector): pure-pursuit steering with speed-scaled
// lookahead, curvature-based braking (not fixed brake points), handbrake
// pulses to initiate real drifts, and mild rubber-banding.

import { CONFIG } from "./car.js";

export const AI_TIERS = [
  { name: "VEX",   color: 0xe6484d, pace: 1.00, driftiness: 1.0  },
  { name: "KAIRO", color: 0xf08a2e, pace: 0.975, driftiness: 0.75 },
  { name: "MIRA",  color: 0x9a5be8, pace: 0.95, driftiness: 0.5  },
  { name: "JOLT",  color: 0x3ecf6e, pace: 0.92, driftiness: 0.35 },
];

// Bots park for good once they finish the race: hidden, excluded from physics
// and collisions. Returns the cars still racing.
export function finishCars(aiCars, laps) {
  const active = [];
  for (const c of aiCars) {
    if (!c.finished && c.prog && c.prog.lap >= laps) {
      c.finished = true;
      c.mesh.visible = false;
      if (c.shadow) c.shadow.visible = false;
    }
    if (!c.finished) active.push(c);
  }
  return active;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class AIDriver {
  constructor(car, track, tier) {
    this.car = car;
    this.track = track;
    this.tier = tier;
    this.skill = 1;
    this.setSkill(1);
    this.driftTimer = 0;
    this.driftCooldown = 0;
    car.aiName = tier.name;
  }

  // difficulty: scales top speed and engine (0.9 easy .. 1.06 hard)
  setSkill(k) {
    this.skill = k;
    this.topSpeed = CONFIG.TOP_SPEED * (0.94 + this.tier.pace * 0.06) * k;
  }

  // ctx: { playerTotal } — race progress of the player, for rubber-banding
  update(dt, ctx) {
    const car = this.car, track = this.track;
    const s = car.prog ? car.prog.s : 0;
    const v = car.speed;

    // --- rubber-banding: gentle, capped, never teleports ---
    let rubber = 1;
    if (ctx && typeof ctx.playerTotal === "number" && car.prog) {
      const delta = ctx.playerTotal - car.prog.total; // >0 means this AI is behind
      rubber = clamp(1 + delta * 0.0009, 0.94, 1.06);
    }
    car.engineScale = this.tier.pace * rubber * this.skill;

    // --- pure-pursuit steering with speed-scaled lookahead ---
    const look = clamp(v * 0.6, 7, 24);
    const tp = track.pointAt(s + look);
    const dx = tp.x - car.pos.x, dz = tp.z - car.pos.z;
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
    const rx = fz, rz = -fx;
    const dl = Math.hypot(dx, dz) || 1;
    const bearing = Math.atan2((dx * rx + dz * rz) / dl, (dx * fx + dz * fz) / dl);
    let steer = clamp(bearing * 2.4, -1, 1);

    // --- speed control from upcoming curvature. Drift-happy tiers carry
    // excess speed into corners on purpose (they rotate with the handbrake).
    const csRaw = track.minCornerSpeed(s + v * 0.25, (v * v) / (2 * 26 * 0.55) + look * 0.5 + 14);
    const speedBias = 1.13 + this.tier.driftiness * 0.14;
    const target = Math.min(csRaw * speedBias, this.topSpeed * rubber);
    let throttle = 0, brake = 0;
    if (v > target + 0.6) {
      brake = clamp((v - target) * 0.3, 0, 1);
    } else {
      throttle = clamp((target - v) * 0.3 + 0.55, 0, 1);
      if (Math.abs(steer) > 0.85 && v > target) throttle = 0.25;
    }

    // --- drift initiation: hard corner coming and carrying too much speed ->
    // pulse the handbrake, exactly what a player does. The physics do the rest.
    this.driftCooldown = Math.max(0, this.driftCooldown - dt);
    if (this.driftTimer > 0) {
      this.driftTimer -= dt;
    } else if (
      this.driftCooldown <= 0 &&
      Math.abs(steer) > 0.5 &&
      v > 13 &&
      v > csRaw * 1.1 + (1 - this.tier.driftiness) * 2
    ) {
      this.driftTimer = 0.22 + this.tier.driftiness * 0.22;
      this.driftCooldown = 1.6;
    }
    const handbrake = this.driftTimer > 0 && Math.abs(steer) > 0.2;

    // never parked: pure pursuit already points recovery
    return { steer, throttle, brake, handbrake };
  }
}
