// hud.js — DOM HUD: speed + bar, laps, position, live leaderboard, drift
// score/combo/boost meter, minimap, messages, screen effects, title menu.
export class HUD {
  constructor() {
    const $ = (id) => document.getElementById(id);
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
    this.elMap = $("map-canvas");
    this.elFinish = $("finish-panel");
    this.elFinishRows = $("finish-rows");
    this.elTrack = $("hud-track");
    this.elHint = $("hud-hint");
    this.elVignette = $("vignette");
    this.elGlow = $("boost-glow");
    this.elMenu = $("menu");
    this.elTracks = $("tracks");
    this.elDiff = $("opt-diff");
    this.elLaps = $("opt-laps");
    this.mapCtx = this.elMap.getContext("2d");
    this.mapBg = document.createElement("canvas");
    this.mapBg.width = this.elMap.width;
    this.mapBg.height = this.elMap.height;
    this.msgTimer = 0;
    this.trackTransform = null;
    this.boardCache = "";
    this.hudEls = ["hud-speed", "hud-drift", "hud-lap", "hud-pos", "hud-board", "hud-map", "hud-track", "hud-hint", "vignette", "boost-glow"].map($);
  }

  setRaceHudVisible(v) {
    for (const el of this.hudEls) el.style.visibility = v ? "visible" : "hidden";
  }

  // small outline thumbnail for the menu cards
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
    this.trackTransform = HUD.drawOutline(this.mapBg, outlinePts);
  }

  flashMsg(text, seconds = 1.2) {
    this.elMsg.textContent = text;
    this.elMsg.classList.add("show");
    this.msgTimer = seconds;
  }

  showFinish(rowsHtml) {
    this.elFinishRows.innerHTML = rowsHtml;
    this.elFinish.style.display = "block";
  }

  hideFinish() { this.elFinish.style.display = "none"; }

  // --- title menu ---------------------------------------------------------
  // opts: { tracks: [{id, name, outline, best}], trackIndex, difficulty, laps,
  //         onTrack(i), onDifficulty(d), onLaps(n), onRace() }
  showMenu(opts) {
    this.elMenu.style.display = "block";
    this.setRaceHudVisible(false);
    this.elMsg.classList.remove("show");
    this.elTracks.innerHTML = "";
    opts.tracks.forEach((t, i) => {
      const card = document.createElement("div");
      card.className = "track-card" + (i === opts.trackIndex ? " sel" : "");
      const c = document.createElement("canvas");
      c.width = 150; c.height = 100;
      HUD.drawOutline(c, t.outline, i === opts.trackIndex ? "#ffd34d" : "#9ab4cc");
      card.appendChild(c);
      const n = document.createElement("div");
      n.className = "name"; n.textContent = t.name;
      card.appendChild(n);
      const b = document.createElement("div");
      b.className = "best"; b.textContent = t.best ? `BEST ${this.fmtTime(t.best)}` : "NO RECORD";
      card.appendChild(b);
      card.addEventListener("click", () => opts.onTrack(i));
      this.elTracks.appendChild(card);
    });
    const seg = (el, items, cur, fn) => {
      el.innerHTML = "";
      for (const [label, value] of items) {
        const btn = document.createElement("button");
        btn.textContent = label;
        if (value === cur) btn.classList.add("on");
        btn.addEventListener("click", () => fn(value));
        el.appendChild(btn);
      }
    };
    seg(this.elDiff, [["EASY", "easy"], ["NORMAL", "normal"], ["HARD", "hard"]], opts.difficulty, opts.onDifficulty);
    seg(this.elLaps, [["1", 1], ["3", 3], ["5", 5]], opts.laps, opts.onLaps);
    document.getElementById("menu-race").onclick = opts.onRace;
  }

  hideMenu() {
    this.elMenu.style.display = "none";
    this.setRaceHudVisible(true);
  }

  // state: { speedKmh, speedFrac, lap, laps, curLap, lastLap, bestLap, pos,
  //          drifting, driftScore, combo, driftCharge, boostFlash, padBoost,
  //          board: [{pos, name, color, gap, me, finished}], dots: [{x, z, color, r}] }
  update(dt, state) {
    this.elSpeed.textContent = Math.round(state.speedKmh);
    this.elSpeedBar.style.width = `${Math.round(Math.min(1, state.speedFrac) * 100)}%`;
    this.elBoost.classList.toggle("show", state.boostFlash > 0);
    const glow = state.boostFlash > 0.25 || state.padBoost > 0;
    this.elGlow.style.opacity = glow ? "1" : "0";
    this.elGlow.classList.toggle("pad", state.padBoost > 0);
    this.elVignette.style.opacity = (Math.min(1, state.speedFrac) * 0.9).toFixed(2);

    this.elLapCounter.textContent = `LAP ${Math.min(state.lap, state.laps)}/${state.laps}`;
    const fmt = (t) => t == null ? "--:--.--" : this.fmtTime(t);
    this.elLapTimes.innerHTML =
      `CUR  ${fmt(state.curLap)}<br>LAST ${fmt(state.lastLap)}<br><b>BEST ${fmt(state.bestLap)}</b>`;

    const suffix = state.pos === 1 ? "st" : state.pos === 2 ? "nd" : state.pos === 3 ? "rd" : "th";
    this.elPos.innerHTML = `${state.pos}<span>${suffix}</span><small>POSITION</small>`;

    // leaderboard (only touch the DOM when the text changes)
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

    // minimap
    if (this.trackTransform) {
      const ctx = this.mapCtx;
      ctx.clearRect(0, 0, this.elMap.width, this.elMap.height);
      ctx.drawImage(this.mapBg, 0, 0);
      for (const d of state.dots) {
        const [mx, mz] = this.trackTransform(d.x, d.z);
        ctx.fillStyle = d.color;
        ctx.beginPath();
        ctx.arc(mx, mz, d.r || 3, 0, Math.PI * 2);
        ctx.fill();
        if (d.ring) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke(); }
      }
    }
  }

  fmtTime(t) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, "0")}`;
  }
}
