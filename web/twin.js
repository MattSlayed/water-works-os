// Asset twin: builds a template 3D model from the asset model's parts (geom + explode), with select, explode,
// isolate, locate and an agent "look here" highlight. Parts bind by id, never by mesh name.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const GROUP_COLOR = { base: 0x475569, drive: 0x3b82f6, rotor: 0x7e98ba, wet: 0xb45309, air: 0x15803d };
const SELECT = 0x60a5fa, LOOK = 0xa78bfa;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

export function mountTwin(container, parts, { onSelect } = {}) {
  const w = () => container.clientWidth || 600, h = () => container.clientHeight || 400;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.setSize(w(), h());
  container.prepend(renderer.domElement);
  renderer.domElement.setAttribute("aria-label", "3D asset model. Click a part to select it.");
  renderer.domElement.setAttribute("role", "img");

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, w() / h(), 0.05, 100);
  camera.position.set(3.6, 2.6, 4.6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.45, 0);
  controls.enableDamping = !reduced;
  scene.add(new THREE.HemisphereLight(0xe8eef6, 0x0a172a, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.3);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const grid = new THREE.GridHelper(6, 24, 0x2563eb, 0x152c4a);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

  // Centre the asset on its parts' bounding box.
  const xs = parts.map((p) => p.geom.pos[0]), zs = parts.map((p) => p.geom.pos[2]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const meshes = new Map();
  for (const p of parts) {
    const g = p.geom;
    let geo;
    if (g.shape === "box") geo = new THREE.BoxGeometry(...g.size);
    else {
      geo = new THREE.CylinderGeometry(g.r, g.r, g.len, 40);
      if (g.axis === "x") geo.rotateZ(Math.PI / 2);
      if (g.axis === "z") geo.rotateX(Math.PI / 2);
    }
    const mat = new THREE.MeshStandardMaterial({ color: GROUP_COLOR[p.group] ?? 0x7e98ba, metalness: 0.35, roughness: 0.55, transparent: true });
    const m = new THREE.Mesh(geo, mat);
    m.userData = { id: p.id, base: new THREE.Vector3(g.pos[0] - cx, g.pos[1], g.pos[2] - cz), dir: new THREE.Vector3(...p.explode.dir), dist: p.explode.dist };
    m.position.copy(m.userData.base);
    meshes.set(p.id, m);
    scene.add(m);
  }

  let explode = 0, selected = null, look = new Set(), isolated = null;
  const paint = () => {
    for (const [id, m] of meshes) {
      const on = id === selected, lk = look.has(id);
      m.material.emissive.setHex(on ? SELECT : lk ? LOOK : 0x000000);
      m.material.emissiveIntensity = on ? 0.55 : lk ? 0.45 : 0;
      m.visible = !isolated || isolated === id;
      m.material.opacity = selected && !on && !lk ? 0.55 : 1;
    }
  };
  const place = () => { for (const m of meshes.values()) m.position.copy(m.userData.base).addScaledVector(m.userData.dir, m.userData.dist * explode); };

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  renderer.domElement.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; // a drag orbits; only a click selects
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...meshes.values()].filter((m) => m.visible))[0];
    if (hit) api.select(hit.object.userData.id, true);
  });

  const onResize = () => { camera.aspect = w() / h(); camera.updateProjectionMatrix(); renderer.setSize(w(), h()); };
  const ro = new ResizeObserver(onResize);
  ro.observe(container);
  let raf;
  const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
  loop();

  const api = {
    setExplode(t) { explode = Math.max(0, Math.min(1, t)); place(); },
    select(id, fromClick) { selected = meshes.has(id) ? id : null; paint(); if (fromClick && onSelect) onSelect(selected); },
    isolate(id) { isolated = id && meshes.has(id) ? id : null; paint(); },
    highlight(ids) { look = new Set((ids || []).filter((i) => meshes.has(i))); paint(); },
    locate(id) {
      const m = meshes.get(id);
      if (!m) return;
      const target = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
      controls.target.copy(target);
      camera.position.copy(target).add(new THREE.Vector3(1.2, 0.8, 1.6));
      api.select(id);
    },
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); renderer.domElement.remove(); }
  };
  paint();
  return api;
}
