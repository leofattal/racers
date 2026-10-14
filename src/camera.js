// camera.js — chase camera with positional lag, drift-aware swing, a little
// roll with the slide, impact shake, and a slow orbit used by the menu.
import * as THREE from "three";

export class ChaseCam {
  constructor(camera) {
    this.cam = camera;
    this.pos = new THREE.Vector3(0, 4, -10);
    this.look = new THREE.Vector3();
    this.fov = 62;
    this.initialized = false;
    this.shake = 0;     // decaying impact energy
    this.roll = 0;
    this.orbitT = 0;
  }

  snapTo(car) {
    const fx = car.forwardX(), fz = car.forwardZ();
    this.pos.set(car.pos.x - fx * 7, car.pos.y + 3, car.pos.z - fz * 7);
    this.look.set(car.pos.x, car.pos.y + 1, car.pos.z);
    this.initialized = true;
    this.shake = 0;
  }

  kick(amount) { this.shake = Math.min(1.2, this.shake + amount); }

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

    // impact shake: random jitter that decays fast
    this.shake *= Math.exp(-7 * dt);
    const sh = this.shake * 0.35;
    this.cam.position.set(
      this.pos.x + (Math.random() - 0.5) * sh,
      this.pos.y + (Math.random() - 0.5) * sh,
      this.pos.z + (Math.random() - 0.5) * sh,
    );
    this.cam.lookAt(this.look);
    // roll with the slide + a touch of speed shimmer
    const rollT = -swing * 0.06 + (Math.random() - 0.5) * this.shake * 0.04;
    this.roll += (rollT - this.roll) * Math.min(1, 6 * dt);
    this.cam.rotateZ(this.roll);

    // speed-based FOV kick (boost pushes it wider)
    const targetFov = 62 + Math.min(car.speed / 40, 1) * 16 + (car.boostFlash > 0.3 ? 6 : 0);
    if (Math.abs(targetFov - this.fov) > 0.05) {
      this.fov += (targetFov - this.fov) * Math.min(1, 5 * dt);
      this.cam.fov = this.fov;
      this.cam.updateProjectionMatrix();
    }
  }

  // menu: slow orbit around a point on the track, looking along it
  orbit(dt, track) {
    this.orbitT += dt;
    const s = (this.orbitT * 9) % track.length;
    const p = track.poseFor(s, 0);
    const ahead = track.poseFor(s + 30, 0);
    const a = this.orbitT * 0.25;
    this.cam.position.set(p.x + Math.sin(a) * 22, p.y + 9 + Math.sin(this.orbitT * 0.4) * 2, p.z + Math.cos(a) * 22);
    this.cam.lookAt(ahead.x, ahead.y + 1, ahead.z);
    if (Math.abs(this.cam.fov - 55) > 0.1) { this.cam.fov = 55; this.fov = 55; this.cam.updateProjectionMatrix(); }
    this.initialized = false; // next race snaps cleanly
  }
}
