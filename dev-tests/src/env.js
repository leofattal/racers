// env.js — the world around the road: per-track palettes (time of day),
// gradient sky dome with a sun, PMREM environment map for car reflections,
// a noise-displaced terrain that hugs the circuit, distant mountains,
// scattered trees/rocks, grandstands and flags by the start line, clouds,
// and a shadow-casting sun that follows the player. Browser-only (never
// imported by the headless tests).

import * as THREE from "three";

export const PALETTES = {
  apex: {   // bright noon
    skyTop: 0x2461c9, skyHorizon: 0xcfe6ff, fog: 0xc2dcf5, fogNear: 150, fogFar: 760,
    sun: 0xfff1d0, sunIntensity: 1.1, sunDir: [0.5, 0.75, 0.35],
    hemiSky: 0xe3f0ff, hemiGround: 0x4b6a3a, hemi: 0.42,
    grass: [0.20, 0.38, 0.15], grassDry: [0.40, 0.42, 0.18], gravel: [0.46, 0.42, 0.35],
    mountain: 0x6f86a8, tree: 0x2f6b35, tree2: 0x4c8a3a, flag: 0x39a0ff, cloud: 0xffffff,
  },
  skyway: { // late afternoon, warm
    skyTop: 0x2a4f9e, skyHorizon: 0xffc08a, fog: 0xf1c7a3, fogNear: 140, fogFar: 720,
    sun: 0xffc98a, sunIntensity: 1.05, sunDir: [-0.7, 0.35, 0.45],
    hemiSky: 0xf5d8c0, hemiGround: 0x5a4a30, hemi: 0.4,
    grass: [0.26, 0.34, 0.13], grassDry: [0.46, 0.38, 0.17], gravel: [0.48, 0.40, 0.31],
    mountain: 0x8a6f7a, tree: 0x3f6a2c, tree2: 0x6a7a2a, flag: 0xf08a2e, cloud: 0xffe4cc,
  },
  breeze: { // tropical bay, cool blue
    skyTop: 0x1a7fd8, skyHorizon: 0xdaf4ff, fog: 0xcdeeff, fogNear: 160, fogFar: 780,
    sun: 0xffffff, sunIntensity: 1.15, sunDir: [0.2, 0.8, -0.55],
    hemiSky: 0xd8f4ff, hemiGround: 0x3f7a55, hemi: 0.45,
    grass: [0.18, 0.44, 0.21], grassDry: [0.55, 0.52, 0.30], gravel: [0.66, 0.60, 0.46],
    mountain: 0x4f8f9c, tree: 0x2e7d4a, tree2: 0x58a24a, flag: 0x35e0c8, cloud: 0xffffff,
  },
  rainbow: { // sunset ridge, purple haze
    skyTop: 0x1d1650, skyHorizon: 0xff8fa8, fog: 0xd79ab8, fogNear: 130, fogFar: 700,
    sun: 0xffb090, sunIntensity: 1.0, sunDir: [-0.55, 0.28, -0.6],
    hemiSky: 0xe8b8d8, hemiGround: 0x4a3a5a, hemi: 0.42,
    grass: [0.22, 0.28, 0.20], grassDry: [0.42, 0.30, 0.30], gravel: [0.42, 0.35, 0.39],
    mountain: 0x6a4e86, tree: 0x2f5a44, tree2: 0x4a6a3a, flag: 0x9a5be8, cloud: 0xffd0e0,
  },
};

// --- deterministic value noise ---------------------------------------------
const hash = (x, z) => { const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return n - Math.floor(n); };
const lerp = (a, b, t) => a + (b - a) * t;
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  return lerp(lerp(hash(xi, zi), hash(xi + 1, zi), u), lerp(hash(xi, zi + 1), hash(xi + 1, zi + 1), u), v);
}
const fbm = (x, z) => vnoise(x, z) * 0.5 + vnoise(x * 2.1 + 5.2, z * 2.1 + 7.1) * 0.25 + vnoise(x * 4.3 + 9.7, z * 4.3 + 3.3) * 0.125;
const ss = (a, b, t) => { t = Math.max(0, Math.min(1, (t - a) / (b - a))); return t * t * (3 - 2 * t); };

// soft radial sprite texture (clouds, particles)
export function makeSoftTexture(size = 64) {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  return t;
}

// text label sprite (driver names over the rival cars)
export function makeLabel(text, color = "#ffffff") {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const ctx = c.getContext("2d");
  ctx.font = "bold 40px 'Rajdhani', 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.strokeText(text, 128, 34);
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  spr.scale.set(3.2, 0.8, 1);
  spr.renderOrder = 20;
  return spr;
}

export class Environment {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.meshes = [];
    this.palette = PALETTES.apex;
    this.sunDir = new THREE.Vector3(0.5, 0.75, 0.35).normalize();

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.8);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70;
    sc.near = 10; sc.far = 400;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun);
    scene.add(this.sun.target);

    // sky dome: gradient + sun glow, unaffected by fog
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x2461c9) },
        horizon: { value: new THREE.Color(0xcfe6ff) },
        sunDir: { value: this.sunDir.clone() },
        sunCol: { value: new THREE.Color(0xfff1d0) },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_Position.z = gl_Position.w; // always at the far plane
        }`,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 top, horizon, sunDir, sunCol;
        void main() {
          float h = clamp(vDir.y, -0.05, 1.0);
          float t = pow(h, 0.55);
          vec3 col = mix(horizon, top, t);
          float d = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
          col += sunCol * (pow(d, 400.0) * 2.0 + pow(d, 12.0) * 0.35);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.softTex = makeSoftTexture(64);
    this.clouds = [];
    this.flags = [];
    this.time = 0;
    this.envRT = null;
  }

  // nearest circuit sample distance + its road height (used to flatten the
  // terrain under the road and keep scenery off the tarmac)
  _nearest(track, x, z) {
    let bestD = Infinity, bi = 0;
    const N = track.N, px = track.px, pz = track.pz;
    for (let i = 0; i < N; i += 2) {
      const dx = x - px[i], dz = z - pz[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; bi = i; }
    }
    return { d: Math.sqrt(bestD), h: track.hh[bi] };
  }

  hills(x, z) { return (fbm(x / 110, z / 110) - 0.42) * 34; }

  groundHeight(track, x, z) {
    const n = this._nearest(track, x, z);
    const k = ss(13, 48, n.d);
    return lerp(n.h - 0.3, this.hills(x, z), k);
  }

  build(track) {
    this.dispose();
    const P = this.palette = PALETTES[track.id] || PALETTES.apex;
    const scene = this.scene;
    this.sunDir.set(...P.sunDir).normalize();

    // lighting + atmosphere
    this.hemi.color.setHex(P.hemiSky);
    this.hemi.groundColor.setHex(P.hemiGround);
    this.hemi.intensity = P.hemi;
    this.sun.color.setHex(P.sun);
    this.sun.intensity = P.sunIntensity;
    scene.fog = new THREE.Fog(P.fog, P.fogNear, P.fogFar);
    scene.background = new THREE.Color(P.fog);
    this.skyMat.uniforms.top.value.setHex(P.skyTop);
    this.skyMat.uniforms.horizon.value.setHex(P.skyHorizon);
    this.skyMat.uniforms.sunDir.value.copy(this.sunDir);
    this.skyMat.uniforms.sunCol.value.setHex(P.sun);

    // environment map for car-paint reflections: a vertex-coloured gradient
    // sphere (sky above, ground tone below) run through PMREM
    if (this.renderer) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envScene = new THREE.Scene();
      const geo = new THREE.SphereGeometry(40, 24, 16);
      const pos = geo.attributes.position;
      const col = new Float32Array(pos.count * 3);
      const top = new THREE.Color(P.skyTop), hor = new THREE.Color(P.skyHorizon), gnd = new THREE.Color(...P.grass);
      const sunC = new THREE.Color(P.sun);
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i) / 40;
        if (y >= 0) c.copy(hor).lerp(top, Math.pow(y, 0.55));
        else c.copy(hor).lerp(gnd, Math.min(1, -y * 3));
        const d = (pos.getX(i) * this.sunDir.x + pos.getY(i) * this.sunDir.y + pos.getZ(i) * this.sunDir.z) / 40;
        if (d > 0) c.lerp(sunC, Math.pow(d, 16) * 0.8);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      envScene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
      if (this.envRT) this.envRT.dispose();
      this.envRT = pmrem.fromScene(envScene, 0.04);
      scene.environment = this.envRT.texture;
      pmrem.dispose();
    }

    let seed = 7;
    for (const ch of track.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

    // --- terrain -----------------------------------------------------------
    {
      const size = 1700, seg = 170;
      const geo = new THREE.PlaneGeometry(size, size, seg, seg);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i);
        const n = this._nearest(track, x, z);
        const k = ss(13, 48, n.d);
        const hill = this.hills(x, z);
        const y = lerp(n.h - 0.3, hill, k);
        pos.setY(i, y);
        const v = fbm(x / 37 + 3, z / 37 + 1);
        let c;
        if (n.d < 13) c = P.gravel.map((g) => g * (0.9 + v * 0.2));
        else {
          const dry = ss(0.45, 0.7, v);
          c = [0, 1, 2].map((j) => lerp(P.grass[j], P.grassDry[j], dry) * (0.85 + v * 0.3));
          const shade = 1 - Math.max(0, -hill) * 0.015; // valleys a touch darker
          c = c.map((g) => g * shade);
        }
        col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      }
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
      m.receiveShadow = true;
      this.add(m);
    }

    // --- distant mountains -------------------------------------------------
    {
      const mat = new THREE.MeshLambertMaterial({ color: P.mountain });
      const geo = new THREE.ConeGeometry(1, 1, 7);
      for (let k = 0; k < 34; k++) {
        const a = (k / 34) * Math.PI * 2 + rng() * 0.15;
        const r = 620 + rng() * 140;
        const h = 90 + rng() * 170;
        const w = 120 + rng() * 160;
        const m = new THREE.Mesh(geo, mat);
        m.position.set(Math.cos(a) * r, h / 2 - 20, Math.sin(a) * r);
        m.scale.set(w, h, w);
        m.rotation.y = rng() * Math.PI;
        this.add(m);
      }
    }

    // --- trees + rocks (instanced: a handful of draw calls for hundreds) --
    {
      const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a3d24 });
      const pineMat = new THREE.MeshLambertMaterial({ color: P.tree });
      const leafMat = new THREE.MeshLambertMaterial({ color: P.tree2 });
      const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.95, envMapIntensity: 0.3 });
      const pineGeo = new THREE.ConeGeometry(1, 1, 7);
      pineGeo.translate(0, 0.5, 0); // base at origin
      const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 1, 6);
      trunkGeo.translate(0, 0.5, 0);
      const blobGeo = new THREE.IcosahedronGeometry(1, 1);
      const rockGeo = new THREE.DodecahedronGeometry(1, 0);
      const spots = [];
      const half = 640;
      let tries = 0;
      while (spots.length < 280 && tries < 5000) {
        tries++;
        const x = (rng() * 2 - 1) * half, z = (rng() * 2 - 1) * half;
        const n = this._nearest(track, x, z);
        if (n.d < 15 || n.d > 240) continue;
        spots.push({ x, z, y: this.groundHeight(track, x, z) - 0.2, pine: rng() < 0.6, rot: rng() * Math.PI * 2 });
      }
      const pines = spots.filter((t) => t.pine), rounds = spots.filter((t) => !t.pine);
      const cones = new THREE.InstancedMesh(pineGeo, pineMat, pines.length * 3);
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
      const blobs = new THREE.InstancedMesh(blobGeo, leafMat, rounds.length * 3);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();
      const put = (mesh, i, x, y, z, sx, sy, sz, ry = 0) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry);
        mesh.setMatrixAt(i, m.compose(v.set(x, y, z), q, sc.set(sx, sy, sz)));
      };
      let ci = 0, ti = 0, bi = 0;
      for (const t of pines) {
        const h = 4 + rng() * 4;
        put(trunks, ti++, t.x, t.y, t.z, 1, 1.6, 1, t.rot);
        for (let k = 0; k < 3; k++) {
          const sxz = (1.6 - k * 0.35) * (0.8 + rng() * 0.3);
          put(cones, ci++, t.x, t.y + 1.2 + k * h * 0.28, t.z, sxz, h * (0.5 - k * 0.08), sxz, t.rot);
        }
      }
      for (const t of rounds) {
        put(trunks, ti++, t.x, t.y, t.z, 1.2, 2.4, 1.2, t.rot);
        for (let k = 0; k < 3; k++) {
          const sz = 1.6 + rng() * 1.2;
          put(blobs, bi++, t.x + (rng() - 0.5) * 1.6, t.y + 2.6 + rng() * 1.4, t.z + (rng() - 0.5) * 1.6, sz, sz, sz, rng() * 3);
        }
      }
      for (const mesh of [cones, trunks, blobs]) {
        mesh.castShadow = true;
        mesh.instanceMatrix.needsUpdate = true;
        this.add(mesh);
      }
      // rocks
      const rockSpots = [];
      tries = 0;
      while (rockSpots.length < 60 && tries < 2000) {
        tries++;
        const x = (rng() * 2 - 1) * half, z = (rng() * 2 - 1) * half;
        const n = this._nearest(track, x, z);
        if (n.d < 12 || n.d > 220) continue;
        rockSpots.push({ x, z, y: this.groundHeight(track, x, z) - 0.3 });
      }
      const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockSpots.length);
      rockSpots.forEach((r, i) => {
        const e = new THREE.Euler(rng(), rng(), rng());
        q.setFromEuler(e);
        rocks.setMatrixAt(i, m.compose(v.set(r.x, r.y, r.z), q, sc.set(0.8 + rng() * 1.6, 0.6 + rng(), 0.8 + rng() * 1.6)));
      });
      rocks.castShadow = true;
      rocks.instanceMatrix.needsUpdate = true;
      this.add(rocks);
    }

    // --- grandstands + flags along the home straight -----------------------
    {
      const standMat = new THREE.MeshLambertMaterial({ color: 0x9aa3ad });
      const roofMat = new THREE.MeshLambertMaterial({ color: P.flag });
      const crowdCols = [0xe64a4a, 0x3fa7ff, 0xffd34d, 0x5fffb0, 0xffffff, 0xf08a2e].map((c) => new THREE.Color(c));
      const crowdGeo = new THREE.BoxGeometry(1.1, 1.0, 0.8);
      const crowdMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const hw = track.halfWidth;
      for (const side of [-1, 1]) {
        for (let k = -1; k <= 1; k++) {
          const s = track.length - 10 + k * 26;
          const pose = track.poseFor(s, (hw + 14) * side);
          const g = new THREE.Group();
          const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, 36);
          const cm = new THREE.Matrix4();
          let ci = 0;
          for (let tier = 0; tier < 3; tier++) {
            const step = new THREE.Mesh(new THREE.BoxGeometry(24, 1.2, 3.2), standMat);
            step.position.set(0, 0.6 + tier * 1.3, 2.2 + tier * 3.0);
            step.castShadow = step.receiveShadow = true;
            g.add(step);
            for (let c = 0; c < 12; c++) { // crowd blocks
              cm.makeTranslation(-11 + c * 2 + rng() * 0.6, 1.7 + tier * 1.3, 1.4 + tier * 3.0);
              crowd.setMatrixAt(ci, cm);
              crowd.setColorAt(ci, crowdCols[Math.floor(rng() * crowdCols.length)]);
              ci++;
            }
          }
          crowd.instanceMatrix.needsUpdate = true;
          if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
          g.add(crowd);
          const roof = new THREE.Mesh(new THREE.BoxGeometry(26, 0.4, 11), roofMat);
          roof.position.set(0, 7.2, 6.4);
          roof.rotation.x = -0.18;
          roof.castShadow = true;
          g.add(roof);
          for (const px of [-11, 11]) {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 7, 6), standMat);
            post.position.set(px, 3.5, 9.5);
            g.add(post);
          }
          g.position.set(pose.x, pose.y - 0.3, pose.z);
          g.rotation.y = pose.heading + (side > 0 ? Math.PI / 2 : -Math.PI / 2);
          this.add(g);
        }
      }
      // flags every ~70m around the lap, alternating sides
      const poleMat = new THREE.MeshLambertMaterial({ color: 0xdde3ea });
      const flagMat = new THREE.MeshLambertMaterial({ color: P.flag, side: THREE.DoubleSide });
      const flagGeo = new THREE.PlaneGeometry(2.2, 1.3, 6, 1);
      const count = Math.floor(track.length / 70);
      for (let k = 0; k < count; k++) {
        const s = k * 70 + 35;
        const side = k % 2 ? 1 : -1;
        const pose = track.poseFor(s, (hw + 3.2) * side);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6, 5), poleMat);
        pole.position.set(pose.x, pose.y + 3, pose.z);
        this.add(pole);
        const flag = new THREE.Mesh(flagGeo, flagMat);
        flag.position.set(pose.x, pose.y + 5.3, pose.z);
        flag.rotation.y = pose.heading + Math.PI / 2;
        flag.userData.phase = rng() * 6;
        flag.geometry = flagGeo.clone();
        flag.geometry.translate(1.1, 0, 0);
        this.add(flag);
        this.flags.push(flag);
      }
    }

    // --- clouds ------------------------------------------------------------
    if (this.softTex) {
      for (let k = 0; k < 16; k++) {
        const m = new THREE.SpriteMaterial({ map: this.softTex, color: P.cloud, transparent: true, opacity: 0.55 + rng() * 0.3, depthWrite: false, fog: false });
        const s = new THREE.Sprite(m);
        const a = rng() * Math.PI * 2, r = 250 + rng() * 420;
        s.position.set(Math.cos(a) * r, 150 + rng() * 90, Math.sin(a) * r);
        s.scale.set(140 + rng() * 160, 45 + rng() * 40, 1);
        s.userData.drift = 0.6 + rng() * 1.2;
        this.add(s);
        this.clouds.push(s);
      }
    }
  }

  add(m) { this.scene.add(m); this.meshes.push(m); return m; }

  dispose() {
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
    this.meshes = [];
    this.clouds = [];
    this.flags = [];
  }

  // keep the shadow frustum centred on the player; animate clouds + flags
  update(dt, focus) {
    this.time += dt;
    this.sun.position.set(focus.x + this.sunDir.x * 160, focus.y + this.sunDir.y * 160, focus.z + this.sunDir.z * 160);
    this.sun.target.position.set(focus.x, focus.y, focus.z);
    this.sun.target.updateMatrixWorld();
    this.sky.position.set(focus.x, 0, focus.z);
    for (const c of this.clouds) c.position.x += c.userData.drift * dt;
    for (const f of this.flags) {
      const pos = f.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        pos.setZ(i, Math.sin(this.time * 4 + f.userData.phase + x * 2.2) * 0.12 * x);
      }
      pos.needsUpdate = true;
    }
  }
}
