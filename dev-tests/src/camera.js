// camera.js — chase camera with positional lag and drift-aware swing.
import * as THREE from "three";

export class ChaseCam {
  constructor(camera) {
    this.cam = camera;
    this.pos = new THREE.Vector3(0, 4, -10);
    this.look = new THREE.Vector3();
    this.fov = 62;
    this.initialized = false;
  }

  snapTo(car) {
    const fx = car.forwardX(), fz = car.forwardZ();
    this.pos.set(car.pos.x - fx * 7, car.pos.y + 3, car.pos.z - fz * 7);
    this.look.set(car.pos.x, car.pos.y + 1, car.pos.z);
    this.initialized = true;
  }

  update(dt, car) {
    if (!this.initialized) this.snapTo(car);
    const fx = car.forwardX(), fz = car.forwardZ();
    // camera swings to the OUTSIDE of the slide so you can see the corner
    const swing = THREE.MathUtils.clamp(car.slipAngle, -0.75, 0.75);
    const dist = 7.0 + Math.abs(car.vLong) * 0.035;
    const desiredX = car.pos.x - fx * dist + fz * swing * 4.2;
    const desiredZ = car.pos.z - fz * dist - fx * swing * 4.2;
    const desiredY = car.pos.y + 2.9 + Math.abs(swing) * 0.5 + (car.grounded ? 0 : 0.7);

    const k = 1 - Math.exp(-4.5 * dt);       // positional lag
    this.pos.x += (desiredX - this.pos.x) * k;
    this.pos.y += (desiredY - this.pos.y) * k;
    this.pos.z += (desiredZ - this.pos.z) * k;

    const vl = Math.max(car.speed, 0.001);
    const vx = car.vel.x / vl, vz = car.vel.z / vl;
    const lookX = car.pos.x + (fx * 0.6 + vx * 0.4) * 7;
    const lookZ = car.pos.z + (fz * 0.6 + vz * 0.4) * 7;
    const kk = 1 - Math.exp(-9 * dt);        // look target is snappier
    this.look.x += (lookX - this.look.x) * kk;
    this.look.y += (car.pos.y + 1.1 - this.look.y) * kk;
    this.look.z += (lookZ - this.look.z) * kk;

    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);

    // speed-based FOV kick
    const targetFov = 62 + Math.min(car.speed / 40, 1) * 16;
    if (Math.abs(targetFov - this.fov) > 0.05) {
      this.fov += (targetFov - this.fov) * Math.min(1, 5 * dt);
      this.cam.fov = this.fov;
      this.cam.updateProjectionMatrix();
    }
  }
}
