// input.js — keyboard + gamepad state. No imports, no side effects beyond
// listeners. A connected gamepad is merged into the same input vector the
// keyboard produces (analog steering/throttle/brake win over digital keys),
// and its menu buttons are translated into the hotkeys main.js already
// understands by dispatching synthetic keydown events.
const DEAD = 0.12;
const dead = (v) => (Math.abs(v) < DEAD ? 0 : Math.sign(v) * (Math.abs(v) - DEAD) / (1 - DEAD));

// standard-mapping gamepad buttons -> keyboard codes (edge triggered)
const PAD_HOTKEYS = { 9: "Escape", 8: "KeyR", 3: "KeyG", 2: "KeyL", 0: "Enter" }; // A confirms in menus (and is handbrake in-race)

export class Keyboard {
  constructor() {
    this.keys = Object.create(null);
    this.padButtons = Object.create(null); // last frame's button state, for edges
    this.padActive = false;                // true once a pad produced any input
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

  // first connected standard-mapping pad, or null
  gamepad() {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
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
    const inp = {
      steer: left - right, // +1 = screen left (A / ArrowLeft), -1 = screen right
      throttle: (k["KeyW"] || k["ArrowUp"]) ? 1 : 0,
      brake: (k["KeyS"] || k["ArrowDown"]) ? 1 : 0,
      handbrake: !!k["Space"],
    };

    const pad = this.gamepad();
    if (!pad) return inp;
    const btn = (i) => (pad.buttons[i] ? (pad.buttons[i].value || (pad.buttons[i].pressed ? 1 : 0)) : 0);
    // stick right (+X) = screen right = steer -1 (see sign note above)
    const stick = dead(pad.axes[0] || 0);
    const dpad = (btn(14) ? 1 : 0) - (btn(15) ? 1 : 0);
    const steer = stick !== 0 ? -stick : dpad;
    const throttle = Math.max(btn(7), btn(12) ? 1 : 0);          // RT / d-pad up
    const brake = Math.max(btn(6), btn(13) ? 1 : 0);             // LT / d-pad down
    const handbrake = btn(0) > 0.5 || btn(1) > 0.5 || btn(4) > 0.5 || btn(5) > 0.5; // A B LB RB
    if (steer || throttle || brake || handbrake) this.padActive = true;
    if (steer) inp.steer = Math.max(-1, Math.min(1, steer));
    if (throttle) inp.throttle = Math.max(inp.throttle, throttle);
    if (brake) inp.brake = Math.max(inp.brake, brake);
    inp.handbrake = inp.handbrake || handbrake;

    // menu buttons -> synthetic hotkeys on the press edge
    for (const idx of Object.keys(PAD_HOTKEYS)) {
      const now = btn(+idx) > 0.5;
      if (now && !this.padButtons[idx]) {
        window.dispatchEvent(new KeyboardEvent("keydown", { code: PAD_HOTKEYS[idx] }));
      }
      this.padButtons[idx] = now;
    }
    return inp;
  }
}
