// particles.js — tiny recycled pool of ground-level dust puffs: drift smoke,
// dirt roost, ice spray, wall-impact bursts. No textures, no allocations per
// frame; everything pre-allocated at init.

import * as THREE from "three";

const COLORS = {
  asphalt: [0xd9d9d9, 0x777777],
  dirt: [0xcaa46a, 0x8a6b3d],
  ice: [0xffffff, 0xbfe4ff],
};

export class Particles {
  constructor(scene, capacity = 260) {
    this.pool = [];
    this.cursor = 0;
    const geo = new THREE.PlaneGeometry(0.55, 0.55);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < capacity; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 5;
      scene.add(m);
      this.pool.push({ mesh: m, life: 0, vx: 0, vy: 0, vz: 0, spin: 0 });
    }
    this.accum = new Map(); // car -> spawn accumulator
    this.cap = capacity;
  }

  burst(x, y, z, color, spread, count = 6) {
    for (let k = 0; k < count; k++) {
      const p = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % this.cap;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      p.mesh.position.set(x + Math.sin(a) * r * 0.4, y + 0.12, z + Math.cos(a) * r * 0.4);
      p.vx = Math.sin(a) * spread * 0.5;
      p.vy = 1.2 + Math.random() * 2.2;
      p.vz = Math.cos(a) * spread * 0.5;
      p.life = 0.55 + Math.random() * 0.35;
      p.mesh.material.color.setHex(color);
      p.mesh.material.opacity = 0.55;
      p.mesh.scale.setScalar(0.6 + Math.random() * 0.5);
      p.mesh.visible = true;
      p.spin = (Math.random() - 0.5) * 6;
    }
  }

  update(dt, cars, track) {
    // spawn: drifting cars roost from the rear axle; surface picks the color
    for (const car of cars) {
      if (!car.grounded) continue;
      const slippage = Math.abs(car.vLat);
      const heavy = car.drifting || slippage > 4 || car.wallHit;
      if (!heavy) { this.accum.set(car, 0); continue; }
      const surf = track ? track.surfaceAt(car.prog ? car.prog.s : 0) : "asphalt";
      const [c1] = COLORS[surf] || COLORS.asphalt;
      const rate = Math.min(Math.abs(car.slipAngle) * car.speed * 1.2 + (car.wallHit ? 60 : 0), 90);
      let acc = (this.accum.get(car) || 0) + rate * dt;
      const fx = car.forwardX(), fz = car.forwardZ();
      while (acc >= 1) {
        acc -= 1;
        this.burst(car.pos.x - fx * 1.3, car.pos.y, car.pos.z - fz * 1.3, c1, 1.2, 1);
      }
      this.accum.set(car, acc);
    }
    // integrate
    for (const p of this.pool) {
      if (!p.mesh.visible) continue;
      p.life -= dt;
      if (p.life <= 0) { p.mesh.visible = false; continue; }
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.vy -= 2.5 * dt;
      p.mesh.rotation.y += p.spin * dt;
      p.mesh.scale.multiplyScalar(1 + 2.2 * dt);
      p.mesh.material.opacity *= Math.exp(-2.8 * dt);
    }
  }
}
