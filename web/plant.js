// Plant view (design §5): the current released plant model in 3D, built only from the model's records.
// Physical mode: procedural architectural realism — sky environment, ACES, a fixed sun whose shadows are baked once,
// canvas textures, instanced rails, windows, flanges and pipes. No external models or images.
// Picking uses invisible proxy boxes; the camera moves only on an explicit flyTo (NAB-012 §7 rule 7).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { Sky } from "three/addons/objects/Sky.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const DATUM = 1450; // level (m) drawn at y = 0
const GROUND = 1448;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const BUILDING = new Set(["pump_house", "dosing_house", "chlorine_house", "chemical_store", "mcc", "lab", "admin", "gen_set", "pipe_gallery"]);
const OPENABLE = new Set(["pump_house", "dosing_house", "chlorine_house"]); // click-down: walls go translucent
const ROUND = new Set(["clarifier_circular", "thickener"]);
const STATE_COLOR = { running: 0x4ade80, standby: 0x60a5fa, isolated: 0x94a3b8, fault: 0xf87171, tripped: 0xf87171 };
const BAND_COLOR = { in: 0x2b7a83, near: 0x8f8a3c, over: 0x7a4a26, none: 0x2a6b7d };
// Machine look by position-tag prefix: [length, width, height] of the unit on its plinth.
const MACHINE = { RWP: [2.2, 1.0, 1.1], BWP: [2.0, 0.9, 1.0], HLP: [2.6, 1.1, 1.2], SLP: [1.2, 0.6, 0.7], DP: [0.9, 0.6, 0.7], BLW: [1.6, 1.0, 1.2], CL: [1.0, 1.0, 0.9], CHL: [0.6, 0.4, 0.9], GEN: [3.2, 1.2, 1.8] };
const SUN = { azimuthDeg: 110, elevationDeg: 35 };
// Blueprint process-line colours by service, read on navy.
const SERVICE_COLOR = { raw: 0xd4a373, coagulated: 0xe9c46a, flocculated: 0xf4a261, settled: 0x8ecae6, filtered: 0x48cae4, chlorinated: 0x90e0ef, final: 0x00b4d8,
  "backwash supply": 0x4ade80, "supernatant return": 0xc8b6ff, coagulant: 0xff70a6, polymer: 0xff9770, lime: 0xf1f5f9, "chlorine (vacuum)": 0xffd670 };

export const bandOf = (r) => (!r || r.alarmHi == null || r.value == null ? "none" : r.value <= r.alarmHi * 0.7 ? "in" : r.value <= r.alarmHi ? "near" : "over");

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function canvasTex(size, paint, { repeat = [1, 1], color = true } = {}) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d"), img = g.createImageData(size, size);
  paint(img.data, size);
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
// Speckled noise around a base colour; grime darkens towards the bottom of the tile (wall bases).
const noise = (hex, spread, seed, { speck = 0, grime = 0, repeat } = {}) => canvasTex(256, (d, s) => {
  const r = rng(seed), R = (hex >> 16) & 255, G = (hex >> 8) & 255, B = hex & 255;
  for (let i = 0; i < s * s; i++) {
    const y = Math.floor(i / s), n = (r() - 0.5) * spread - (speck && r() < speck ? 35 : 0) - grime * Math.max(0, y / s - 0.6) * 160;
    d[i * 4] = R + n; d[i * 4 + 1] = G + n; d[i * 4 + 2] = B + n * 0.9; d[i * 4 + 3] = 255;
  }
}, { repeat });
// Tileable ripple normal map from periodic sines.
const ripple = () => canvasTex(128, (d, s) => {
  const h = (x, y) => Math.sin((x / s) * Math.PI * 8) * 0.5 + Math.sin(((x + y) / s) * Math.PI * 6) * 0.3 + Math.sin((y / s) * Math.PI * 10 + 1) * 0.2;
  const v = new THREE.Vector3();
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    v.set(-(h(x + 1, y) - h(x - 1, y)), -(h(x, y + 1) - h(x, y - 1)), 1).normalize();
    const i = (y * s + x) * 4;
    d[i] = (v.x * 0.5 + 0.5) * 255; d[i + 1] = (v.y * 0.5 + 0.5) * 255; d[i + 2] = (v.z * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
}, { repeat: [6, 6], color: false });

// An open-topped rectangular shell (walls only), base at y = 0.
function shell(w, l, h, t = 0.35) {
  const parts = [[w, h, t, 0, (l - t) / 2], [w, h, t, 0, -(l - t) / 2], [t, h, l - 2 * t, (w - t) / 2, 0], [t, h, l - 2 * t, -(w - t) / 2, 0]];
  return mergeGeometries(parts.map(([a, b, c, x, z]) => new THREE.BoxGeometry(a, b, c).translate(x, h / 2, z)));
}

export function mountPlant(container, data, { mode = "physical", quality = "medium", onSelect, onSlow, onLost } = {}) {
  const w = () => container.clientWidth || 800, h = () => container.clientHeight || 500;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(1.5, devicePixelRatio));
  renderer.setSize(w(), h());
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.75;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; // baked once, re-baked only on rebuild
  container.prepend(renderer.domElement);
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute("aria-label", `3D plant, model rev ${data.model.rev}. Click a structure, machine or valve to select it.`);
  const labels = new CSS2DRenderer();
  labels.setSize(w(), h());
  Object.assign(labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
  container.append(labels.domElement);

  const [bx, by, bX, bY] = data.bounds || [0, 0, 770, 190];
  const cx = (bx + bX) / 2, cy = (by + bY) / 2;
  const P = (x, y, level) => new THREE.Vector3(x - cx, level - DATUM, y - cy); // site metres (x east, y south) to scene

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, w() / h(), 0.5, 6000);
  camera.position.set(-150, 110, 330);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 8, 0);
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 6;
  controls.maxDistance = 1600;
  controls.enableDamping = !reduced;

  // ---- sky, environment, sun ----
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - SUN.elevationDeg), THREE.MathUtils.degToRad(180 - SUN.azimuthDeg));
  const sky = new Sky();
  sky.scale.setScalar(5000);
  sky.material.uniforms.turbidity.value = 4; sky.material.uniforms.rayleigh.value = 1.3;
  sky.material.uniforms.mieCoefficient.value = 0.004; sky.material.uniforms.mieDirectionalG.value = 0.8; sky.material.uniforms.sunPosition.value.copy(sunDir);
  const pmrem = new THREE.PMREMGenerator(renderer), envScene = new THREE.Scene(), envSky = new Sky();
  envSky.scale.setScalar(90);
  for (const k of ["turbidity", "rayleigh", "mieCoefficient", "mieDirectionalG"]) envSky.material.uniforms[k].value = sky.material.uniforms[k].value;
  envSky.material.uniforms.sunPosition.value.copy(sunDir);
  envScene.add(envSky);
  const envRT = pmrem.fromScene(envScene);
  scene.environment = envRT.texture;
  scene.fog = new THREE.Fog(0xbfcad6, 700, 2400);
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  sun.position.copy(sunDir).multiplyScalar(600);
  sun.castShadow = true;
  const sm = quality === "high" ? 4096 : 2048;
  sun.shadow.mapSize.set(sm, sm);
  Object.assign(sun.shadow.camera, { left: -(bX - bx) / 2 - 40, right: (bX - bx) / 2 + 40, top: 260, bottom: -260, near: 100, far: 1400 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.4;
  scene.add(sun, sun.target);

  // ---- materials (a small shared set) ----
  const tex = { concrete: noise(0xa9a59c, 26, 1, { speck: 0.02, repeat: [2, 2] }), wall: noise(0xa29e95, 22, 2, { grime: 1, speck: 0.01 }), grass: noise(0x8c8656, 46, 3, { speck: 0.08, repeat: [90, 90] }), lawn: noise(0x5e7f3b, 30, 7, { repeat: [8, 8] }), gravel: noise(0x9b958a, 60, 4, { speck: 0.15, repeat: [20, 20] }), plaster: noise(0xd9d3c4, 14, 5), roof: noise(0x6a717a, 18, 6), water: ripple() };
  const M = {
    concrete: new THREE.MeshStandardMaterial({ map: tex.concrete, roughness: 0.92 }),
    wall: new THREE.MeshStandardMaterial({ map: tex.wall, roughness: 0.92 }),
    grass: new THREE.MeshStandardMaterial({ map: tex.grass, roughness: 1 }),
    lawn: new THREE.MeshStandardMaterial({ map: tex.lawn, roughness: 0.95 }),
    gravel: new THREE.MeshStandardMaterial({ map: tex.gravel, roughness: 1 }),
    galv: new THREE.MeshStandardMaterial({ color: 0xb9c1c8, metalness: 0.85, roughness: 0.35 }),
    painted: new THREE.MeshStandardMaterial({ color: 0x2f5f8f, metalness: 0.3, roughness: 0.45 }),
    ductile: new THREE.MeshStandardMaterial({ color: 0x3b4048, metalness: 0.5, roughness: 0.55 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x2c4456, metalness: 0.4, roughness: 0.08, envMapIntensity: 0.9 }),
    water: new THREE.MeshStandardMaterial({ color: BAND_COLOR.none, roughness: 0.08, metalness: 0.1, normalMap: tex.water, normalScale: new THREE.Vector2(0.3, 0.3) }),
    tinted: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0.1, normalMap: tex.water, normalScale: new THREE.Vector2(0.3, 0.3) }),
    plinth: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }),
    light: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    alert: new THREE.MeshBasicMaterial({ color: 0xf87171, transparent: true, opacity: 0.85, depthWrite: false }),
    buried: new THREE.LineDashedMaterial({ color: 0xf2ead8, dashSize: 2.5, gapSize: 2, transparent: true, opacity: 0.55 })
  };

  // The sky environment is bright: keep it as fill so the sun (and its shadows) carry the form.
  for (const m of Object.values(M)) if (m.isMeshStandardMaterial && m !== M.glass) m.envMapIntensity = m.metalness > 0.6 ? 0.6 : 0.3;
  const phys = new THREE.Group();
  scene.add(sky, phys);
  const add = (geo, mat, { cast = true, receive = true } = {}) => { const m = new THREE.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = receive; phys.add(m); return m; };
  const proxies = [], byId = new Map(); // id -> {item, proxy, kind}
  const proxy = (item, kind, box, extra = {}) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...box.size), M.concrete);
    m.position.copy(box.centre);
    if (box.rotY) m.rotation.y = box.rotY;
    m.updateMatrixWorld(true);
    m.userData = { id: item.id, kind, ...extra };
    proxies.push(m);
    byId.set(item.id, { item, proxy: m, kind, ...extra });
    if (item.positionId) byId.set(item.positionId, byId.get(item.id));
  };

  // ---- terraces follow the hydraulic profile: each zone at its buildings' floor, else 2 m above its lowest base ----
  const zones = data.zones || [];
  const grade = new Map(zones.map((z) => {
    const ss = data.structures.filter((s) => s.zoneId === z.id), b = ss.filter((s) => BUILDING.has(s.kind) && s.kind !== "pipe_gallery");
    return [z.id, b.length ? Math.min(...b.map((s) => s.baseLevel)) : ss.length ? Math.min(...ss.map((s) => s.baseLevel)) + 2 : 1452];
  }));
  const zoneAt = (x, y) => zones.find((z) => x >= z.rect[0] && x <= z.rect[0] + z.rect[2] && y >= z.rect[1] && y <= z.rect[1] + z.rect[3]);
  const gradeAt = (x, y) => { const z = zoneAt(x, y); return z ? grade.get(z.id) : GROUND; };
  add(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2).translate(0, GROUND - DATUM, 0), M.grass, { cast: false });
  {
    const tops = [], sides = [];
    for (const z of zones) {
      const [x, y, zw, zh] = z.rect, g = grade.get(z.id), hgt = g - GROUND + 0.01, c = P(x + zw / 2, y + zh / 2, GROUND);
      tops.push(new THREE.PlaneGeometry(zw, zh).rotateX(-Math.PI / 2).translate(c.x, g - DATUM, c.z));
      sides.push(shell(zw, zh, hgt, 0.5).translate(c.x, GROUND - DATUM, c.z));
    }
    if (tops.length) { add(mergeGeometries(tops), M.lawn, { cast: false }); add(mergeGeometries(sides), M.wall); }
    // concrete aprons 2 m round each structure, just above the terrace (fake contact shadow comes from the shadow map)
    const aprons = data.structures.filter((s) => s.kind !== "reservoir_covered").map((s) => { const z = zoneAt(s.centre[0], s.centre[1]), g = z ? grade.get(z.id) : GROUND, c = P(s.centre[0], s.centre[1], g + 0.04);
      return s.diameter ? new THREE.CircleGeometry(s.diameter / 2 + 2, 40).rotateX(-Math.PI / 2).translate(c.x, c.y, c.z) : new THREE.PlaneGeometry(s.w + 4, s.l + 4).rotateX(-Math.PI / 2).translate(c.x, c.y, c.z); });
    if (aprons.length) add(mergeGeometries(aprons), M.concrete, { cast: false });
  }

  // ---- structures ----
  const basinShells = [], waterPlanes = [], railRuns = [], windows = [], buildings = new Map(), round = [], tintedFilters = [];
  const struct = new Map(data.structures.map((s) => [s.tag, s]));
  for (const s of data.structures) {
    const [x, y] = s.centre, base = P(x, y, s.baseLevel), top = s.baseLevel + s.height;
    if (ROUND.has(s.kind)) round.push(s);
    else if (s.kind === "filter_bed") tintedFilters.push(s);
    else if (s.kind === "reservoir_covered") {
      const slope = 1.6, emb = new THREE.CylinderGeometry(Math.SQRT1_2, Math.SQRT1_2 * (1 + (2 * slope * s.height) / s.w), 1, 4, 1).rotateY(Math.PI / 4);
      add(emb.scale(s.w, s.height, s.l).translate(base.x, base.y + s.height / 2, base.z), M.grass);
      for (const [dx, dz] of [[-0.25, -0.25], [0.25, 0.25], [-0.25, 0.25], [0.25, -0.25]]) windows.push({ kind: "vent", p: P(x + dx * s.w, y + dz * s.l, top + 0.5) });
    } else if (s.kind === "surge_vessel") {
      add(new THREE.CapsuleGeometry(s.diameter / 2, s.height - s.diameter, 6, 20).translate(base.x, base.y + s.height / 2, base.z), M.painted);
    } else if (BUILDING.has(s.kind)) {
      const walls = shell(s.w, s.l, s.height, 0.3), roof = mergeGeometries([new THREE.BoxGeometry(s.w, 0.35, s.l).translate(0, s.height, 0), shell(s.w, s.l, 0.7, 0.25).translate(0, s.height + 0.17, 0)]);
      const wm = M.wall.clone(), rm = new THREE.MeshStandardMaterial({ map: tex.roof, roughness: 0.85, envMapIntensity: 0.3 });
      wm.map = tex.plaster;
      const wallMesh = add(walls.translate(base.x, base.y, base.z), wm), roofMesh = add(roof.translate(base.x, base.y, base.z), rm);
      buildings.set(s.id, { walls: wallMesh, roof: roofMesh });
      const long = s.w >= s.l, len = long ? s.w : s.l, n = Math.max(1, Math.floor((len - 2) / 3.4));
      for (let i = 0; i < n; i++) for (const side of [-1, 1]) {
        const t = -len / 2 + 1 + (i + 0.5) * ((len - 2) / n);
        const p = long ? P(x + t, y + side * (s.l / 2 + 0.02), s.baseLevel + Math.min(3.2, s.height * 0.55)) : P(x + side * (s.w / 2 + 0.02), y + t, s.baseLevel + Math.min(3.2, s.height * 0.55));
        windows.push({ kind: "window", p, rotY: long ? 0 : Math.PI / 2 });
      }
    } else {
      // open concrete basins and channels; the contact tank and the old sump are covered
      basinShells.push(shell(s.w, s.l, s.height, 0.35).translate(base.x, base.y, base.z));
      const covered = s.kind === "contact_tank" || s.kind === "sump";
      if (covered) basinShells.push(new THREE.BoxGeometry(s.w, 0.3, s.l).translate(base.x, top - DATUM, base.z));
      else if (s.twl != null) waterPlanes.push(new THREE.PlaneGeometry(s.w - 0.7, s.l - 0.7).rotateX(-Math.PI / 2).translate(base.x, s.twl - DATUM, base.z));
      if (!covered) railRuns.push({ s, top });
    }
    const size = s.diameter ? [s.diameter, s.height, s.diameter] : [s.w, s.height, s.l];
    proxy(s, "structure", { size, centre: new THREE.Vector3(base.x, base.y + s.height / 2, base.z) });
  }
  if (basinShells.length) add(mergeGeometries(basinShells), M.wall);
  if (waterPlanes.length) add(mergeGeometries(waterPlanes), M.water, { cast: false });

  // Filters: one instanced shell and one instanced, band-tinted water surface.
  const filterIndex = new Map();
  let filterWater = null;
  if (tintedFilters.length) {
    const f0 = tintedFilters[0], fShell = new THREE.InstancedMesh(shell(f0.w, f0.l, f0.height, 0.35), M.wall, tintedFilters.length);
    filterWater = new THREE.InstancedMesh(new THREE.PlaneGeometry(f0.w - 0.7, f0.l - 0.7).rotateX(-Math.PI / 2), M.tinted, tintedFilters.length);
    const m4 = new THREE.Matrix4();
    tintedFilters.forEach((s, i) => {
      const b = P(s.centre[0], s.centre[1], s.baseLevel);
      fShell.setMatrixAt(i, m4.makeTranslation(b.x, b.y, b.z));
      filterWater.setMatrixAt(i, m4.makeTranslation(b.x, (s.twl ?? s.baseLevel + s.height - 0.6) - DATUM, b.z));
      filterWater.setColorAt(i, new THREE.Color(BAND_COLOR.none));
      filterIndex.set(s.id, i);
      railRuns.push({ s, top: s.baseLevel + s.height });
    });
    fShell.castShadow = fShell.receiveShadow = true;
    phys.add(fShell, filterWater);
  }

  // Clarifiers and the thickener: lathe walls with a launder lip, water, a fixed bridge and a turning rake/skimmer.
  const rakes = new Map(); // structure id -> group
  for (const s of round) {
    const R = s.diameter / 2, H = s.height, b = P(s.centre[0], s.centre[1], s.baseLevel);
    const prof = [[0.4, 0.3], [R - 0.35, -0.6], [R - 0.35, 0], [R, 0], [R, H + 0.15], [R - 0.9, H + 0.15], [R - 0.9, H - 0.45], [R - 1.1, H - 0.45]].map(([r, yy]) => new THREE.Vector2(r, yy));
    add(new THREE.LatheGeometry(prof, 56).translate(b.x, b.y, b.z), M.wall);
    add(new THREE.CircleGeometry(R - 0.95, 56).rotateX(-Math.PI / 2).translate(b.x, (s.twl ?? s.baseLevel + H - 0.3) - DATUM, b.z), M.water, { cast: false });
    add(new THREE.BoxGeometry(R + 0.4, 0.6, 1.4).translate(b.x + R / 2, b.y + H + 0.9, b.z), M.galv);
    const g = new THREE.Group();
    g.position.set(b.x, b.y + H + 0.05, b.z);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(R - 1.2, 0.25, 0.5).translate((R - 1.2) / 2, 0, 0), M.painted);
    const drive = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 1.2, 20).translate(0, 0.6, 0), M.painted);
    arm.castShadow = drive.castShadow = true;
    g.add(arm, drive);
    phys.add(g);
    rakes.set(s.id, g);
  }

  // Handrails on basin and filter tops: instanced rails and posts.
  {
    const rails = [], posts = [];
    for (const { s, top } of railRuns) {
      const [x, y] = s.centre, y0 = top + 1.1;
      for (const [ax, ay, bx2, by2] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
        const p0 = P(x + (ax * s.w) / 2, y + (ay * s.l) / 2, y0), p1 = P(x + (bx2 * s.w) / 2, y + (by2 * s.l) / 2, y0), len = p0.distanceTo(p1);
        rails.push({ mid: p0.clone().add(p1).multiplyScalar(0.5), len, rotY: Math.abs(p1.x - p0.x) > 0.01 ? 0 : Math.PI / 2 });
        for (let t = 0; t < len; t += 2.5) posts.push(p0.clone().lerp(p1, t / len).setY(top - DATUM + 0.55));
      }
    }
    const rail = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.05, 0.05), M.galv, Math.max(1, rails.length));
    const post = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 1.1, 0.05), M.galv, Math.max(1, posts.length));
    const o = new THREE.Object3D();
    rails.forEach((r, i) => { o.position.copy(r.mid); o.rotation.set(0, r.rotY, 0); o.scale.set(r.len, 1, 1); o.updateMatrix(); rail.setMatrixAt(i, o.matrix); });
    posts.forEach((p, i) => { o.position.copy(p); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1); o.updateMatrix(); post.setMatrixAt(i, o.matrix); });
    rail.count = rails.length; post.count = posts.length;
    phys.add(rail, post);
  }
  // Windows on buildings and vents on reservoir roofs.
  {
    const ws = windows.filter((x) => x.kind === "window"), vs = windows.filter((x) => x.kind === "vent");
    const wi = new THREE.InstancedMesh(new THREE.BoxGeometry(1.8, 1.2, 0.12), M.glass, Math.max(1, ws.length)), vi = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.4, 0.4, 1, 10), M.galv, Math.max(1, vs.length));
    const o = new THREE.Object3D();
    ws.forEach((x, i) => { o.position.copy(x.p); o.rotation.set(0, x.rotY, 0); o.updateMatrix(); wi.setMatrixAt(i, o.matrix); });
    vs.forEach((x, i) => { o.position.copy(x.p); o.rotation.set(0, 0, 0); o.updateMatrix(); vi.setMatrixAt(i, o.matrix); });
    wi.count = ws.length; vi.count = vs.length;
    phys.add(wi, vi);
  }

  // ---- machines: plinth and status light tinted by the asset's state; instanced per part ----
  const machines = data.machines.filter((m) => byId.has(m.structureId));
  const mPlinth = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.3, 1).translate(0, 0.15, 0), M.plinth, Math.max(1, machines.length));
  const mBody = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 16).rotateZ(Math.PI / 2), M.painted, Math.max(1, machines.length));
  const mCase = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 16), M.ductile, Math.max(1, machines.length));
  const mLight = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 8, 6), M.light, Math.max(1, machines.length));
  const machineIndex = new Map(), alertRings = new Map();
  {
    const o = new THREE.Object3D();
    machines.forEach((m, i) => {
      const s = byId.get(m.structureId)?.item, [L, W, H] = MACHINE[m.tag.split("-")[0]] || [1.2, 0.8, 1];
      const base = s ? P(s.centre[0] + m.offset[0], s.centre[1] + m.offset[1], s.baseLevel + m.offset[2]) : new THREE.Vector3();
      o.rotation.set(0, THREE.MathUtils.degToRad(m.rotDeg || 0), 0);
      o.position.copy(base); o.scale.set(L, 1, W); o.updateMatrix(); mPlinth.setMatrixAt(i, o.matrix);
      o.position.set(base.x - L * 0.12, base.y + 0.3 + H / 2, base.z); o.scale.set(L * 0.55, H, W * 0.9); o.updateMatrix(); mBody.setMatrixAt(i, o.matrix);
      o.position.set(base.x + L * 0.3, base.y + 0.3 + H / 2, base.z); o.scale.set(W * 1.1, H * 0.8, W * 1.1); o.updateMatrix(); mCase.setMatrixAt(i, o.matrix);
      o.position.set(base.x - L * 0.45, base.y + 0.45, base.z + W * 0.45); o.scale.set(1, 1, 1); o.updateMatrix(); mLight.setMatrixAt(i, o.matrix);
      machineIndex.set(m.positionId || m.id, i);
      proxy(m, "machine", { size: [L, H + 0.3, W], centre: new THREE.Vector3(base.x, base.y + (H + 0.3) / 2, base.z) }, { structureId: m.structureId });
    });
    for (const im of [mPlinth, mBody, mCase]) { im.castShadow = im.receiveShadow = true; }
    phys.add(mPlinth, mBody, mCase, mLight);
  }
  const paintMachine = (m) => {
    const i = machineIndex.get(m.positionId || m.id);
    if (i == null) return;
    const c = new THREE.Color(STATE_COLOR[m.state] ?? 0x64748b);
    mPlinth.setColorAt(i, c); mLight.setColorAt(i, c);
    let ring = alertRings.get(m.id);
    if (m.alerts > 0 && !ring) {
      const pr = byId.get(m.id).proxy;
      ring = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.08, 6, 32).rotateX(Math.PI / 2), M.alert);
      ring.position.copy(pr.position).setY(pr.position.y + 1.6);
      phys.add(ring); alertRings.set(m.id, ring);
    } else if (!(m.alerts > 0) && ring) { phys.remove(ring); ring.geometry.dispose(); alertRings.delete(m.id); }
  };
  machines.forEach(paintMachine);

  // ---- lines: above-grade pipes as instanced cylinders with flanges; buried pipes as a faded dash at grade; channels open concrete ----
  {
    const pipes = [], flanges = [], channels = [], buried = [];
    for (const l of data.lines) for (const part of l.parts) for (let i = 1; i < part.length; i++) {
      const [x0, y0, z0] = part[i - 1], [x1, y1, z1] = part[i];
      const a = P(x0, y0, z0), b = P(x1, y1, z1);
      if (a.distanceTo(b) < 0.05) continue;
      if (l.conveyance === "channel") channels.push({ a, b, wd: l.width || 1, dp: l.depth || 1 });
      else if (z0 < gradeAt(x0, y0) - 0.3 && z1 < gradeAt(x1, y1) - 0.3) buried.push(P(x0, y0, gradeAt(x0, y0) + 0.06), P(x1, y1, gradeAt(x1, y1) + 0.06));
      else { pipes.push({ a, b, r: Math.max(0.05, (l.dn || 100) / 2000) }); if (i === 1) flanges.push({ p: a, r: (l.dn || 100) / 2000 }); flanges.push({ p: b, r: (l.dn || 100) / 2000 }); }
    }
    const o = new THREE.Object3D(), up = new THREE.Vector3(0, 1, 0);
    const seg = (im, list, fn) => { list.forEach((s, i) => { fn(s); o.updateMatrix(); im.setMatrixAt(i, o.matrix); }); im.count = list.length; im.castShadow = true; im.receiveShadow = true; phys.add(im); };
    const along = (a, b) => { const d = b.clone().sub(a); o.position.copy(a).add(b).multiplyScalar(0.5); o.quaternion.setFromUnitVectors(up, d.clone().normalize()); return d.length(); };
    seg(new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 12), M.ductile, Math.max(1, pipes.length)), pipes, (s) => { const len = along(s.a, s.b); o.scale.set(s.r, len, s.r); });
    seg(new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 12), M.ductile, Math.max(1, flanges.length)), flanges, (s) => { o.position.copy(s.p); o.quaternion.identity(); o.scale.set(s.r * 1.6, 0.08, s.r * 1.6); });
    const chan = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), M.concrete, Math.max(1, channels.length));
    const chanW = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.02, 1), M.water, Math.max(1, channels.length));
    const flat = (s, wid, y, hgt) => { const d = s.b.clone().sub(s.a); o.position.copy(s.a).add(s.b).multiplyScalar(0.5).setY(y); o.quaternion.setFromAxisAngle(up, Math.atan2(-d.z, d.x)); o.scale.set(d.length() + wid, hgt, wid); };
    seg(chan, channels, (s) => flat(s, s.wd + 0.5, s.a.y - s.dp / 2 + 0.1, s.dp + 0.2));
    seg(chanW, channels, (s) => flat(s, s.wd, s.a.y + 0.02, 1));
    chanW.castShadow = false;
    if (buried.length) { const ls = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(buried), M.buried); ls.computeLineDistances(); phys.add(ls); }
  }

  // ---- valves on the filter tag table: instanced, pickable ----
  {
    const lineById = new Map(data.lines.map((l) => [l.id, l]));
    const vs = data.valves.map((v, k) => {
      const f = struct.get(v.filter), role = v.tag.split("-").pop(), line = v.lineId && lineById.get(v.lineId);
      const pts = line && line.parts.flat();
      let p;
      if (pts && pts.length >= 2 && role === "inlet") { const q = pts[pts.length - 1], r = pts[pts.length - 2], t = Math.min(1, 3 / Math.hypot(q[0] - r[0], q[1] - r[1])); p = P(q[0] + (r[0] - q[0]) * t, q[1] + (r[1] - q[1]) * t, f ? f.baseLevel + 1 : q[2]); }
      else if (pts && pts.length >= 2 && role === "outlet") { const q = pts[0], r = pts[1], t = Math.min(1, 3 / Math.hypot(q[0] - r[0], q[1] - r[1])); p = P(q[0] + (r[0] - q[0]) * t, q[1] + (r[1] - q[1]) * t, f ? f.baseLevel + 1 : q[2]); }
      else if (f) p = P(f.centre[0] - f.w / 2 + 1 + (k % 6), f.centre[1] + (f.centre[1] < 35 ? 1 : -1) * (f.l / 2 + 1.2), f.baseLevel + 1);
      return p && { v, p };
    }).filter(Boolean);
    const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.35, 0.5, 12).rotateX(Math.PI / 2), M.painted, Math.max(1, vs.length));
    const o = new THREE.Object3D();
    vs.forEach(({ v, p }, i) => { o.position.copy(p); o.updateMatrix(); im.setMatrixAt(i, o.matrix); proxy(v, "valve", { size: [0.9, 0.9, 0.9], centre: p }); });
    im.count = vs.length;
    phys.add(im);
  }

  // ---- band tint: a structure's water from its sample point (at it, or on its outlet line) ----
  const lineFrom = new Map(data.lines.map((l) => [l.id, l.fromId]));
  const spStructure = new Map(data.samplePoints.map((sp) => [sp.id, sp.structureId || lineFrom.get(sp.lineId) || null]));
  const tint = (sp) => {
    const sid = spStructure.get(sp.id), i = filterIndex.get(sid);
    if (i == null || !filterWater) return;
    filterWater.setColorAt(i, new THREE.Color(BAND_COLOR[bandOf(sp.reading)]));
    filterWater.instanceColor.needsUpdate = true;
  };
  data.samplePoints.forEach(tint);
  const rakeRunning = new Map();
  const setRake = (m) => { const cl = /^CL-\d$/.test(m.tag) && byId.get(m.structureId); if (cl) rakeRunning.set(cl.item.id, m.state === "running"); };
  machines.forEach(setRake);

  // ---- labels (CSS2D only), selection, click-down ----
  const mkLabel = (cls) => { const el = document.createElement("div"); el.className = `plabel ${cls}`; const o = new CSS2DObject(el); o.visible = false; scene.add(o); return o; };
  const hoverLabel = mkLabel("hover"), selLabel = mkLabel("sel");
  const nameOf = (e) => (e.kind === "machine" ? `${e.item.tag}${e.item.state ? ` · ${e.item.state}` : ""}` : e.kind === "valve" ? `${e.item.tag} · ${e.item.kind}` : `${e.item.tag} · ${e.item.kind.replace(/_/g, " ")}`);
  const dims = (it) => [it.diameter ? `Ø${it.diameter} m` : it.w ? `${it.w} × ${it.l} m` : "", it.baseLevel != null ? `floor ${it.baseLevel}` : "", it.twl != null ? `TWL ${it.twl}` : "", it.height ? `h ${it.height} m` : ""].filter(Boolean).join(" · ");
  const place = (lab, e) => { lab.element.textContent = nameOf(e) + (lab === selLabel && api.mode === "blueprint" && e.kind === "structure" ? ` · ${dims(e.item)}` : ""); const b = new THREE.Box3().setFromObject(e.proxy); lab.position.set((b.min.x + b.max.x) / 2, b.max.y + 1.5, (b.min.z + b.max.z) / 2); lab.visible = true; };
  let open = null, selected = null, selBox = null;
  const setOpen = (sid) => {
    for (const [id, b] of buildings) for (const mesh of [b.walls, b.roof]) {
      const see = id === sid;
      mesh.material.transparent = see; mesh.material.opacity = see ? 0.16 : 1; mesh.material.depthWrite = !see; mesh.material.needsUpdate = true;
    }
    open = sid;
  };
  const highlights = [];
  const boxFor = (e, color) => { const h2 = new THREE.Box3Helper(new THREE.Box3().setFromObject(e.proxy).expandByScalar(0.4), color); scene.add(h2); return h2; };
  function select(id, { silent } = {}) {
    const e = id && byId.get(id);
    if (selBox) { scene.remove(selBox); selBox.dispose(); selBox = null; }
    selected = e ? e.item.id : null;
    if (!e) { selLabel.visible = false; setOpen(null); invalidate(); if (!silent) onSelect?.(null); return; }
    if (e.kind === "structure" && OPENABLE.has(e.item.kind)) setOpen(e.item.id);
    else if (e.kind === "machine" && e.structureId !== open) setOpen(buildings.has(e.structureId) && OPENABLE.has(byId.get(e.structureId)?.item.kind) ? e.structureId : null);
    else if (e.kind === "structure") setOpen(null);
    selBox = boxFor(e, 0x60a5fa);
    place(selLabel, e);
    invalidate();
    if (!silent) onSelect?.({ ...e.item, kind3d: e.kind });
  }
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const hit = (ev) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    // machines inside a closed building cannot be picked through its walls
    const cands = proxies.filter((p) => api.mode === "blueprint" || p.userData.kind !== "machine" || p.userData.structureId === open || !buildings.has(p.userData.structureId));
    const hits = ray.intersectObjects(cands, false);
    const inner = hits.find((x) => x.object.userData.kind !== "structure");
    return (inner || hits[0])?.object.userData.id || null;
  };
  let down = null;
  renderer.domElement.addEventListener("pointerdown", (ev) => { down = [ev.clientX, ev.clientY]; });
  renderer.domElement.addEventListener("pointerup", (ev) => { if (down && Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) < 5) select(hit(ev)); down = null; });
  renderer.domElement.addEventListener("pointermove", (ev) => {
    if (ev.buttons) return;
    const id = hit(ev), e = id && byId.get(id);
    if (e && e.item.id !== selected) place(hoverLabel, e); else hoverLabel.visible = false;
    renderer.domElement.style.cursor = e ? "pointer" : "";
    invalidate();
  });
  renderer.domElement.addEventListener("webglcontextlost", (ev) => { ev.preventDefault(); onLost?.(); });

  // ---- blueprint mode (design §5.3): navy ground, hidden-line edges, process lines by service with flow arrows ----
  const NAVY = 0x0b1d36, EDGE = 0x9cc3ff;
  let bp = null;
  const bpOpts = { xray: false, skeletal: false };
  function buildBlueprint() {
    const g = new THREE.Group(), occ = [], edges = [], foot = [];
    const ring = (cxz, y, pts) => { for (let i = 0; i < pts.length; i++) { const [a, b] = [pts[i], pts[(i + 1) % pts.length]]; foot.push(new THREE.Vector3(cxz.x + a[0], y, cxz.z + a[1]), new THREE.Vector3(cxz.x + b[0], y, cxz.z + b[1])); } };
    for (const s of data.structures) {
      const b = P(s.centre[0], s.centre[1], s.baseLevel), R = (s.diameter || 0) / 2;
      const geo = (s.diameter ? new THREE.CylinderGeometry(R, R, s.height, 40) : new THREE.BoxGeometry(s.w, s.height, s.l)).translate(b.x, b.y + s.height / 2, b.z);
      occ.push(geo); edges.push(new THREE.EdgesGeometry(geo, 30));
      ring(b, b.y + 0.02, s.diameter ? Array.from({ length: 40 }, (_, i) => [R * Math.cos((i / 40) * Math.PI * 2), R * Math.sin((i / 40) * Math.PI * 2)]) : [[-s.w / 2, -s.l / 2], [s.w / 2, -s.l / 2], [s.w / 2, s.l / 2], [-s.w / 2, s.l / 2]]);
    }
    for (const e of new Set(byId.values())) if (e.kind === "machine") {
      const box = new THREE.Box3().setFromObject(e.proxy), sz = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      edges.push(new THREE.EdgesGeometry(new THREE.BoxGeometry(sz.x, sz.y, sz.z).translate(c.x, c.y, c.z)));
    }
    const occluder = new THREE.Mesh(mergeGeometries(occ), new THREE.MeshBasicMaterial({ color: NAVY, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    const edgeLines = new THREE.LineSegments(mergeGeometries(edges), new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.9 }));
    const footLines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(foot), new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.7 }));
    footLines.visible = false;
    for (const x of [...occ, ...edges]) x.dispose();
    // process lines (causal) as wide lines coloured by service; utilities thin and dashed
    const pos = [], col = [], arrows = [], dashed = [], c = new THREE.Color();
    for (const l of data.lines) for (const part of l.parts) for (let i = 1; i < part.length; i++) {
      const a = P(...part[i - 1]), b = P(...part[i]);
      if (a.distanceTo(b) < 0.05) continue;
      if (!l.causal) { dashed.push(a, b); continue; }
      c.setHex(SERVICE_COLOR[l.service] ?? 0xe8eef6);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z); col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (a.distanceTo(b) > 10) arrows.push({ p: a.clone().lerp(b, 0.5), d: b.clone().sub(a).normalize(), c: c.clone() });
    }
    const proc = new LineSegments2(new LineSegmentsGeometry().setPositions(pos).setColors(col), new LineMaterial({ vertexColors: true, linewidth: 3, transparent: true }));
    proc.material.resolution.set(w(), h());
    const util = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(dashed), new THREE.LineDashedMaterial({ color: 0x94a3b8, dashSize: 1.5, gapSize: 1.2, transparent: true, opacity: 0.8 }));
    util.computeLineDistances();
    const arrowMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.9, 2.6, 8), new THREE.MeshBasicMaterial({ transparent: true }), Math.max(1, arrows.length));
    const o = new THREE.Object3D(), up = new THREE.Vector3(0, 1, 0);
    arrows.forEach((a, i) => { o.position.copy(a.p); o.quaternion.setFromUnitVectors(up, a.d); o.updateMatrix(); arrowMesh.setMatrixAt(i, o.matrix); arrowMesh.setColorAt(i, a.c); });
    arrowMesh.count = arrows.length;
    const zoneLines = [];
    for (const z of zones) { const [x, y, zw, zh] = z.rect, gl = (grade.get(z.id) ?? GROUND) + 0.02; for (const [p, q] of [[[x, y], [x + zw, y]], [[x + zw, y], [x + zw, y + zh]], [[x + zw, y + zh], [x, y + zh]], [[x, y + zh], [x, y]]]) zoneLines.push(P(p[0], p[1], gl), P(q[0], q[1], gl)); }
    const zoneOutline = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(zoneLines), new THREE.LineDashedMaterial({ color: 0x3b82f6, dashSize: 3, gapSize: 2, transparent: true, opacity: 0.6 }));
    zoneOutline.computeLineDistances();
    const grid = new THREE.GridHelper(2000, 200, 0x1e3a8a, 0x14284a);
    grid.position.y = GROUND - DATUM;
    g.add(grid, zoneOutline, occluder, edgeLines, footLines, util, proc, arrowMesh);
    // labels: equipment always; valves and instruments past a zoom threshold or when selected; decluttered on a 48 px grid
    const tags = [];
    for (const e of new Set(byId.values())) {
      const el = document.createElement("div");
      el.className = `plabel bp ${e.kind}`;
      el.textContent = e.item.tag;
      const lab = new CSS2DObject(el), b = new THREE.Box3().setFromObject(e.proxy);
      lab.position.set((b.min.x + b.max.x) / 2, b.max.y + 0.8, (b.min.z + b.max.z) / 2);
      g.add(lab);
      tags.push({ lab, e, minor: e.kind === "valve", pr: e.kind === "valve" ? 1 : e.kind === "machine" ? 2 : 3 });
    }
    for (const sp of data.samplePoints) {
      const host = byId.get(sp.structureId) || [...byId.values()].find((x) => x.kind === "structure" && x.item.id === lineFrom.get(sp.lineId));
      if (!host) continue;
      const el = document.createElement("div"), lab = new CSS2DObject(el), b = new THREE.Box3().setFromObject(host.proxy);
      el.className = "plabel bp instrument"; el.textContent = sp.instrument;
      lab.position.set(b.max.x, b.min.y + 1, b.max.z);
      g.add(lab);
      tags.push({ lab, e: { item: { id: sp.id } }, minor: true, pr: 1 });
    }
    g.visible = false;
    scene.add(g);
    return { g, occluder, edgeLines, footLines, proc, util, arrowMesh, tags, overlay: null };
  }
  const declutter = () => {
    if (!bp) return;
    const near = camera.position.distanceTo(controls.target) < 140, taken = new Set(), v = new THREE.Vector3(), W = w(), H = h();
    const rank = (t) => (t.e.item.id === selected ? 9 : t.e.item.alerts > 0 ? 8 : t.pr);
    for (const t of [...bp.tags].sort((a, b) => rank(b) - rank(a))) {
      let show = !t.minor || near || t.e.item.id === selected;
      if (show) {
        v.copy(t.lab.position).project(camera);
        const key = `${Math.floor(((v.x + 1) / 2) * W / 48)}:${Math.floor(((1 - v.y) / 2) * H / 48)}`;
        if (v.z > 1 || taken.has(key)) show = false; else taken.add(key);
      }
      t.lab.visible = show;
    }
  };
  const applyMode = (m) => {
    const blue = m === "blueprint";
    if (blue && !bp) bp = buildBlueprint();
    phys.visible = !blue; sky.visible = !blue;
    for (const lab of [hoverLabel, selLabel]) lab.element.classList.toggle("bp", blue);
    if (bp) { bp.g.visible = blue; bp.occluder.visible = blue && !bpOpts.xray && !bpOpts.skeletal; bp.edgeLines.visible = !bpOpts.skeletal; bp.footLines.visible = bpOpts.skeletal; bp.arrowMesh.visible = !bpOpts.skeletal; }
    scene.background = blue ? new THREE.Color(NAVY) : null;
    scene.fog = blue ? null : physFog;
    renderer.toneMapping = blue ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  };
  const physFog = scene.fog;

  // ---- cross-fade between modes: two render targets composited on a full-screen quad (≈300 ms; instant under reduced motion) ----
  let fade = null, rtA = null, rtB = null;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { a: { value: null }, b: { value: null }, k: { value: 0 }, ea: { value: 0 }, eb: { value: 0 } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    // render targets hold linear, untone-mapped colour: tone-map the physical pass (ACES fit), mix, then encode sRGB
    fragmentShader: `uniform sampler2D a; uniform sampler2D b; uniform float k; uniform float ea; uniform float eb; varying vec2 vUv;
      vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
      vec3 tone(vec3 c, float e) { return e > 0.0 ? aces(c * e) : c; }
      vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
      void main() { gl_FragColor = vec4(srgb(mix(tone(texture2D(a, vUv).rgb, ea), tone(texture2D(b, vUv).rgb, eb), k)), 1.0); }`,
    depthTest: false, depthWrite: false
  }));
  const quadScene = new THREE.Scene(), quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  quadScene.add(quad);
  const renderTo = (rt, m) => { applyMode(m); renderer.setRenderTarget(rt); renderer.render(scene, camera); };
  const drawFade = (now) => {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    for (const k of ["rtA", "rtB"]) { const rt = k === "rtA" ? rtA : rtB; if (!rt || rt.width !== size.x || rt.height !== size.y) { rt?.dispose(); const n = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType }); if (k === "rtA") rtA = n; else rtB = n; } }
    const t = Math.min(1, (now - fade.t0) / 300);
    renderTo(rtA, fade.from); renderTo(rtB, fade.to);
    renderer.setRenderTarget(null);
    const u = quad.material.uniforms, ex = (m) => (m === "physical" ? renderer.toneMappingExposure : 0);
    u.a.value = rtA.texture; u.b.value = rtB.texture; u.k.value = t * t * (3 - 2 * t); u.ea.value = ex(fade.from); u.eb.value = ex(fade.to);
    renderer.render(quadScene, quadCam);
    if (t >= 1) { applyMode(fade.to); fade = null; }
  };

  // ---- render on demand; a continuous loop only while water, rakes or alerts move and motion is allowed ----
  let dirty = true, raf = 0, last = performance.now(), frames = [], fly = null;
  const invalidate = () => { dirty = true; };
  controls.addEventListener("change", invalidate);
  const info = () => { window.__plant = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, mode: api.mode, screenOf: api.screenOf }; };
  renderer.shadowMap.needsUpdate = true;
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000);
    if (frames.length < 30 && now !== last) { frames.push(now - last); if (frames.length === 30) { const s = [...frames].sort((a, b) => a - b); if (s[15] > 33 && api.mode === "physical") onSlow?.(s[15]); } }
    last = now;
    const moving = !reduced && api.mode === "physical";
    if (fly) {
      const t = Math.min(1, (now - fly.t0) / fly.ms), k = t * t * (3 - 2 * t);
      controls.target.lerpVectors(fly.ft, fly.tt, k); camera.position.lerpVectors(fly.fp, fly.tp, k);
      if (t >= 1) fly = null;
      dirty = true;
    }
    if (moving) {
      tex.water.offset.x += dt * 0.02; tex.water.offset.y += dt * 0.013;
      for (const [id, g] of rakes) if (rakeRunning.get(id)) g.rotation.y -= dt * 0.1;
      for (const ring of alertRings.values()) { const s = 1 + 0.25 * Math.sin(now / 250); ring.scale.set(s, 1, s); }
    }
    controls.update();
    if (fade) { drawFade(now); labels.render(scene, camera); info(); return; }
    if (dirty || moving) {
      if (api.mode === "blueprint") declutter();
      renderer.render(scene, camera); labels.render(scene, camera); dirty = false; info();
    }
  };
  const ro = new ResizeObserver(() => { camera.aspect = w() / h(); camera.updateProjectionMatrix(); renderer.setSize(w(), h()); labels.setSize(w(), h()); bp?.proc.material.resolution.set(w(), h()); invalidate(); });
  ro.observe(container);
  applyMode(mode);
  raf = requestAnimationFrame(loop);

  // Upstream overlay: lines whose both ends are highlighted, drawn wide and bright over everything else.
  const overlayFor = (ids) => {
    const set = new Set(ids), pos = [];
    for (const l of data.lines) if (l.causal && set.has(l.fromId) && set.has(l.toId)) for (const part of l.parts) for (let i = 1; i < part.length; i++) { const a = P(...part[i - 1]), b = P(...part[i]); pos.push(a.x, a.y + 0.3, a.z, b.x, b.y + 0.3, b.z); }
    if (!pos.length) return null;
    const m = new LineSegments2(new LineSegmentsGeometry().setPositions(pos), new LineMaterial({ color: 0xfbbf24, linewidth: 5, depthTest: false, transparent: true }));
    m.material.resolution.set(w(), h()); m.renderOrder = 10;
    scene.add(m);
    return m;
  };
  let overlay = null;
  const captions = new Map();

  const api = {
    mode,
    select: (id) => select(id),
    flyTo(id) {
      const e = byId.get(id);
      if (!e) return false;
      const b = new THREE.Box3().setFromObject(e.proxy), c = b.getCenter(new THREE.Vector3()), r = Math.max(6, b.getSize(new THREE.Vector3()).length() * 1.4);
      const dir = camera.position.clone().sub(controls.target).normalize(), tp = c.clone().add(dir.multiplyScalar(r));
      tp.y = Math.max(tp.y, c.y + r * 0.35);
      if (reduced) { controls.target.copy(c); camera.position.copy(tp); invalidate(); } else fly = { t0: performance.now(), ms: 700, ft: controls.target.clone(), fp: camera.position.clone(), tt: c, tp };
      select(e.item.id, { silent: true });
      return true;
    },
    // Fit the camera to a set of items (an explicit request, like flyTo).
    frame(ids = []) {
      const box = new THREE.Box3();
      for (const id of ids) { const e = byId.get(id); if (e) box.expandByObject(e.proxy); }
      if (box.isEmpty()) return false;
      const c = box.getCenter(new THREE.Vector3()), r = Math.max(20, box.getSize(new THREE.Vector3()).length() * 0.75);
      const dir = camera.position.clone().sub(controls.target).normalize(), tp = c.clone().add(dir.multiplyScalar(r / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.6));
      tp.y = Math.max(tp.y, c.y + r * 0.5);
      if (reduced) { controls.target.copy(c); camera.position.copy(tp); invalidate(); } else fly = { t0: performance.now(), ms: 700, ft: controls.target.clone(), fp: camera.position.clone(), tt: c, tp };
      return true;
    },
    // Highlight a set (e.g. an upstream walk); dim fades everything else in blueprint mode.
    highlight(ids = [], { dim = false } = {}) {
      while (highlights.length) { const h2 = highlights.pop(); scene.remove(h2); h2.dispose(); }
      if (overlay) { scene.remove(overlay); overlay.geometry.dispose(); overlay.material.dispose(); overlay = null; }
      for (const id of ids) { const e = byId.get(id); if (e) highlights.push(boxFor(e, 0xfbbf24)); }
      overlay = ids.length ? overlayFor(ids) : null;
      api.dimmed = dim && ids.length > 0;
      if (api.dimmed && api.mode !== "blueprint") api.setMode("blueprint");
      if (bp) for (const m of [bp.edgeLines.material, bp.proc.material, bp.util.material, bp.arrowMesh.material]) m.opacity = api.dimmed ? 0.22 : m === bp.edgeLines.material ? 0.9 : 1;
      invalidate();
    },
    // A CSS2D caption on an item (null text removes it; caption(null) clears all).
    caption(id, text) {
      if (id == null) { for (const c of captions.values()) { scene.remove(c); c.element.remove(); } captions.clear(); invalidate(); return; }
      const old = captions.get(id);
      if (old) { scene.remove(old); old.element.remove(); captions.delete(id); }
      const e = byId.get(id);
      if (!e || !text) { invalidate(); return; }
      const el = document.createElement("div");
      el.className = "plabel cap"; el.textContent = text;
      const c = new CSS2DObject(el), b = new THREE.Box3().setFromObject(e.proxy);
      c.position.set((b.min.x + b.max.x) / 2, b.max.y + 4, (b.min.z + b.max.z) / 2);
      scene.add(c); captions.set(id, c);
      invalidate();
    },
    setMode(m) {
      if (m !== "physical" && m !== "blueprint") return api.mode;
      if (m === api.mode) return m;
      if (m === "blueprint" && !bp) bp = buildBlueprint();
      if (!reduced) fade = { from: api.mode, to: m, t0: performance.now() };
      else applyMode(m);
      api.mode = m;
      invalidate();
      return m;
    },
    // Blueprint toggles: xray (see through solids) and skeletal (process lines, footprints and labels only).
    setOption(name, on) { if (name in bpOpts) { bpOpts[name] = !!on; applyMode(api.mode); invalidate(); } return { ...bpOpts }; },
    // Client coordinates of an item's centre, for tests and tours.
    screenOf(id) {
      const e = byId.get(id);
      if (!e) return null;
      const v = new THREE.Box3().setFromObject(e.proxy).getCenter(new THREE.Vector3()).project(camera), r = renderer.domElement.getBoundingClientRect();
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    },
    // map: id (machine Position or plant id, or sample point id) -> {state?, alerts?, reading?}
    setStates(map = {}) {
      for (const [id, v] of Object.entries(map)) {
        const e = byId.get(id);
        if (e && e.kind === "machine") { Object.assign(e.item, v); paintMachine(e.item); setRake(e.item); }
        const sp = data.samplePoints.find((s) => s.id === id);
        if (sp && v.reading) { sp.reading = v.reading; tint(sp); }
      }
      mPlinth.instanceColor && (mPlinth.instanceColor.needsUpdate = true);
      mLight.instanceColor && (mLight.instanceColor.needsUpdate = true);
      invalidate();
    },
    dispose() {
      cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
      for (const p of proxies) p.geometry.dispose();
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); for (const m of [].concat(o.material || [])) { for (const k of ["map", "normalMap"]) m[k]?.dispose?.(); m.dispose(); } });
      for (const t of Object.values(tex)) t.dispose();
      quad.geometry.dispose(); quad.material.dispose(); rtA?.dispose(); rtB?.dispose();
      envRT.dispose(); pmrem.dispose(); envSky.geometry.dispose(); envSky.material.dispose();
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); labels.domElement.remove();
      delete window.__plant;
    }
  };
  return api;
}

// WebGL is usable here: no context means the caller shows the SVG plan instead (design §5.4).
export function webglAvailable() {
  try { const c = document.createElement("canvas"); return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl"))); } catch { return false; }
}
