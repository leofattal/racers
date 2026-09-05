// memory.js — tiny localStorage persistence layer (per-player memory that
// survives page reloads; no backend needed). All access is guarded so
// private-mode browsers never throw.

const PREFIX = "driftcircuit/";

export function loadMem(key, fallback = null) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

export function saveMem(key, value) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}
