// skidmarks.js — persistent tyre marks. One dynamic mesh holds a ring buffer
// of quads; every drifting/sliding car lays a strip behind each rear wheel.
// Old marks are overwritten by new ones once the buffer wraps.

import * as THREE from "three";

const WHEEL_X = 0.78, WHEEL_Z = -1.15, WIDTH = 0.3;

export class SkidMarks {
  constructor(scene, max = 4000) {
    this.max = max;
    this.cursor = 0;
    this.pos = new Float32Array(max * 4 * 3);
    this.alpha = new Float32Array(max * 4);
    const idx = new Uint32Array(max * 6);
    for (let i = 0; i < max; i++) {
      const v = i * 4, o = i * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v + 1; idx[o + 4] = v + 3; idx[o + 5] = v + 2;
    }
    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alpha, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", this.posAttr);
    this.geo.setAttribute("alpha", this.alphaAttr);
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      vertexShader: `
        attribute float alpha; varying float vA;
        void main() { vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying float vA;
        void main() { gl_FragColor = vec4(0.04, 0.04, 0.05, vA); }`,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);
    this.last = new Map(); // car -> [{x,y,z}|null, {x,y,z}|null]
    this.dirty = false;
  }

  clear() {
    this.pos.fill(0);
    this.alpha.fill(0);
    this.cursor = 0;
    this.last.clear();
    this.dirty = true;
  }

  _quad(a, b, alpha) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len * WIDTH * 0.5, nz = dx / len * WIDTH * 0.5;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const p = this.pos, v = i * 12;
    p[v] = a.x - nx; p[v + 1] = a.y; p[v + 2] = a.z - nz;
    p[v + 3] = a.x + nx; p[v + 4] = a.y; p[v + 5] = a.z + nz;
    p[v + 6] = b.x - nx; p[v + 7] = b.y; p[v + 8] = b.z - nz;
    p[v + 9] = b.x + nx; p[v + 10] = b.y; p[v + 11] = b.z + nz;
    const al = this.alpha, w = i * 4;
    al[w] = al[w + 1] = al[w + 2] = al[w + 3] = alpha;
    this.dirty = true;
  }

  update(cars) {
    for (const car of cars) {
      let intensity = 0;
      if (car.grounded) {
        if (car.drifting) intensity = Math.min(1, Math.abs(car.slipAngle) * 1.6 + 0.2);
        else if (Math.abs(car.vLat) > 3) intensity = 0.4;
        else if (car.braking && car.speed > 12) intensity = 0.3;
      }
      if (intensity < 0.15) { this.last.delete(car); continue; }
      const fx = car.forwardX(), fz = car.forwardZ();
      const rx = fz, rz = -fx;
      const y = car.pos.y + 0.03;
      const prev = this.last.get(car) || [null, null];
      const next = [null, null];
      for (let w = 0; w < 2; w++) {
        const side = w === 0 ? -1 : 1;
        const cur = { x: car.pos.x + fx * WHEEL_Z + rx * WHEEL_X * side, y, z: car.pos.z + fz * WHEEL_Z + rz * WHEEL_X * side };
        const p = prev[w];
        if (p) {
          const d = Math.hypot(cur.x - p.x, cur.z - p.z);
          if (d > 6) { next[w] = cur; continue; }     // teleport: restart strip
          if (d < 0.22) { next[w] = p; continue; }    // too short: wait
          this._quad(p, cur, intensity * 0.7);
        }
        next[w] = cur;
      }
      this.last.set(car, next);
    }
    if (this.dirty) {
      this.posAttr.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
      this.dirty = false;
    }
  }
}
