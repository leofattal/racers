// xr.js — glasses-free stereo on a DisplayXR display (the "inline-3d" WebXR
// session, through the @displayxr/inline3d SDK). Everywhere else this module
// does nothing and the game keeps its normal 2D loop.
//
// The contract, in one line: while the canvas is woven its backing store is a
// side-by-side pair at twice the CSS width (left eye in the left half), and
// the SDK's onFrame drives the loop instead of requestAnimationFrame. The game
// keeps its own camera (ChaseCam) and hands the runtime a camera rig; the
// runtime returns the two off-axis eye views, which we render into the halves.

// Pinned: a moved or unpinned SDK must degrade the page to 2D, never change
// the stereo loop's semantics under it on a machine nobody is watching.
const SDK_BASE = "https://cdn.jsdelivr.net/npm/@displayxr/inline3d@1.45.1/js/";
const MIN_SCALE = 0.5;     // below ~0.5 per eye the lens pitch out-resolves the buffer
const MIN_CONVERGENCE = 2; // metres; well past the comfort floor, and never "infinity"

export class Inline3D {
  constructor() {
    this.available = false; // a DisplayXR session was acquired: stereo is possible
    this.woven = false;     // the canvas is registered and the SDK drives the loop
    this.scale = 1;         // render scale in force (per-eye px / device px)
    this.renderScale = 1;   // requested quality, applied to the backing store only
    this.firstWoven = null; // the SDK's join report for the current tile
    this._wall = null;
    this._sdk = null;       // the SDK's three.js glue (EyeCamera, cameraRigFromCamera)
    this._o = null;         // start() options while woven
    this._handle = null;
    this._eyes = null;
    this._addedCam = false;
    this._saved = null;
    this._rig = {};         // reused: a per-frame rig allocates nothing
    this._good = [new Float32Array(32), new Float32Array(32)]; // per eye: projection | pose
    this._haveGood = false;
    this._near = -1;
    this._far = -1;
    this._limit = 0;
    this._initP = null;
  }

  // Resolves true when a session was acquired. One manager per document: two
  // live managers overwrite each other's rect list every frame.
  init() {
    if (this._initP) return this._initP;
    this._initP = (async () => {
      // The SDK's own synchronous gate, done here so an ordinary browser never
      // downloads it. Deliberately NOT isSessionSupported('inline-3d'): it
      // answers false before the OS weave service binds, i.e. at page load.
      if (!window.isSecureContext || !navigator.xr || typeof window.XRDisplayLayer !== "function") return false;
      try {
        const [core, three] = await Promise.all([
          import(SDK_BASE + "inline3d.js"),
          import(SDK_BASE + "inline3d-three.js"),
        ]);
        // autoChrome off: its scan looks for a site's sticky header, not a
        // game HUD; the overlays are listed explicitly in start().
        const wall = await core.createInline3D({ lazy: false, autoChrome: false });
        if (!wall || !wall.supported) return false;
        this._wall = wall;
        this._sdk = three;
        this.available = true;
        return true;
      } catch (e) {
        console.warn("inline-3D unavailable, staying 2D", e);
        return false;
      }
    })();
    return this._initP;
  }

  // o: { renderer, scene, THREE, canvas, getCamera(), getConvergence(),
  //      simulate(now), renderMono(), overlays: [el], onStop() }
  // Returns true when the SDK now owns the loop; only then may the caller stop
  // its own (a refused activation that already stopped it is a black page).
  start(o) {
    if (!this.available || this.woven) return this.woven;
    const { renderer, canvas } = o;
    const cam = o.getCamera();
    this._o = o;
    this._saved = {
      pixelRatio: renderer.getPixelRatio(),
      autoClear: renderer.autoClear,
      shadowAuto: renderer.shadowMap.autoUpdate,
      cssW: canvas.style.width,
      cssH: canvas.style.height,
    };
    // Full-bleed DOM must be display:none BEFORE the tile registers: an element
    // congruent with the canvas matches the canvas's own quad and unweaves it.
    document.body.classList.add("xr-woven");
    this._cover(true);
    this._lostDuringStart = false;
    this._starting = true;
    let handle = null;
    try {
      // getViewport() is already in backing-store px; three multiplies viewports
      // by the pixel ratio, so anything but 1 zooms and offsets each eye.
      renderer.setPixelRatio(1);
      renderer.autoClear = false; // one clear per frame, then two eye viewports
      // two eye renders per frame, one shadow pass: updated by hand in _begin()
      renderer.shadowMap.autoUpdate = false;
      this._attach(cam);
      this.woven = true;
      this._size();
      this._syncDepth(cam);
      handle = this._wall.addScene(canvas, (views, layer) => this._onFrame(views, layer), {
        viewRig: this._rigFor(cam),
        onLayerLost: () => this._lost(),
      });
    } catch (e) {
      console.warn("inline-3D: could not register the canvas, staying 2D", e);
      handle = null;
    }
    this._starting = false;
    if (!handle || this._lostDuringStart) {
      if (handle) { try { handle.remove(); } catch (e) { /* already gone */ } }
      this._restore();
      return false;
    }
    this._handle = handle;
    this.firstWoven = null;
    for (const el of o.overlays || []) if (el) this._wall.addGlobalOverlay(el);
    // Released on the SDK's woven signal, never on a timer or first paint: until
    // the compositor joins the canvas the screen shows the raw squeezed pair.
    handle.firstWoven.then((r) => {
      this.firstWoven = r; // { woven, confirmed, reason, ms }: read it on hardware
      if (this._handle === handle) this._cover(false);
    });
    return true;
  }

  // Back to 2D: remove the tile, restore the renderer, hand the loop back.
  stop() {
    if (!this.woven) return;
    const h = this._handle;
    this._handle = null;
    if (h) { try { h.remove(); } catch (e) { /* session already gone */ } }
    const o = this._o;
    this._restore();
    if (o.onStop) o.onStop();
    if (o.renderMono) o.renderMono(); // setSize cleared the buffer: repaint now, not next frame
  }

  // window resize while woven: re-size the pair and repaint immediately
  resize() {
    if (!this.woven) return;
    if (this._size()) this._replay();
  }

  // --- internals -----------------------------------------------------------
  _lost() {
    // the session ended or the layer could not be made: take the canvas flat
    if (this._starting) { this._lostDuringStart = true; return; }
    this.stop();
  }

  _restore() {
    const { renderer, canvas, scene } = this._o;
    const s = this._saved;
    this.woven = false;
    this._haveGood = false;
    if (this._eyes) for (const e of this._eyes) if (e.camera.parent) e.camera.parent.remove(e.camera);
    if (this._addedCam) { const cam = this._o.getCamera(); scene.remove(cam); this._addedCam = false; }
    renderer.setScissorTest(false);
    renderer.setPixelRatio(s.pixelRatio);
    renderer.autoClear = s.autoClear;
    renderer.shadowMap.autoUpdate = s.shadowAuto;
    canvas.style.width = s.cssW;
    canvas.style.height = s.cssH;
    document.body.classList.remove("xr-woven");
    this._cover(false);
  }

  _cover(on) {
    const el = document.getElementById("xr-cover");
    if (el) el.style.display = on ? "block" : "none"; // a hard cut: never a fade
  }

  // Attach pattern: the rig is sent with an identity pose and the eyes hang
  // off the app camera, so this frame's camera pose drives this frame's eyes
  // (a rig set in frame N only reaches the views of frame N+1).
  _attach(cam) {
    const { THREE, scene } = this._o;
    if (!this._eyes) this._eyes = [new this._sdk.EyeCamera(THREE), new this._sdk.EyeCamera(THREE)];
    // three only reaches a parented camera through a scene traversal
    if (!cam.parent) { scene.add(cam); this._addedCam = true; }
    for (const e of this._eyes) cam.add(e.camera);
    this._near = this._far = -1;
  }

  _rigFor(cam) {
    const o = this._o;
    const ipdFactor = o.ipdFactor ?? 1;
    const metersToVirtual = o.metersToVirtual ?? 1; // the world is authored in metres
    // comfort: ipd × m2v × diopters × 0.5 <= 1, or the background diverges
    const d = Math.max(o.getConvergence() || 0, MIN_CONVERGENCE, ipdFactor * metersToVirtual * 0.5);
    return this._sdk.cameraRigFromCamera(o.THREE, cam, {
      attach: true, convergence: d, ipdFactor, metersToVirtual, out: this._rig,
    });
  }

  // Eye projections are built with the session's near/far: keep them on the
  // app camera's. Eye cameras get the scalars only (never updateProjectionMatrix,
  // which would replace the runtime's off-axis frustum with a symmetric one).
  _syncDepth(cam) {
    if (cam.near === this._near && cam.far === this._far) return;
    this._near = cam.near;
    this._far = cam.far;
    for (const e of this._eyes) { e.camera.near = cam.near; e.camera.far = cam.far; }
    try { this._wall.session.updateRenderState({ depthNear: cam.near, depthFar: cam.far }); }
    catch (e) { /* session mid-teardown: the next frame works or ends */ }
  }

  // Size the side-by-side store. Compare first: setSize reallocates (and
  // clears) the buffer even for identical values. Returns true on a change.
  _size() {
    const { renderer, canvas } = this._o;
    const cssW = window.innerWidth, cssH = window.innerHeight;
    // the store is 2x wide, so the CSS box has to be pinned explicitly
    if (canvas.style.width !== cssW + "px") canvas.style.width = cssW + "px";
    if (canvas.style.height !== cssH + "px") canvas.style.height = cssH + "px";
    const dpr = window.devicePixelRatio || 1;
    // same device-pixel cap as the 2D path (ratio <= 2), scaled, floored
    let s = Math.max(MIN_SCALE, Math.min(1, 2 / dpr) * this.renderScale);
    if (!this._limit) {
      const gl = renderer.getContext();
      const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      this._limit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vp[0], vp[1]);
    }
    // a store past the GL limits is clamped silently by the browser and the eye
    // split lands off-centre: shrink both axes by one factor instead
    const eyeW0 = cssW * dpr * s, h0 = cssH * dpr * s;
    s *= Math.min(1, this._limit / (2 * eyeW0), this._limit / h0);
    this.scale = s;
    const eyeW = Math.max(1, Math.floor(cssW * dpr * s)), h = Math.max(1, Math.floor(cssH * dpr * s));
    const cam = this._o.getCamera();
    if (Math.abs(cam.aspect - cssW / cssH) > 1e-6) { cam.aspect = cssW / cssH; cam.updateProjectionMatrix(); }
    if (canvas.width === eyeW * 2 && canvas.height === h) return false;
    renderer.setSize(eyeW * 2, h, false);
    return true;
  }

  _onFrame(views, layer) {
    const o = this._o;
    if (!this.woven || !o) return;
    o.simulate(performance.now());
    if (!this.woven) return; // the frame's game logic switched stereo off
    const cam = o.getCamera();
    this._syncDepth(cam);
    // Before the draw gate on purpose: a rig drives the NEXT locate, so a frame
    // that cannot draw must still advance it.
    this._handle.setViewRig(this._rigFor(cam));
    this._size();
    // Validate everything BEFORE clearing: a short view list (the session's
    // mono fallback under load) or a null viewport throws nothing, and clearing
    // on such a frame is a black blink. Neither may empty the buffer.
    if (!views || views.length < 2 || !layer || typeof layer.getViewport !== "function") return this._replay();
    const vps = [layer.getViewport(views[0]), layer.getViewport(views[1])];
    if (vps.some((vp) => !vp || vp.width <= 0 || vp.height <= 0)) return this._replay();
    const r = o.renderer;
    this._begin();
    for (let i = 0; i < 2; i++) {
      const vp = vps[i], e = this._eyes[i], v = views[i];
      r.setViewport(vp.x, vp.y, vp.width, vp.height);
      r.setScissor(vp.x, vp.y, vp.width, vp.height);
      e.setLocalFromView(v); // LOCAL: the eye is parented under the app camera
      r.render(o.scene, e.camera);
      // COPIES: an XRView is valid only inside this callback and its matrices
      // are views onto memory the browser recycles
      this._good[i].set(v.projectionMatrix, 0);
      this._good[i].set(v.transform.matrix, 16);
    }
    r.setScissorTest(false);
    this._haveGood = true;
  }

  _begin() {
    const r = this._o.renderer;
    r.setScissorTest(false);
    r.clear(); // the point of no return
    r.shadowMap.needsUpdate = true; // one shadow pass for both eyes
    r.setScissorTest(true);
  }

  // Never skip a frame: a canvas that is not redrawn can drop out of the
  // compositor's frame and smear. Repaint the last good pair instead; before
  // there is one, the app camera flat into both halves.
  _replay() {
    const o = this._o, r = o.renderer;
    const w = r.domElement.width, h = r.domElement.height, half = Math.floor(w / 2);
    this._begin();
    for (let i = 0; i < 2; i++) {
      r.setViewport(i * half, 0, half, h);
      r.setScissor(i * half, 0, half, h);
      if (this._haveGood) {
        const g = this._good[i], e = this._eyes[i];
        e.setLocalFromMatrices(g.subarray(0, 16), g.subarray(16, 32));
        r.render(o.scene, e.camera);
      } else {
        r.render(o.scene, o.getCamera());
      }
    }
    r.setScissorTest(false);
  }
}
