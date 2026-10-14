// particles.js — recycled pool of billboard sprites: drift smoke, dirt roost,
// ice spray, wall-impact sparks, landing dust, boost flame. No allocations
// per frame; everything pre-allocated at init.

import * as THREE from "three";
import { makeSoftTexture } from "./env.js";

const COLORS = {
  asphalt: 0xcfd3d8,
  dirt: 0xc9a067,
  ice: 0xe8f6ff,
};

export class Particles {
  constructor(scene, capacity = 320) {
    this.pool = [];
    this.cursor = 0;
    this.cap = capacity;
    const tex = makeSoftTexture(64);
    for (let i = 0; i < capacity; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
      const m = new THREE.Sprite(mat);
      m.visible = false;
      m.renderOrder = 6;
      scene.add(m);
      this.pool.push({ mesh: m, life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0, grow: 1, spark: false, drag: 1 });
    }
    this.accum = new Map(); // car -> spawn accumulator
  }

  // kind: "smoke" (grows, fades) | "spark" (additive, small, fast, falls)
  burst(x, y, z, color, spread, count = 6, kind = "smoke", opts = {}) {
    for (let k = 0; k < count; k++) {
      const p = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % this.cap;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      const spark = kind === "spark";
      p.spark = spark;
      p.mesh.position.set(x + Math.sin(a) * r * 0.4, y + (spark ? 0.3 : 0.15), z + Math.cos(a) * r * 0.4);
      const sp = spark ? 4 + Math.random() * 6 : spread * 0.5;
      p.vx = Math.sin(a) * sp + (opts.vx || 0);
      p.vy = spark ? 1 + Math.random() * 5 : 0.9 + Math.random() * 1.8;
      p.vz = Math.cos(a) * sp + (opts.vz || 0);
      p.maxLife = p.life = spark ? 0.25 + Math.random() * 0.3 : (opts.life || 0.6) + Math.random() * 0.4;
      p.grow = spark ? 0 : (opts.grow ?? 2.0);
      p.drag = spark ? 1.5 : 0.6;
      p.mesh.material.color.setHex(color);
      p.mesh.material.blending = spark ? THREE.AdditiveBlending : THREE.NormalBlending;
      p.mesh.material.opacity = spark ? 0.95 : (opts.opacity ?? 0.5);
      p.mesh.scale.setScalar(spark ? 0.25 + Math.random() * 0.2 : (opts.size || 0.9) * (0.7 + Math.random() * 0.6));
      p.mesh.visible = true;
    }
  }

  update(dt, cars, track) {
    for (const car of cars) {
      const fx = car.forwardX(), fz = car.forwardZ();
      const bx = car.pos.x - fx * 1.4, bz = car.pos.z - fz * 1.4;
      // boost flame from the exhausts
      if (car.grounded && (car.boostFlash > 0.3 || car.padBoost > 0)) {
        this.burst(bx, car.pos.y + 0.3, bz, car.padBoost > 0 ? 0xffb040 : 0x58c8ff, 0.3, 1, "spark", { vx: -fx * 6, vz: -fz * 6 });
      }
      if (!car.grounded) { this.accum.set(car, 0); continue; }
      const slippage = Math.abs(car.vLat);
      const heavy = car.drifting || slippage > 4 || car.wallHit;
      if (!heavy) { this.accum.set(car, 0); continue; }
      const surf = track ? track.surfaceAt(car.prog ? car.prog.s : 0) : "asphalt";
      const color = COLORS[surf] || COLORS.asphalt;
      const rate = Math.min(Math.abs(car.slipAngle) * car.speed * 1.3 + (car.wallHit ? 40 : 0), 80);
      let acc = (this.accum.get(car) || 0) + rate * dt;
      while (acc >= 1) {
        acc -= 1;
        this.burst(bx, car.pos.y, bz, color, 1.3, 1, "smoke", { opacity: surf === "ice" ? 0.6 : 0.42, size: surf === "dirt" ? 1.0 : 1.1 });
      }
      this.accum.set(car, acc);
      if (car.wallHit) {
        const rx = fz, rz = -fx;
        const side = Math.sign(car.vLat || 1);
        this.burst(car.pos.x + rx * side * 0.9, car.pos.y + 0.2, car.pos.z + rz * side * 0.9, 0xffb050, 0.4, 5, "spark", { vx: fx * car.speed * 0.3, vz: fz * car.speed * 0.3 });
      }
    }
    // integrate
    for (const p of this.pool) {
      if (!p.mesh.visible) continue;
      p.life -= dt;
      if (p.life <= 0) { p.mesh.visible = false; continue; }
      const m = p.mesh;
      m.position.x += p.vx * dt;
      m.position.y += p.vy * dt;
      m.position.z += p.vz * dt;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vz *= k;
      p.vy -= (p.spark ? 14 : 1.2) * dt;
      if (p.spark) {
        if (m.position.y < 0.05) { p.life = 0; m.visible = false; continue; }
        m.material.opacity = Math.min(1, p.life / p.maxLife * 1.5);
      } else {
        m.scale.multiplyScalar(1 + p.grow * dt);
        m.material.opacity *= Math.exp(-2.4 * dt);
      }
    }
  }

  // one-off puff (landing dust, respawn)
  puff(x, y, z, color = 0xd8d2c4, count = 10) {
    this.burst(x, y, z, color, 2.2, count, "smoke", { opacity: 0.5, size: 1.3, grow: 1.6 });
  }
}
