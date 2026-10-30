// GeometryRefs: one per mesh node in riverbend.glb, linked to the graph object that owns it (Riverbend Atlas, Task 2).
import { PLAN } from "../layout.mjs";
import { currentPlantModel, plantId } from "../plant.mjs";

const r3 = (x) => Math.round(x * 1000) / 1000;

export function geometryRefs(sceneMeta, ont, contract) {
  const objects = sceneMeta.objects, model = currentPlantModel(ont);
  const positions = new Map(ont.list("Position").map((p) => [p.tag, p.id]));
  // a scene asset key is owned by its Position, else by its Structure in the released plant model
  const ownerOf = (asset) => {
    if (positions.has(asset)) return positions.get(asset);
    const s = model && PLAN[asset] && plantId(model.id, "structure", PLAN[asset].tag);
    return s && ont.get(s) ? s : null;
  };
  const refs = [], links = [], skippedObjects = [], byOwner = new Map(), sceneTag = new Map();
  for (const node of Object.keys(objects).sort()) {
    const o = objects[node], owner = ownerOf(o.asset);
    if (!owner) { skippedObjects.push(node); continue; }
    const { cx, cy, w, l, zMin, zMax } = o.site, id = `GEO-${node}`;
    refs.push({ id, type: "GeometryRef", file: "riverbend.glb", node, floor: o.floor, centroid: [cx, cy, r3((zMin + zMax) / 2)], bbox: { w, l, h: r3(zMax - zMin) } });
    links.push([owner, "HAS_GEOMETRY", id]);
    (byOwner.get(owner) || byOwner.set(owner, []).get(owner)).push(id);
    if (o.tag) sceneTag.set(o.tag, id);
  }
  // a sensor sits on the mesh that carries its tag, else the mesh named for its owner, else the first mesh of the owner
  const pick = (owner, tag) => {
    const ids = byOwner.get(owner);
    if (!ids) return null;
    return (sceneTag.has(tag) && ids.includes(sceneTag.get(tag)) && sceneTag.get(tag)) || ids.find((i) => objects[i.slice(4)].asset === i.slice(4)) || ids[0];
  };
  // the structure a sensor's sample point sits on, or for a line sample the structure upstream (where the sample is drawn)
  const spStructure = new Map(ont.list("SamplePoint", (p) => p.sensorId).map((p) => [p.sensorId, p.structureId || ont.get(p.lineId)?.fromId]));
  // a structure's meshes hang off it, or off the Position it contains
  const onStructure = (sid, tag) => pick(sid, tag) || pick(ont.get(sid)?.positionId, tag);
  const anchors = new Map(), skippedSensors = [];
  for (const s of ont.list("Sensor")) {
    const pos = s.assetId && ont.get(s.assetId)?.positionId;
    const ctr = contract.tags?.[s.tag]?.asset;
    // shortcut: picks the first structure with geometry in the zone, so AIT-301 (clarified turbidity) pins to DB-1 approximately; upgrade when process units link to their structures.
    // Contract-tagged sensors only: the contract names an asset the scene does not model (SRC, DP-2, AIT-301).
    const inZone = () => ctr && Object.keys(PLAN).filter((k) => PLAN[k].zoneId === s.zoneId).map((k) => pick(ownerOf(k), s.tag)).find(Boolean);
    const geometryId = pick(pos, s.tag) || (ctr && pick(ownerOf(ctr), s.tag)) || onStructure(spStructure.get(s.id), s.tag) || inZone();
    if (geometryId) anchors.set(s.id, { geometryId, offset: [0, 0, 0] }); else skippedSensors.push(s.id);
  }
  return { refs, links, anchors, skippedObjects, skippedSensors };
}
