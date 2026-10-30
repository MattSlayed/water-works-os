// One Historian tag per ontology Sensor: n = ISA tag, with the sensor id kept for the backfill loop.
export function historianTags(ont) {
  return ont.list("Sensor").map((s) => ({
    n: s.tag, d: s.name, u: { 1: s.unit },
    fl: { Site: "Riverbend WTW", Asset: (s.assetId && ont.get(s.assetId)?.positionTag) || s.processUnitId || s.assetId, Source: "synthetic" },
    t: "System.Double", sensorId: s.id
  }));
}
