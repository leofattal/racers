// models.js — optional real car model. Loads the Ferrari 458 Italia glTF
// that ships with the three.js examples (model by vicent091036, CC-BY 4.0,
// served from the three.js GitHub repo via jsDelivr) and dresses every car
// with it: body recoloured per driver, wheels spun/steered by the physics.
// If the download fails (offline, blocked CDN) the procedural box car stays.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

export const CAR_MODEL_URL = "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r148/examples/models/gltf/ferrari.glb";
const DRACO_PATH = "https://unpkg.com/three@0.148.0/examples/jsm/libs/draco/gltf/";
const TARGET_LENGTH = 3.3; // metres, matches the physics footprint

export function loadCarModel(url = CAR_MODEL_URL) {
  return new Promise((resolve, reject) => {
    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_PATH);
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    loader.load(url, (gltf) => {
      const root = gltf.scene.children[0] || gltf.scene;
      // orient: nose toward +z (our forward), scale to the physics length,
      // rest on y = 0
      const fl = root.getObjectByName("wheel_fl"), rl = root.getObjectByName("wheel_rl");
      const wrap = new THREE.Group();
      wrap.add(root);
      if (fl && rl) {
        const a = new THREE.Vector3(), b = new THREE.Vector3();
        fl.getWorldPosition(a); rl.getWorldPosition(b);
        if (a.z < b.z) root.rotation.y = Math.PI;
      }
      wrap.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(wrap);
      const len = box.max.z - box.min.z || 1;
      const k = TARGET_LENGTH / len;
      wrap.scale.setScalar(k);
      wrap.updateMatrixWorld(true);
      const box2 = new THREE.Box3().setFromObject(wrap);
      wrap.position.y = -box2.min.y;
      wrap.position.z = -(box2.min.z + box2.max.z) / 2;
      wrap.updateMatrixWorld(true);
      wrap.userData.bounds = new THREE.Box3().setFromObject(wrap);
      resolve(wrap);
    }, undefined, reject);
  });
}

// Give one car the model: hides its procedural parts and rewires the
// visual hooks (wheels, front axle, body lean, tail lights) that
// Car.syncMesh drives.
export function applyCarModel(carMesh, template, color) {
  const inst = template.clone(true);
  const root = inst.children[0];
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.7, roughness: 0.25, envMapIntensity: 1.0 });
  const details = new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 1.0, roughness: 0.4 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0f1a26, metalness: 0.9, roughness: 0.08, envMapIntensity: 1.2 });
  const named = (n) => root.getObjectByName(n);
  const body = named("body");
  if (body) body.material = paint;
  for (const n of ["rim_fl", "rim_fr", "rim_rr", "rim_rl", "trim"]) { const o = named(n); if (o) o.material = details; }
  const g = named("glass");
  if (g) g.material = glass;
  const wheels = ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"].map(named).filter(Boolean);
  for (const w of wheels) w.rotation.order = "YXZ"; // steer (y) then spin (x)
  inst.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });

  // lights: small emissive slabs placed from the bounds (model has no light nodes)
  const b = template.userData.bounds;
  const w = b.max.x - b.min.x, h = b.max.y - b.min.y;
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfffbe8, emissive: 0xfff2c0, emissiveIntensity: 1.2, roughness: 0.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x5a0a0a, emissive: 0xff2a1a, emissiveIntensity: 0.35, roughness: 0.4 });
  const slab = (mat, x, y, z, sx) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.07, 0.04), mat);
    m.position.set(x, y, z);
    inst.add(m);
  };
  for (const s of [-1, 1]) {
    slab(headMat, s * w * 0.32, h * 0.42, b.max.z - 0.08, w * 0.16);
    slab(tailMat, s * w * 0.3, h * 0.5, b.min.z + 0.06, w * 0.2);
  }

  const proc = carMesh.userData.procedural;
  if (proc) proc.visible = false;
  carMesh.add(inst);
  carMesh.userData.wheels = wheels;
  carMesh.userData.frontAxle = wheels.slice(0, 2);
  carMesh.userData.body = inst;
  carMesh.userData.tailMat = tailMat;
  carMesh.userData.model = inst;
}
