// hud.js — DOM HUD. One PlayerHUD per viewport (stamped from the template
// in index.html): speed + bar, laps, position, leaderboard, drift meter,
// messages, screen effects. One SharedHUD for the minimap, track label,
// finish/pause panels and the title menu.

const fmtTime = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
};

export class PlayerHUD {
  constructor(slot) {
    const tpl = document.getElementById("player-hud-tpl");
    const root = tpl.content.firstElementChild.cloneNode(true);
    root.dataset.slot = slot;
    document.getElementById("players").appendChild(root);
    this.root = root;
    const $ = (cls) => root.querySelector("." + cls);
    this.elSpeed = $("speed-value");
    this.elSpeedBar = $("speed-bar").firstElementChild;
    this.elBoost = $("boost-flag");
    this.elDrift = $("hud-drift");
    this.elDriftScore = $("drift-score");
    this.elDriftCombo = $("drift-combo");
    this.elDriftBar = $("drift-bar").firstElementChild;
    this.elLapCounter = $("lap-counter");
    this.elLapTimes = $("lap-times");
    this.elPos = $("hud-pos");
    this.elBoard = $("hud-board");
    this.elMsg = $("hud-msg");
    this.elHint = $("hud-hint");
    this.elTag = $("hud-tag");
    this.elVignette = $("vignette");
    this.elGlow = $("boost-glow");
    this.elTag.textContent = `P${slot + 1}`;
    this.msgTimer = 0;
    this.boardCache = "";
  }

  setVisible(v) { this.root.hidden = !v; }
  setHint(html) { this.elHint.innerHTML = html; }

  flashMsg(text, seconds = 1.2) {
    this.elMsg.textContent = text;
    this.elMsg.classList.add("show");
    this.msgTimer = seconds;
  }

  // state: { speedKmh, speedFrac, lap, laps, curLap, lastLap, bestLap, pos,
  //          drifting, driftScore, combo, driftCharge, boostFlash, padBoost,
  //          board: [{pos, name, color, gap, me}] }
  update(dt, state) {
    this.elSpeed.textContent = Math.round(state.speedKmh);
    this.elSpeedBar.style.width = `${Math.round(Math.min(1, state.speedFrac) * 100)}%`;
    this.elBoost.classList.toggle("show", state.boostFlash > 0);
    const glow = state.boostFlash > 0.25 || state.padBoost > 0;
    this.elGlow.style.opacity = glow ? "1" : "0";
    this.elGlow.classList.toggle("pad", state.padBoost > 0);
    this.elVignette.style.opacity = (Math.min(1, state.speedFrac) * 0.9).toFixed(2);

    this.elLapCounter.textContent = state.finished ? "FINISHED" : `LAP ${Math.min(state.lap, state.laps)}/${state.laps}`;
    const fmt = (t) => t == null ? "--:--.--" : fmtTime(t);
    this.elLapTimes.innerHTML =
      `CUR  ${fmt(state.curLap)}<br>LAST ${fmt(state.lastLap)}<br><b>BEST ${fmt(state.bestLap)}</b>`;

    const suffix = state.pos === 1 ? "st" : state.pos === 2 ? "nd" : state.pos === 3 ? "rd" : "th";
    this.elPos.innerHTML = `${state.pos}<span>${suffix}</span><small>POSITION</small>`;

    if (state.board) {
      const html = state.board.map((r) =>
        `<div class="row${r.me ? " me" : ""}"><span class="p">${r.pos}</span><i style="background:${r.color}"></i>` +
        `<span class="n">${r.name}</span><span class="g">${r.gap}</span></div>`).join("");
      if (html !== this.boardCache) { this.boardCache = html; this.elBoard.innerHTML = html; }
    }

    if (state.drifting || state.driftScore > 0) {
      this.elDrift.classList.add("show");
      this.elDriftScore.textContent = Math.floor(state.driftScore).toLocaleString();
      const c = state.combo;
      this.elDriftCombo.textContent = `x${c.toFixed(1)}${state.drifting ? "" : " (banked)"}`;
      this.elDriftCombo.style.color = c >= 3 ? "#ff5e2e" : "#ff9d2e";
      this.elDriftBar.style.width = `${Math.round(Math.min(1, state.driftCharge || 0) * 100)}%`;
    } else {
      this.elDrift.classList.remove("show");
    }

    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.elMsg.classList.remove("show");
    }
  }

  fmtTime(t) { return fmtTime(t); }
}

export class SharedHUD {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.elMap = $("map-canvas");
    this.elFinish = $("finish-panel");
    this.elFinishRows = $("finish-rows");
    this.elTrack = $("hud-track");
    this.elMenu = $("menu");
    this.elTracks = $("tracks");
    this.elOpts = $("opts");
    this.elBlurb = $("car-blurb");
    this.mapCtx = this.elMap.getContext("2d");
    this.mapBg = document.createElement("canvas");
    this.mapBg.width = this.elMap.width;
    this.mapBg.height = this.elMap.height;
    this.trackTransform = null;
    this.elNet = $("net-status");
    this.raceEls = [$("hud-map"), $("hud-track"), this.elNet];
  }

  setRaceHudVisible(v) {
    for (const el of this.raceEls) el.style.visibility = v ? "visible" : "hidden";
  }

  // small outline thumbnail for the menu cards + the minimap background
  static drawOutline(canvas, outlinePts, color = "#c8d4e4") {
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height, pad = 10;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of outlinePts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const scale = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxZ - minZ));
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const tf = (x, z) => [w / 2 + (x - cx) * scale, h / 2 + (z - cz) * scale];
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.beginPath();
    outlinePts.forEach(([x, z], i) => {
      const [mx, mz] = tf(x, z);
      if (i === 0) ctx.moveTo(mx, mz); else ctx.lineTo(mx, mz);
    });
    ctx.closePath();
    ctx.stroke();
    return tf;
  }

  setTrack(outlinePts, trackName = "") {
    this.elTrack.textContent = trackName;
    this.trackTransform = SharedHUD.drawOutline(this.mapBg, outlinePts);
  }

  showFinish(rowsHtml) {
    this.elFinishRows.innerHTML = rowsHtml;
    this.elFinish.style.display = "block";
  }

  hideFinish() { this.elFinish.style.display = "none"; }

  // --- title menu ---------------------------------------------------------
  // opts: { tracks: [{id, name, outline, best, random}], trackIndex,
  //         options: [{ key, label, items: [[label, value]], value, cls? }],
  //         blurb, onTrack(i), onOption(key, value), onRace() }
  showMenu(opts) {
    this.elMenu.style.display = "block";
    this.setRaceHudVisible(false);
    this.elTracks.innerHTML = "";
    opts.tracks.forEach((t, i) => {
      const card = document.createElement("div");
      card.className = "track-card" + (i === opts.trackIndex ? " sel" : "");
      const c = document.createElement("canvas");
      c.width = 150; c.height = 100;
      if (t.outline) SharedHUD.drawOutline(c, t.outline, i === opts.trackIndex ? "#ffd34d" : t.random ? "#5fe8ff" : "#9ab4cc");
      else { // random slot, nothing rolled yet: a dice glyph
        const ctx = c.getContext("2d");
        ctx.font = "64px 'Rajdhani', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "#5fe8ff"; ctx.fillText("⚄", 75, 52);
      }
      card.appendChild(c);
      const n = document.createElement("div");
      n.className = "name"; n.textContent = t.name;
      card.appendChild(n);
      const b = document.createElement("div");
      b.className = "best";
      b.textContent = t.random ? "NEW LAYOUT EVERY TIME · [R]" : t.best ? `BEST ${fmtTime(t.best)}` : "NO RECORD";
      card.appendChild(b);
      card.addEventListener("click", () => opts.onTrack(i));
      this.elTracks.appendChild(card);
    });
    this.elOpts.innerHTML = "";
    for (const o of opts.options) {
      const wrap = document.createElement("div");
      wrap.className = "opt";
      const label = document.createElement("label");
      label.textContent = o.label;
      wrap.appendChild(label);
      const seg = document.createElement("div");
      seg.className = "seg";
      for (const [text, value] of o.items) {
        const btn = document.createElement("button");
        btn.textContent = text;
        if (value === o.value) btn.className = "on" + (o.cls ? " " + o.cls : "");
        btn.addEventListener("click", () => opts.onOption(o.key, value));
        seg.appendChild(btn);
      }
      wrap.appendChild(seg);
      this.elOpts.appendChild(wrap);
    }
    this.elBlurb.textContent = opts.blurb || "";
    const race = document.getElementById("menu-race");
    race.innerHTML = opts.raceLabel || "RACE&nbsp;&nbsp;[ENTER]";
    race.disabled = !!opts.raceDisabled;
    race.style.opacity = opts.raceDisabled ? "0.55" : "1";
    race.onclick = opts.raceDisabled ? null : opts.onRace;
  }

  hideMenu() {
    this.elMenu.style.display = "none";
    this.setRaceHudVisible(true);
  }

  // --- online lobby -------------------------------------------------------
  // wire the menu's online controls once: fns = { onHost(name), onJoin(code, name) }
  bindOnline(fns, savedName = "") {
    const name = document.getElementById("online-name");
    const code = document.getElementById("online-code");
    name.value = savedName;
    document.getElementById("online-host").onclick = () => fns.onHost(name.value.trim());
    document.getElementById("online-join").onclick = () => fns.onJoin(code.value.trim(), name.value.trim());
    code.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.stopPropagation(); fns.onJoin(code.value.trim(), name.value.trim()); } });
    for (const el of [name, code]) el.addEventListener("keydown", (e) => e.stopPropagation()); // typing must not trigger menu hotkeys
  }

  setOnlineStatus(text, isError = false) {
    const el = document.getElementById("online-status");
    el.textContent = text;
    el.classList.toggle("err", isError);
  }

  // lobby: { code, players: [{name, color, car, host, me}], isHost, note, onStart, onLeave }
  showLobby(lobby) {
    const el = document.getElementById("lobby");
    el.style.display = "block";
    document.getElementById("lobby-code").textContent = lobby.code || "-----";
    document.getElementById("lobby-players").innerHTML = lobby.players.map((p) =>
      `<div class="row"><i style="background:${p.color}"></i><span>${p.name}${p.me ? " (you)" : ""}</span>` +
      `<span class="car">${p.car}</span><span class="tag">${p.host ? "HOST" : ""}</span></div>`).join("");
    document.getElementById("lobby-note").innerHTML = lobby.note || "";
    const start = document.getElementById("lobby-start");
    start.style.display = lobby.isHost ? "block" : "none";
    start.onclick = lobby.onStart;
    document.getElementById("lobby-leave").onclick = lobby.onLeave;
    document.getElementById("lobby-copy").onclick = () => { try { navigator.clipboard.writeText(lobby.code); } catch (e) { /* noop */ } };
  }

  hideLobby() { document.getElementById("lobby").style.display = "none"; }

  // online indicator under the track name; "" hides it
  setNetStatus(text, bad = false) {
    if (this.elNet.textContent !== text) this.elNet.textContent = text;
    this.elNet.classList.toggle("bad", bad);
    this.elNet.style.display = text ? "block" : "none";
  }

  // dots: [{x, z, color, r, ring}]
  drawMap(dots) {
    if (!this.trackTransform) return;
    const ctx = this.mapCtx;
    ctx.clearRect(0, 0, this.elMap.width, this.elMap.height);
    ctx.drawImage(this.mapBg, 0, 0);
    for (const d of dots) {
      const [mx, mz] = this.trackTransform(d.x, d.z);
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(mx, mz, d.r || 3, 0, Math.PI * 2);
      ctx.fill();
      if (d.ring) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke(); }
    }
  }

  fmtTime(t) { return fmtTime(t); }
}
