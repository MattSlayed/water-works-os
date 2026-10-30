"""Export the scene-meta objects to a GLB with their `asset`/`floor` custom properties as node extras.

Run: blender -b <file.blend> --python export_glb.py -- <scene-meta.json> <out.glb>
Coordinates stay in the Blender frame (the overlay applies scene-meta.frame). The blend is never saved.
"""
import json
import sys

import bpy

meta_path, out_path = sys.argv[sys.argv.index("--") + 1:][:2]
with open(meta_path, encoding="utf-8") as f:
    names = set(json.load(f)["objects"])

bpy.ops.object.select_all(action="DESELECT")
picked = 0
for o in bpy.data.objects:
    if o.name in names and o.type == "MESH":
        o.hide_set(False)  # hidden objects cannot be selected
        o.hide_viewport = False
        o.select_set(True)
        picked += 1
assert picked == len(names), f"selected {picked} of {len(names)} scene-meta objects"

bpy.ops.export_scene.gltf(
    filepath=out_path, export_format="GLB", use_selection=True, export_extras=True,
    export_image_format="NONE", export_apply=True,
    export_yup=False,  # keep the Blender frame; the glTF default would swap to Y-up
)
print(f"EXPORTED {picked} objects to {out_path}")
