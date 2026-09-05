// hud.js — DOM HUD: speed, laps, position, drift score/combo, minimap, messages.
export class HUD {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.elSpeed = $("speed-value");
    this.elBoost = $("boost-flag");
    this.elDrift = $("hud-drift");
    this.elDriftScore = $("drift-score");
    this.elDriftCombo = $("drift-combo");
    this.elLapCounter = $("lap-counter");
    this.elLapTimes = $("lap-times");
    this.elPos = $("hud-pos");
    this.elMsg = $("hud-msg");
    this.elMap = $("map-canvas");
    this.elFinish = $("finish-panel");
    this.elFinishRows = $("finish-rows");
    this.elTrack = $("hud-track");
    this.mapCtx = this.elMap.getContext("2d");
    this.mapBg = document.createElement("canvas");
    this.mapBg.width = this.elMap.width;
    this.mapBg.height = this.elMap.height;
    this.msgTimer = 0;
    this.trackTransform = null;
  }

  setTrack(outlinePts, trackName = "") {
    this.elTrack.textContent = `${trackName}  ·  [T] change track`;
    // fit the track outline into the minimap canvas once
    const w = this.mapBg.width, h = this.mapBg.height, pad = 14;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of outlinePts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const scale = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxZ - minZ));
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    this.trackTransform = (x, z) => [
      w / 2 + (x - cx) * scale,
      h / 2 + (z - cz) * scale,
    ];
    const ctx = this.mapBg.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "#c8d4e4";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.beginPath();
    outlinePts.forEach(([x, z], i) => {
      const [mx, mz] = this.trackTransform(x, z);
      if (i === 0) ctx.moveTo(mx, mz); else ctx.lineTo(mx, mz);
    });
    ctx.closePath();
    ctx.stroke();
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

  hideFinish() {
    this.elFinish.style.display = "none";
  }

  // state: { speedKmh, lap, laps, curLap, lastLap, bestLap, pos, drifting,
  //          driftScore, combo, boostFlash, dots: [{x, z, color, r}] }
  update(dt, state) {
    this.elSpeed.textContent = Math.round(state.speedKmh);
    this.elBoost.classList.toggle("show", state.boostFlash > 0);

    this.elLapCounter.textContent = `LAP ${Math.min(state.lap, state.laps)}/${state.laps}`;
    const fmt = (t) => t == null ? "--:--.--" : this.fmtTime(t);
    this.elLapTimes.innerHTML =
      `CUR  ${fmt(state.curLap)}<br>LAST ${fmt(state.lastLap)}<br><b>BEST ${fmt(state.bestLap)}</b>`;

    const suffix = state.pos === 1 ? "st" : state.pos === 2 ? "nd" : state.pos === 3 ? "rd" : "th";
    this.elPos.innerHTML = `${state.pos}<span style="font-size:20px">${suffix}</span><small>POSITION</small>`;

    if (state.drifting || state.driftScore > 0) {
      this.elDrift.classList.add("show");
      this.elDriftScore.textContent = Math.floor(state.driftScore).toLocaleString();
      const c = state.combo;
      this.elDriftCombo.textContent = `x${c.toFixed(1)}${state.drifting ? "" : " (banked)"}`;
      this.elDriftCombo.style.color = c >= 3 ? "#ff5e2e" : "#ff9d2e";
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
      }
    }
  }

  fmtTime(t) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, "0")}`;
  }
}
