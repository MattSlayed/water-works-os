"""Export site-frame footprints of every mesh with an `asset` custom property.

Run: blender -b <file.blend> --python export_scene.py -- <out.json>
Site frame: rotate +ROT_DEG about Z, negate y, subtract (dx, dy); z shifted by LEVEL_SHIFT.
Only the transformed values are written (no raw Blender coordinates).
"""
import json
import math
import sys

import bpy
from mathutils import Matrix

ROT_DEG = 21.2
LEVEL_SHIFT = 1450
MARGIN = 10.0

out_path = sys.argv[sys.argv.index("--") + 1]
r2 = lambda v: round(v, 2) + 0.0  # + 0.0 turns -0.0 into 0.0

rot = Matrix.Rotation(math.radians(ROT_DEG), 4, "Z")
flip = Matrix.Diagonal((1, -1, 1, 1))
to_site = flip @ rot

dg = bpy.context.evaluated_depsgraph_get()
found = []  # (obj, [site-frame-before-offset points])
for o in bpy.data.objects:
    if o.type != "MESH" or "asset" not in o.keys():
        continue
    eo = o.evaluated_get(dg)
    me = eo.to_mesh()
    pts = [to_site @ (o.matrix_world @ v.co) for v in me.vertices]
    eo.to_mesh_clear()
    if pts:
        found.append((o, pts))

dx = r2(min(p.x for _, ps in found for p in ps) - MARGIN)
dy = r2(min(p.y for _, ps in found for p in ps) - MARGIN)

objects = {}
for o, ps in found:
    xs, ys, zs = [p.x - dx for p in ps], [p.y - dy for p in ps], [p.z + LEVEL_SHIFT for p in ps]
    rec = {k: str(o[k]) for k in ("asset", "floor", "tag") if k in o.keys()}
    rec["collection"] = o.users_collection[0].name
    rec["site"] = {
        "cx": r2((min(xs) + max(xs)) / 2), "cy": r2((min(ys) + max(ys)) / 2),
        "w": r2(max(xs) - min(xs)), "l": r2(max(ys) - min(ys)),
        "zMin": r2(min(zs)), "zMax": r2(max(zs)),
    }
    objects[o.name] = rec

doc = {"frame": {"rotDeg": ROT_DEG, "flipY": True, "dx": dx, "dy": dy, "levelShift": LEVEL_SHIFT}, "objects": objects}
with open(out_path, "w", encoding="utf-8", newline="") as f:
    f.write(json.dumps(doc, indent=1, sort_keys=True) + "\n")
print(f"EXPORTED {len(objects)} objects dx={dx} dy={dy}")
