// input.js — keyboard state. No imports, no side effects beyond listeners.
export class Keyboard {
  constructor() {
    this.keys = Object.create(null);
    const down = (e) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
        e.preventDefault();
      }
      this.keys[e.code] = true;
    };
    const up = (e) => { this.keys[e.code] = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", () => { this.keys = Object.create(null); });
  }

  // Returns the physics input vector consumed by car.update(dt, input).
  // NOTE on sign: the physics convention has forward = (sin h, 0, cos h), so
  // heading INCREASE rotates the nose toward world +X. From a chase camera
  // looking along the nose, world +X is SCREEN LEFT (right-handed Y-up).
  // Therefore screen-right = steer -1 here. Do not "fix" this back.
  sample() {
    const k = this.keys;
    const left = k["KeyA"] || k["ArrowLeft"] ? 1 : 0;
    const right = k["KeyD"] || k["ArrowRight"] ? 1 : 0;
    return {
      steer: left - right, // +1 = screen left (A / ArrowLeft), -1 = screen right
      throttle: (k["KeyW"] || k["ArrowUp"]) ? 1 : 0,
      brake: (k["KeyS"] || k["ArrowDown"]) ? 1 : 0,
      handbrake: !!k["Space"],
    };
  }
}
