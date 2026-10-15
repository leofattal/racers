// input.js — keyboard + gamepad state for one or two local players. No
// imports, no side effects beyond listeners.
//
// One player: WASD or arrows, Space handbrake, plus the first gamepad.
// Two players: P1 = WASD + Space (or Left Shift), P2 = arrows + Right Shift
// (or Numpad 0). Gamepads are handed out in order; with a single pad
// connected it goes to P2 so one keyboard + one pad just works.
// Pad menu buttons are translated into the hotkeys main.js understands by
// dispatching synthetic keydown events tagged with the pad's player slot.
const DEAD = 0.12;
const dead = (v) => (Math.abs(v) < DEAD ? 0 : Math.sign(v) * (Math.abs(v) - DEAD) / (1 - DEAD));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Layouts. Chrome/Edge/Safari expose Xbox AND PlayStation pads with the
// W3C "standard" mapping (0 = A/Cross, 1 = B/Circle, 2 = X/Square,
// 3 = Y/Triangle, 4/5 = bumpers, 6/7 = triggers, 8 = Back/Share,
// 9 = Start/Options, 12-15 = d-pad). Firefox on macOS/Linux reports Sony
// pads unmapped with a different face-button order and the d-pad as a hat
// axis; the "sony-raw" layout covers that.
const LAYOUTS = {
  standard: {
    throttle: [7], brake: [6], handbrake: [0, 1, 4, 5],
    dpadUp: 12, dpadDown: 13, dpadLeft: 14, dpadRight: 15, hat: null,
    hotkeys: { 9: "Escape", 8: "KeyR", 3: "KeyG", 2: "KeyL", 0: "Enter" },
  },
  "sony-raw": {
    throttle: [7], brake: [6], handbrake: [0, 1, 2, 4, 5],
    dpadUp: null, dpadDown: null, dpadLeft: null, dpadRight: null, hat: 9,
    hotkeys: { 9: "Escape", 8: "KeyR", 3: "KeyG", 0: "Enter", 1: "Enter" },
  },
};

export function padLayout(pad) {
  if (pad.mapping === "standard") return LAYOUTS.standard;
  if (/054c|sony|dualshock|dualsense|playstation|wireless controller/i.test(pad.id)) return LAYOUTS["sony-raw"];
  return LAYOUTS.standard; // best effort for unknown unmapped pads
}

// DS4/DualSense hat axis: -1 up, -0.43 right, 0.14 down, 0.71 left, 1.29 rest
function hatLeftRight(v) {
  if (v > 1.1 || v < -1.1) return 0;
  if (Math.abs(v - 0.71) < 0.2 || Math.abs(v - 1.0) < 0.1 || Math.abs(v - 0.43) < 0.1) return -1; // left-ish
  if (Math.abs(v + 0.43) < 0.2 || Math.abs(v + 0.71) < 0.1 || Math.abs(v + 0.14) < 0.1) return 1;  // right-ish
  return 0;
}

const KEYSETS = {
  all: { left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"], up: ["KeyW", "ArrowUp"], down: ["KeyS", "ArrowDown"], hb: ["Space", "ShiftLeft"] },
  p1:  { left: ["KeyA"], right: ["KeyD"], up: ["KeyW"], down: ["KeyS"], hb: ["Space", "ShiftLeft"] },
  p2:  { left: ["ArrowLeft"], right: ["ArrowRight"], up: ["ArrowUp"], down: ["ArrowDown"], hb: ["ShiftRight", "Numpad0"] },
};

export class Keyboard {
  constructor() {
    this.keys = Object.create(null);
    this.padButtons = [Object.create(null), Object.create(null)]; // per slot, for edges
    this.padActive = false;
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

  // connected pads in index order
  gamepads() {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return [];
    let pads = [];
    try { pads = navigator.getGamepads() || []; } catch (e) { return []; }
    const out = [];
    for (const p of pads) if (p && p.connected) out.push(p);
    return out;
  }

  // the pad driving a given player slot (null if none)
  padFor(slot, twoPlayer) {
    const pads = this.gamepads();
    if (!twoPlayer) return slot === 0 ? pads[0] || null : null;
    if (pads.length >= 2) return pads[slot] || null;
    if (pads.length === 1) return slot === 1 ? pads[0] : null; // keyboard + one pad
    return null;
  }

  // Returns the physics input vector consumed by car.update(dt, input).
  // NOTE on sign: the physics convention has forward = (sin h, 0, cos h), so
  // heading INCREASE rotates the nose toward world +X. From a chase camera
  // looking along the nose, world +X is SCREEN LEFT (right-handed Y-up).
  // Therefore screen-right = steer -1 here. Do not "fix" this back.
  sample(slot = 0, twoPlayer = false) {
    const k = this.keys;
    const set = twoPlayer ? (slot === 0 ? KEYSETS.p1 : KEYSETS.p2) : (slot === 0 ? KEYSETS.all : null);
    const any = (codes) => (set && codes.some((c) => k[c]) ? 1 : 0);
    const inp = set ? {
      steer: any(set.left) - any(set.right), // +1 = screen left, -1 = screen right
      throttle: any(set.up),
      brake: any(set.down),
      handbrake: !!any(set.hb),
    } : { steer: 0, throttle: 0, brake: 0, handbrake: false };

    const pad = this.padFor(slot, twoPlayer);
    if (!pad) return inp;
    const L = padLayout(pad);
    const btn = (i) => {
      const b = pad.buttons[i];
      if (!b) return 0;
      return typeof b === "number" ? b : (b.value || (b.pressed ? 1 : 0));
    };
    const anyBtn = (list) => list.reduce((m, i) => Math.max(m, btn(i)), 0);

    // stick right (+X) = screen right = steer -1 (see sign note above)
    const stick = dead(pad.axes[0] || 0);
    let dpad = 0;
    if (L.hat != null) dpad = -hatLeftRight(pad.axes[L.hat] ?? 2);
    else dpad = (btn(L.dpadLeft) > 0.5 ? 1 : 0) - (btn(L.dpadRight) > 0.5 ? 1 : 0);
    const steer = stick !== 0 ? -stick : dpad;
    let throttle = anyBtn(L.throttle);
    let brake = anyBtn(L.brake);
    if (L.dpadUp != null && btn(L.dpadUp) > 0.5) throttle = 1;
    if (L.dpadDown != null && btn(L.dpadDown) > 0.5) brake = 1;
    const handbrake = anyBtn(L.handbrake) > 0.5;

    if (steer || throttle || brake || handbrake) this.padActive = true;
    if (steer) inp.steer = Math.max(-1, Math.min(1, steer));
    if (throttle) inp.throttle = Math.max(inp.throttle, clamp01(throttle));
    if (brake) inp.brake = Math.max(inp.brake, clamp01(brake));
    inp.handbrake = inp.handbrake || handbrake;

    // menu buttons -> synthetic hotkeys on the press edge, tagged with the slot
    const edges = this.padButtons[slot] || (this.padButtons[slot] = Object.create(null));
    for (const idx of Object.keys(L.hotkeys)) {
      const now = btn(+idx) > 0.5;
      if (now && !edges[idx]) {
        const ev = new KeyboardEvent("keydown", { code: L.hotkeys[idx] });
        ev.padSlot = slot;
        window.dispatchEvent(ev);
      }
      edges[idx] = now;
    }
    return inp;
  }
}
