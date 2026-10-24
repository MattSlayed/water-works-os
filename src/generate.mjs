// Synthetic Riverbend Water Treatment Works (BRD Appendix B). Every name, tag and number is invented.
// generateWorks(seed) -> { objects, links, clock } — deterministic for a given seed.
import { createHash } from "node:crypto";
import { stepRequires } from "./functions.mjs";
import { ZONES, toLonLat } from "./layout.mjs";
import { makeScenes } from "./scenes.mjs";
import { REGION, REMOTE_ZONES, REMOTE_SITES, SITE_XY, PROJECTS, TRACKERS, zoneGeo, zoneAtLocal } from "./region.mjs";
import { AGENT_SPECS } from "./agents.mjs";
import { specFromManifest } from "./harness.mjs";
import { connectorId } from "./actions.mjs";

export const CLOCK = "2026-10-15T00:00:00Z";

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const prov = (source, uri) => ({ source, source_uri: uri, source_version: "v1", extracted_at: CLOCK, confidence: 1 });

// Zones: x,y,w,h in metres on the site plan. clearance = minimum viewer clearance.
// Zones come from the physical layout (src/layout.mjs).

const STAGES = [
  ["intake", "Z01", "Raw water intake"], ["inlet", "Z02", "Inlet works"], ["coag", "Z03", "Coagulation"],
  ["floc", "Z03", "Flocculation"], ["clar", "Z04", "Clarification"], ["filt", "Z05", "Filtration"],
  ["disinf", "Z06", "Disinfection"], ["storage", "Z07", "Clear water storage"], ["pumping", "Z07", "High-lift pumping"],
  ["sludge", "Z08", "Sludge handling"]
];

// Part templates. geom: shape box{size:[x,y,z]} | cyl{r,len,axis}; pos in metres relative to the asset origin.
const T = {
  centrifugal_pump: {
    label: "Horizontal split-case pump", make: "Hydrava", model: "HSC 350-500",
    parts: [
      ["Baseplate", 890, "base", "box", { size: [2.6, 0.15, 0.8] }, [0, 0.075, 0], [0, -1, 0], "S275 steel"],
      ["Motor", 800, "drive", "cyl", { r: 0.32, len: 0.9, axis: "x" }, [-0.75, 0.55, 0], [-1, 0, 0], "Cast iron frame"],
      ["Coupling", 840, "drive", "cyl", { r: 0.14, len: 0.16, axis: "x" }, [-0.18, 0.55, 0], [0, 1, 0], "Steel / elastomer"],
      ["Coupling guard", 681, "drive", "box", { size: [0.34, 0.36, 0.4] }, [-0.18, 0.55, 0], [0, 1.4, 0], "Galvanised mesh"],
      ["Bearing housing", 350, "rotor", "cyl", { r: 0.17, len: 0.5, axis: "x" }, [0.2, 0.55, 0], [0, 0.8, 0.6], "Cast iron GG25"],
      ["Drive-end bearing", 321, "rotor", "cyl", { r: 0.12, len: 0.06, axis: "x" }, [0.02, 0.55, 0], [0, 0.6, 1.0], "Chrome steel 6312"],
      ["Non-drive-end bearing", 321, "rotor", "cyl", { r: 0.11, len: 0.06, axis: "x" }, [0.38, 0.55, 0], [0, 0.6, 1.2], "Chrome steel 6310"],
      ["Shaft", 210, "rotor", "cyl", { r: 0.05, len: 1.2, axis: "x" }, [0.3, 0.55, 0], [0, 1.2, 0], "1.4021 stainless"],
      ["Shaft sleeve", 524, "rotor", "cyl", { r: 0.065, len: 0.18, axis: "x" }, [0.56, 0.55, 0], [0, 1.0, -0.6], "Hard-faced 1.4462"],
      ["Mechanical seal", 433, "wet", "cyl", { r: 0.1, len: 0.1, axis: "x" }, [0.62, 0.55, 0], [0.4, 0.8, -0.8], "SiC / carbon"],
      ["Seal cover", 161, "wet", "cyl", { r: 0.2, len: 0.06, axis: "x" }, [0.7, 0.55, 0], [0.6, 0, -1.0], "Cast iron"],
      ["Impeller", 230, "wet", "cyl", { r: 0.22, len: 0.1, axis: "x" }, [0.82, 0.55, 0], [1.0, 0, -0.4], "Duplex 1.4517"],
      ["Wear ring", 502, "wet", "cyl", { r: 0.15, len: 0.04, axis: "x" }, [0.9, 0.55, 0], [1.2, 0, 0.4], "Bronze CC491K"],
      ["Volute casing", 102, "wet", "cyl", { r: 0.36, len: 0.32, axis: "x" }, [0.88, 0.55, 0], [1.5, 0, 0], "Ductile iron GGG40"],
      ["Casing gasket", 400, "wet", "cyl", { r: 0.3, len: 0.01, axis: "x" }, [0.72, 0.55, 0], [0.9, -0.6, 0], "Aramid fibre"],
      ["Suction nozzle", 106, "wet", "cyl", { r: 0.14, len: 0.3, axis: "x" }, [1.2, 0.55, 0], [1.8, 0, 0], "Ductile iron"]
    ],
    bands: { "Bearing housing": ["DE bore diameter", 110.0, 110.035, "mm"], "Shaft sleeve": ["Sleeve OD", 64.97, 65.0, "mm"], "Wear ring": ["Diametral clearance", 0.4, 0.6, "mm"] },
    sensors: [["vib_de", "DE vibration", "mm/s", 0, 11, 4.5], ["temp_de", "DE bearing temperature", "°C", 0, 120, 85], ["current", "Motor current", "A", 0, 400, 330], ["flow", "Discharge flow", "ML/d", 0, 60, null]],
    faults: {
      "high DE vibration": ["Misalignment or soft foot under the motor feet", "DE bearing wear", "Impeller imbalance or damage", "Cavitation from low suction head"],
      "high bearing temperature": ["Over-greasing or wrong grease", "DE bearing wear", "Misalignment loading the bearing"]
    },
    steps: [
      ["Confirm the permit to work and the isolation are in place", false, ["Coupling guard"], "LOTO"],
      ["Record DE and NDE vibration and bearing temperature with the machine running", false, ["Bearing housing", "Drive-end bearing"], null],
      ["Check for soft foot at each motor foot with a feeler gauge (limit 0.05 mm)", true, ["Baseplate", "Motor"], "Rotating parts"],
      ["Remove the coupling guard and inspect the coupling elements", true, ["Coupling guard", "Coupling"], "Rotating parts"],
      ["Check shaft alignment with the laser tool (limit 0.05 mm offset)", true, ["Coupling", "Shaft"], null],
      ["Withdraw the back pull-out unit", true, ["Bearing housing", "Shaft", "Impeller"], "Heavy lift"],
      ["Measure the DE bearing housing bore against the band", true, ["Bearing housing"], null],
      ["Inspect the shaft sleeve for scoring and measure the OD", true, ["Shaft sleeve"], null],
      ["Inspect the mechanical seal faces", true, ["Mechanical seal"], null],
      ["Measure impeller to wear-ring clearance", true, ["Impeller", "Wear ring"], null],
      ["Reassemble, realign, run and record vibration", true, ["Shaft", "Coupling"], "Rotating parts"]
    ]
  },
  blower: {
    label: "Rotary lobe air-scour blower", make: "Aerowerk", model: "RL 125",
    parts: [
      ["Base frame", 890, "base", "box", { size: [1.8, 0.12, 0.9] }, [0, 0.06, 0], [0, -1, 0], "Steel"],
      ["Motor", 800, "drive", "cyl", { r: 0.25, len: 0.7, axis: "x" }, [-0.5, 0.5, 0], [-1, 0, 0], "Cast iron"],
      ["Belt drive", 870, "drive", "box", { size: [0.15, 0.6, 0.5] }, [-0.05, 0.6, 0.0], [0, 0, 1.2], "Rubber V-belts"],
      ["Belt guard", 681, "drive", "box", { size: [0.2, 0.7, 0.6] }, [-0.05, 0.6, 0.0], [0, 1.3, 1.2], "Steel"],
      ["Rotor casing", 102, "rotor", "box", { size: [0.6, 0.5, 0.5] }, [0.45, 0.5, 0], [0, 1.0, 0], "Cast iron"],
      ["Lobe rotors", 230, "rotor", "cyl", { r: 0.15, len: 0.45, axis: "x" }, [0.45, 0.5, 0], [0.9, 0.9, 0], "Ductile iron"],
      ["Bearings", 321, "rotor", "cyl", { r: 0.08, len: 0.06, axis: "x" }, [0.8, 0.5, 0], [1.2, 0.4, 0.6], "Chrome steel"],
      ["Inlet filter silencer", 750, "air", "cyl", { r: 0.18, len: 0.4, axis: "y" }, [0.45, 1.0, 0], [0, 1.6, 0], "Steel / polyester"],
      ["Pressure relief valve", 745, "air", "cyl", { r: 0.06, len: 0.2, axis: "y" }, [0.85, 0.85, 0.2], [0.6, 1.2, 0.6], "Brass"]
    ],
    bands: { "Belt drive": ["Belt deflection", 8, 12, "mm"] },
    sensors: [["vib", "Casing vibration", "mm/s", 0, 11, 6], ["temp_dis", "Discharge temperature", "°C", 0, 140, 110], ["press", "Discharge pressure", "kPa", 0, 80, 70]],
    faults: { "high vibration": ["Belt misalignment or wear", "Bearing wear", "Rotor contact"], "high discharge temperature": ["Blocked inlet filter", "High back-pressure"] },
    steps: [
      ["Confirm the permit to work and the isolation are in place", false, ["Belt guard"], "LOTO"],
      ["Inspect the inlet filter and record pressure drop", false, ["Inlet filter silencer"], null],
      ["Remove the belt guard and check belt tension and alignment", true, ["Belt guard", "Belt drive"], "Rotating parts"],
      ["Check bearing condition and lubrication", true, ["Bearings"], null]
    ]
  },
  dosing_pump: {
    label: "Diaphragm dosing pump", make: "Dosatec", model: "DM 400",
    parts: [
      ["Skid frame", 890, "base", "box", { size: [1.2, 0.1, 0.6] }, [0, 0.05, 0], [0, -1, 0], "316 stainless"],
      ["Motor", 800, "drive", "cyl", { r: 0.12, len: 0.35, axis: "x" }, [-0.35, 0.3, 0], [-1, 0, 0], "Aluminium"],
      ["Gearbox", 870, "drive", "box", { size: [0.25, 0.25, 0.25] }, [-0.05, 0.3, 0], [0, 1, 0], "Cast iron"],
      ["Stroke adjuster", 960, "drive", "cyl", { r: 0.05, len: 0.15, axis: "y" }, [-0.05, 0.5, 0], [0, 1.4, 0], "Steel"],
      ["Diaphragm", 450, "wet", "cyl", { r: 0.12, len: 0.03, axis: "x" }, [0.15, 0.3, 0], [0.8, 0.4, 0], "PTFE-faced EPDM"],
      ["Dosing head", 102, "wet", "cyl", { r: 0.13, len: 0.12, axis: "x" }, [0.24, 0.3, 0], [1.2, 0, 0], "PVDF"],
      ["Suction check valve", 742, "wet", "cyl", { r: 0.03, len: 0.1, axis: "y" }, [0.24, 0.12, 0], [1.2, -0.6, 0.4], "PVDF / ceramic ball"],
      ["Discharge check valve", 742, "wet", "cyl", { r: 0.03, len: 0.1, axis: "y" }, [0.24, 0.48, 0], [1.2, 0.8, 0.4], "PVDF / ceramic ball"],
      ["Pulsation damper", 690, "wet", "cyl", { r: 0.07, len: 0.25, axis: "y" }, [0.45, 0.45, 0], [1.4, 1.0, 0], "PVDF"]
    ],
    bands: { "Diaphragm": ["Service life", 0, 8000, "h"] },
    sensors: [["flow", "Dose flow", "L/h", 0, 400, null], ["press", "Discharge pressure", "bar", 0, 10, 8], ["stroke", "Stroke length", "%", 0, 100, null]],
    faults: { "low dose flow": ["Air in the suction line or loss of prime", "Worn check valve balls or seats", "Diaphragm failure"] },
    steps: [
      ["Confirm the permit to work and the isolation are in place", false, ["Dosing head"], "Chemical"],
      ["Check suction line for air and the calibration column draw-down", false, ["Suction check valve"], "Chemical"],
      ["Flush the dosing head and remove the check valves", true, ["Suction check valve", "Discharge check valve"], "Chemical"],
      ["Replace the diaphragm and record running hours", true, ["Diaphragm"], "Chemical"]
    ]
  },
  clarifier_drive: {
    label: "Clarifier scraper drive", make: "Sedimax", model: "CD 30",
    parts: [
      ["Drive platform", 890, "base", "box", { size: [1.6, 0.1, 1.6] }, [0, 0.05, 0], [0, -1, 0], "Steel"],
      ["Motor", 800, "drive", "cyl", { r: 0.14, len: 0.4, axis: "x" }, [-0.5, 0.35, 0], [-1, 0, 0], "Aluminium"],
      ["Worm gearbox", 870, "drive", "box", { size: [0.4, 0.35, 0.35] }, [-0.1, 0.35, 0], [0, 1, 0], "Cast iron"],
      ["Torque limiter", 845, "drive", "cyl", { r: 0.1, len: 0.12, axis: "x" }, [0.2, 0.35, 0], [0.6, 1, 0], "Steel"],
      ["Slewing ring", 321, "rotor", "cyl", { r: 0.5, len: 0.12, axis: "y" }, [0.3, 0.25, 0], [0, 0.6, 1], "Steel"],
      ["Centre column", 210, "rotor", "cyl", { r: 0.12, len: 1.2, axis: "y" }, [0.3, -0.5, 0], [0, -1.2, 0], "Steel"]
    ],
    bands: {},
    sensors: [["torque", "Drive torque", "%", 0, 120, 90], ["current", "Motor current", "A", 0, 20, 16], ["temp", "Gearbox temperature", "°C", 0, 110, 85]],
    faults: { "high torque": ["Sludge blanket too high", "Obstruction on the scraper", "Slewing ring wear"] },
    steps: [
      ["Confirm the permit to work and the isolation are in place", false, ["Torque limiter"], "LOTO"],
      ["Check sludge blanket level and torque trend", false, ["Torque limiter"], null],
      ["Inspect gearbox oil and slewing ring", true, ["Worm gearbox", "Slewing ring"], "Confined space"]
    ]
  }
};

// [tag, template, zone, kks, stage, hero, label]
const ASSETS = [
  ["RWP-A", "centrifugal_pump", "Z01", "10PAC10AP001", "intake", true, "Raw-water pump A"],
  ["RWP-B", "centrifugal_pump", "Z01", "10PAC10AP002", "intake", true, "Raw-water pump B"],
  ["RWP-C", "centrifugal_pump", "Z01", "10PAC10AP003", "intake", true, "Raw-water pump C"],
  ["DP-1", "dosing_pump", "Z03", "13QCA10AP001", "coag", true, "Coagulant dosing pump 1"],
  ["DP-2", "dosing_pump", "Z03", "13QCA10AP002", "coag", true, "Coagulant dosing pump 2"],
  ["CL-1", "clarifier_drive", "Z04", "14HTE10AM001", "clar", true, "Clarifier 1 drive"],
  ["CL-2", "clarifier_drive", "Z04", "14HTE20AM001", "clar", true, "Clarifier 2 drive"],
  ["CL-3", "clarifier_drive", "Z04", "14HTE30AM001", "clar", true, "Clarifier 3 drive"],
  ["CL-4", "clarifier_drive", "Z04", "14HTE40AM001", "clar", true, "Clarifier 4 drive"],
  ["BWP-A", "centrifugal_pump", "Z05", "15PAC10AP001", "filt", true, "Backwash pump A"],
  ["BWP-B", "centrifugal_pump", "Z05", "15PAC10AP002", "filt", true, "Backwash pump B"],
  ["BLW-A", "blower", "Z05", "15QAA10AN001", "filt", true, "Air-scour blower A"],
  ["BLW-B", "blower", "Z05", "15QAA10AN002", "filt", true, "Air-scour blower B"],
  ["CHL-A", "dosing_pump", "Z06", "16QCB10AP001", "disinf", true, "Chlorinator A"],
  ["CHL-B", "dosing_pump", "Z06", "16QCB10AP002", "disinf", true, "Chlorinator B"],
  ["HLP-A", "centrifugal_pump", "Z07", "20PAC10AP001", "pumping", true, "High-lift pump A"],
  ["HLP-B", "centrifugal_pump", "Z07", "20PAC10AP002", "pumping", true, "High-lift pump B"],
  ["HLP-C", "centrifugal_pump", "Z07", "20PAC10AP003", "pumping", true, "High-lift pump C"],
  ["HLP-D", "centrifugal_pump", "Z07", "20PAC10AP004", "pumping", true, "High-lift pump D"],
  ["SLP-A", "centrifugal_pump", "Z08", "17PAC10AP001", "sludge", false, "Sludge pump A"],
  ["GEN-1", null, "Z10", "30XKA10", null, false, "Standby generator"]
];

const FIRST = ["Thandi", "Sipho", "Lerato", "Johan", "Aisha", "Pieter", "Nomsa", "Kagiso", "Ruan", "Zanele", "Bongani", "Marelize", "Tshepo", "Ayanda", "Werner", "Palesa", "Musa", "Chantel", "Lwazi", "Refilwe", "Dineo", "Gift", "Yusuf", "Precious", "Andile", "Megan", "Themba", "Karabo", "Hendrik", "Naledi"];
const LAST = ["Dlamini", "Nkosi", "Botha", "Mokoena", "Naidoo", "van Wyk", "Khumalo", "Pillay", "Molefe", "Smit", "Zulu", "Jacobs", "Mahlangu", "Pretorius", "Ndlovu", "Ismail", "Sithole", "Venter", "Mthembu", "Coetzee"];

// [role, clearance, count, trade, shift?]
const ROLES = [
  ["works_manager", "manager", 1], ["reliability_engineer", "engineer", 2], ["planner", "supervisor", 1],
  ["lab_analyst", "operator", 3], ["shift_supervisor", "supervisor", 4, null, true], ["process_controller", "operator", 16, null, true],
  ["millwright", "technician", 4, "millwright"], ["fitter", "technician", 3, "fitter"], ["electrician", "technician", 3, "electrician"],
  ["instrument_technician", "technician", 2, "instrumentation"], ["safety_officer", "supervisor", 1], ["contractor", "technician", 2, "fitter"]
];

export function generateWorks(seed = 7) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const objects = [];
  const links = [];
  const add = (o, src = "SYNTH-ERP") => { o.prov = prov(src, `synth://${src.toLowerCase()}/${o.id}`); objects.push(o); return o; };
  const link = (from, rel, to, props) => links.push({ from, rel, to, ...(props ? { props } : {}), prov: prov("SYNTH", `synth://link/${from}/${rel}/${to}`) });

  add({ id: "SITE-RB", type: "Site", name: "Riverbend Water Treatment Works", capacityMlD: 120, works: "potable", note: "Synthetic site" }, "CONFIG");

  for (const [id, name, x, y, w, h, clearance, hazard] of ZONES) {
    add({ id, type: "Zone", code: id, name, clearance, hazard, rect: [x, y, w, h] }, "SYNTH-GIS");
    link("SITE-RB", "HAS_ZONE", id);
  }
  // The region (Region design §4.1): bulk-line zones carry several rects in site metres, and Region geometry in WGS84.
  for (const [id, name, clearance, hazard, rects] of REMOTE_ZONES) {
    add({ id, type: "Zone", code: id, name, clearance, hazard, remote: true, rects, geo: zoneGeo(rects) }, "SYNTH-GIS");
    link("SITE-RB", "HAS_ZONE", id);
  }
  for (const r of REGION) add({ id: r.id, type: "Region", kind: r.kind, name: r.name, geometry: r.geometry, zoneId: null }, "SYNTH-GIS");
  for (const [id, kind, name, capacityMl, sensors] of REMOTE_SITES) {
    const [lon, lat] = toLonLat(SITE_XY[id]), zoneId = zoneAtLocal(SITE_XY[id], ZONES), k = id.slice(3);
    add({ id, type: "RemoteSite", kind, name, lat, lon, zoneId, ...(capacityMl ? { capacityMl } : {}) }, "SYNTH-GIS");
    link(zoneId, "CONTAINS", id);
    for (const [key, sname, unit, alarmLo, alarmHi, sz] of sensors) {
      const sid = `SEN-${k}-${key}`;
      add({ id: sid, type: "Sensor", processUnitId: id, zoneId: sz || zoneId, key, name: `${name.split(" ")[0]} ${sname.toLowerCase()}`, unit, alarmLo, alarmHi, historianTag: `BULK.${k}.${key.toUpperCase()}` }, "SYNTH-HIST");
      link(sid, "MEASURES", id);
    }
  }

  STAGES.forEach(([stage, zoneId, name], i) => {
    const id = `PU-${stage}`;
    add({ id, type: "ProcessUnit", stage, name, zoneId, order: i }, "CONFIG");
    link(zoneId, "CONTAINS", id);
    if (i > 0 && stage !== "sludge") link(`PU-${STAGES[i - 1][0]}`, "FEEDS", id);
  });
  link("PU-clar", "FEEDS", "PU-sludge");

  // Positions, assets, parts, sensors, documents, procedure steps
  let stockNo = 4100;
  const docsByTemplate = {};
  for (const [tpl, t] of Object.entries(T)) {
    const docId = `DOC-SOP-${tpl.toUpperCase()}`;
    docsByTemplate[tpl] = docId;
    add({ id: docId, type: "Document", kind: "SOP", title: `${t.label}: inspection and overhaul`, revision: "C", template: tpl, sourceRef: { system: "sharepoint", url: `https://riverbend.sharepoint.example/sops/${tpl.toUpperCase()}.pdf`, revision: "C" }, sourceBehind: false }, "SYNTH-DOCS");
    add({ id: `DOC-OEM-${tpl.toUpperCase()}`, type: "Document", kind: "manual", title: `${t.make} ${t.model} operating and maintenance manual`, revision: "4", template: tpl, faultTree: t.faults }, "SYNTH-DOCS");
  }

  for (const [tag, tpl, zoneId, kks, stage, hero, label] of ASSETS) {
    const posId = `POS-${tag}`;
    add({ id: posId, type: "Position", tag, kks, name: label, zoneId, stage }, "SYNTH-ERP");
    if (stage) link(`PU-${stage}`, "HAS_POSITION", posId);
    else link(zoneId, "CONTAINS", posId);
    const serial = String(30000 + Math.floor(r() * 69999));
    const t = tpl ? T[tpl] : null;
    const assetId = `AST-${serial}`;
    const installed = `20${10 + Math.floor(r() * 14)}-0${1 + Math.floor(r() * 8)}-1${Math.floor(r() * 9)}`;
    add({
      id: assetId, type: "Asset", name: label, positionTag: tag, positionId: posId, zoneId, serial, template: tpl,
      assetClass: tag.startsWith("CHL") ? "Chlorinator" : t ? t.label : "Diesel generator", make: t ? t.make : "Genpro", model: t ? t.model : "G500", hero,
      criticality: tag.startsWith("HLP") || tag.startsWith("RWP") || tag.startsWith("CHL") ? "A" : "B",
      state: tag === "HLP-D" ? "standby" : tag === "RWP-C" ? "isolated" : "running", installed, runHours: Math.floor(8000 + r() * 40000)
    });
    link(assetId, "INSTALLED_AT", posId, { from: installed, to: null });
    if (!t) continue;
    link(docsByTemplate[tpl], "GOVERNS", assetId);
    link(`DOC-OEM-${tpl.toUpperCase()}`, "GOVERNS", assetId);
    t.parts.forEach(([name, din, group, shape, dims, pos, dir, material], i) => {
      const nn = String(i + 1).padStart(2, "0");
      const pid = `PRT-${tag}-${nn}`;
      const band = t.bands[name];
      add({
        id: pid, type: "Part", assetId, zoneId, name, din, group, material, qty: name === "Drive-end bearing" ? 1 : 1,
        erpNo: `STK-${stockNo + i}`, stock: name.includes("bearing") ? (tag === "HLP-B" ? 1 : 2) : Math.floor(r() * 4),
        geom: { shape, ...dims, pos }, explode: { dir, dist: 0.6 + i * 0.03, group, order: i },
        band: band ? { measure: band[0], lo: band[1], hi: band[2], unit: band[3] } : null
      });
      link(assetId, "HAS_PART", pid);
    });
    for (const [key, name, unit, lo, hi, alarm] of t.sensors) {
      const sid = `SEN-${tag}-${key}`;
      add({ id: sid, type: "Sensor", assetId, zoneId, key, name, unit, range: [lo, hi], alarmHi: alarm, historianTag: `${kks}.${key.toUpperCase()}` }, "SYNTH-HIST");
      link(sid, "MEASURES", assetId);
    }
  }
  stockNo += 100;

  // Digitised SOPs: one released Procedure per template (SOP revision C = version 3), steps bound to parts by name.
  for (const [tpl, t] of Object.entries(T)) {
    const id = `PRC-${tpl.toUpperCase()}-v3`;
    const steps = t.steps.map(([text, intrusive, partNames, hazard], i) => {
      const bandOf = (n) => t.bands[n] && { measure: t.bands[n][0], unit: t.bands[n][3] };
      return {
        id: `${id}-S${String(i + 1).padStart(2, "0")}`, step: i + 1, text, intrusive, partNames, hazard, documentId: docsByTemplate[tpl],
        requires: stepRequires(text, intrusive, partNames, bandOf),
        expectedMinutes: hazard === "Heavy lift" ? 45 : intrusive ? 25 : 10
      };
    });
    add({ id, type: "Procedure", template: tpl, documentId: docsByTemplate[tpl], title: `${t.label}: inspection and overhaul`, version: 3, state: "released", steps, releasedBy: "P-001", releasedAt: "2025-02-01T00:00:00Z", reason: "Converted from SOP revision C" }, "SYNTH-DOCS");
    link(id, "PART_OF", docsByTemplate[tpl]);
  }
  // The raw-water sample point at the intake jetty and its one-step round (Region design §5.4): Geo Watch's sampling
  // rounds run on the existing job machinery, so the reading needs a part and a released procedure.
  {
    add({ id: "AST-SMP-RAW", type: "Asset", name: "Raw-water sample point (intake jetty)", template: "raw_sampling", assetClass: "Sample point", zoneId: "Z01", hero: false, criticality: "C", state: "in service" }, "SYNTH-ERP");
    add({ id: "PRT-SMP-RAW-01", type: "Part", assetId: "AST-SMP-RAW", name: "Grab sample", band: null }, "SYNTH-ERP");
    link("AST-SMP-RAW", "HAS_PART", "PRT-SMP-RAW-01");
    const step = { id: "PRC-RAW_SAMPLING-v1-S01", step: 1, text: "Take a raw-water grab sample at the intake jetty and measure its turbidity", intrusive: false, partNames: ["Grab sample"], hazard: "Working near water", documentId: null,
      requires: { permit: false, isolation: false, reading: { measure: "turbidity", unit: "NTU", partName: "Grab sample" } }, expectedMinutes: 20 };
    add({ id: "PRC-RAW_SAMPLING-v1", type: "Procedure", template: "raw_sampling", documentId: null, title: "Raw-water grab sample", version: 1, state: "released", steps: [step], releasedBy: "P-001", releasedAt: "2025-02-01T00:00:00Z", reason: "Raw-water sampling round (Region design §5.4)" }, "SYNTH-DOCS");
  }

  // Filters and process sensors
  for (let f = 1; f <= 12; f++) {
    const tag = `F${String(f).padStart(2, "0")}`;
    add({ id: `POS-${tag}`, type: "Position", tag, kks: `15HFA${String(f).padStart(2, "0")}`, name: `Rapid gravity filter ${f}`, zoneId: "Z05", stage: "filt" });
    link("PU-filt", "HAS_POSITION", `POS-${tag}`);
    add({ id: `AST-FLT-${tag}`, type: "Asset", name: `Filter ${tag}`, positionTag: tag, positionId: `POS-${tag}`, zoneId: "Z05", assetClass: "Rapid gravity filter", hero: false, criticality: "B", state: "running", runHoursSinceBackwash: 20 + f });
    link(`AST-FLT-${tag}`, "INSTALLED_AT", `POS-${tag}`, { from: "2008-04-01", to: null });
    for (const [key, name, unit, alarm] of [["turb", "Filtered turbidity", "NTU", 0.5], ["headloss", "Head loss", "m", 2.2]]) {
      add({ id: `SEN-${tag}-${key}`, type: "Sensor", assetId: `AST-FLT-${tag}`, zoneId: "Z05", key, name, unit, range: [0, key === "turb" ? 5 : 3], alarmHi: alarm, historianTag: `15HFA${String(f).padStart(2, "0")}.${key.toUpperCase()}` }, "SYNTH-HIST");
      link(`SEN-${tag}-${key}`, "MEASURES", `AST-FLT-${tag}`);
    }
  }
  for (const [id, puId, zoneId, name, unit, lo, hi, alarmLo, alarmHi] of [
    ["SEN-RAW-turb", "PU-intake", "Z01", "Raw-water turbidity", "NTU", 0, 400, null, 200],
    ["SEN-RAW-flow", "PU-inlet", "Z02", "Inlet flow", "ML/d", 0, 140, null, 130],
    ["SEN-FW-turb", "PU-filt", "Z05", "Combined filtered turbidity", "NTU", 0, 5, null, 1.0],
    ["SEN-FIN-cl", "PU-disinf", "Z06", "Final chlorine residual", "mg/L", 0, 3, 0.3, 2.0],
    ["SEN-FIN-ph", "PU-disinf", "Z06", "Final pH", "pH", 5, 10, 6.5, 9.5],
    ["SEN-CWR1-level", "PU-storage", "Z07", "Clear-water reservoir 1 level", "%", 0, 100, 30, null],
    ["SEN-CWR2-level", "PU-storage", "Z07", "Clear-water reservoir 2 level", "%", 0, 100, 30, null],
    ["SEN-OUT-flow", "PU-pumping", "Z07", "Outgoing flow", "ML/d", 0, 140, null, null]
  ]) {
    add({ id, type: "Sensor", processUnitId: puId, zoneId, key: id.split("-").pop(), name, unit, range: [lo, hi], alarmLo, alarmHi, historianTag: id.replace("SEN-", "PROC.") }, "SYNTH-HIST");
    link(id, "MEASURES", puId);
  }
  for (const [id, name, cap] of [["RES-CWR1", "Clear-water reservoir 1", 20], ["RES-CWR2", "Clear-water reservoir 2", 20]]) {
    add({ id, type: "Asset", name, assetClass: "Reservoir", zoneId: "Z07", capacityMl: cap, hero: false, criticality: "A", state: "in service", levelSensor: id === "RES-CWR1" ? "SEN-CWR1-level" : "SEN-CWR2-level" });
  }

  // Chemicals
  for (const [id, name, levelPct, reorderPct, zoneId, daysAtUse] of [
    ["CHEM-COAG", "Coagulant (polyaluminium chloride)", 34, 30, "Z09", 6], ["CHEM-LIME", "Hydrated lime", 61, 25, "Z09", 14],
    ["CHEM-POLY", "Polymer flocculant aid", 22, 25, "Z09", 3], ["CHEM-CL2", "Chlorine (1-tonne drums)", 45, 30, "Z06", 9]
  ]) add({ id, type: "Chemical", name, levelPct, reorderPct, zoneId, daysAtUse }, "SYNTH-HIST");

  // People and competencies
  let pn = 1;
  const people = [];
  for (const [role, clearance, count, trade, shifts] of ROLES) {
    for (let i = 0; i < count; i++) {
      const id = `P-${String(pn++).padStart(3, "0")}`;
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const shift = shifts ? "ABCD"[i % 4] : "DAY";
      const p = add({ id, type: "Person", name, role, clearance, trade: trade || null, shift, employer: role === "contractor" ? "Synthetic Contractor (Pty) Ltd" : "Riverbend Works" }, "SYNTH-HR");
      people.push(p);
    }
  }
  let cn = 1;
  const comp = (personId, type, level, validTo, extra = {}) => {
    const id = `CMP-${String(cn++).padStart(3, "0")}`;
    add({ id, type: "Competency", personId, competency: type, level, validFrom: "2023-01-01", validTo, ...extra }, "SYNTH-HR");
    link(personId, "HOLDS", id);
  };
  const millwrights = people.filter((p) => p.role === "millwright");
  for (const p of people) {
    if (p.trade) {
      // first millwright: level 3 valid (the J4 artisan); second: level 3 lapsed; others level 2
      const isLead = p === millwrights[0];
      const lapsed = p === millwrights[1];
      comp(p.id, `trade:${p.trade}`, isLead || lapsed ? 3 : 2, lapsed ? "2026-09-30" : "2028-12-31");
      if (p.role !== "contractor") comp(p.id, "gas-safety:chlorine", 1, "2027-06-30");
    }
    if (p.role === "process_controller" || p.role === "shift_supervisor") {
      const cls = p.role === "shift_supervisor" ? 5 : 2 + Math.floor(r() * 3);
      comp(p.id, "reg3630:process-controller", cls, r() < 0.1 ? "2026-10-01" : "2029-03-31", { regClass: cls });
      comp(p.id, "gas-safety:chlorine", 1, "2027-06-30");
    }
  }

  // Line management, consent to agent submission, and procedure authoring
  const sups = people.filter((p) => p.role === "shift_supervisor");
  for (const p of people) {
    p.supervisorId = p.trade && p.role !== "contractor" ? (p.role === "millwright" ? sups[1].id : sups[0].id) : null;
    p.autoSubmit = p === millwrights[2];
    if (p.role === "reliability_engineer") comp(p.id, "c-author", 1, "2028-12-31");
    // c-model: may release a plant model revision (design §4.3); the second engineer and the works manager hold it
    if (p.id === "P-001" || p.id === "P-003") comp(p.id, "c-model", 1, "2028-12-31");
  }

  // Shifts: today's day and night shift (min class IV = 4)
  for (const [id, crew, start, end] of [["SHF-DAY", "A", "2026-10-15T06:00:00Z", "2026-10-15T18:00:00Z"], ["SHF-NIGHT", "B", "2026-10-15T18:00:00Z", "2026-10-16T06:00:00Z"], ["SHF-PREV", "D", "2026-10-14T18:00:00Z", "2026-10-15T06:00:00Z"]]) {
    add({ id, type: "Shift", crew, start, end, minClass: 4 }, "SYNTH-HR");
  }

  // Presence: night crew D still on site at the clock, plus day maintenance staff arriving
  let prn = 1;
  const presence = (personId, zoneId) => add({ id: `PRS-${String(prn++).padStart(3, "0")}`, type: "Presence", personId, zoneId, since: "2026-10-14T18:05:00Z", source: pick(["badge", "rtls", "check-in"]) }, "SYNTH-ACCESS");
  const zonesForRole = { process_controller: ["Z12", "Z05", "Z04", "Z06"], shift_supervisor: ["Z12"], millwright: ["Z07", "Z01"], fitter: ["Z05", "Z03"], electrician: ["Z10"], instrument_technician: ["Z06", "Z11"], lab_analyst: ["Z11"] };
  for (const p of people) {
    if (p.shift === "D" || (p.shift === "DAY" && zonesForRole[p.role])) presence(p.id, pick(zonesForRole[p.role] || ["Z12"]));
  }
  const contractor = people.find((p) => p.role === "contractor");
  presence(contractor.id, "Z06"); // no chlorine gas-safety competence: Permit Guard scenario

  // Work orders: history plus open work
  const assets = objects.filter((o) => o.type === "Asset" && o.template);
  const artisans = people.filter((p) => p.trade && p.role !== "contractor");
  let wn = 1;
  const wo = (o) => {
    const id = `WO-${String(26000 + wn++)}`;
    add({ id, type: "WorkOrder", ...o });
    link(id, "TARGETS", o.assetId);
    if (o.assigneeId) link(id, "ASSIGNED_TO", o.assigneeId);
    return id;
  };
  for (let i = 0; i < 40; i++) {
    const a = pick(assets);
    const kind = r() < 0.6 ? "PM" : "CM";
    const month = 1 + Math.floor(r() * 9);
    wo({ kind, assetId: a.id, title: kind === "PM" ? `Planned inspection: ${a.name}` : `Corrective: ${a.name}`, state: "closed", priority: pick(["P2", "P3", "P4"]), assigneeId: pick(artisans).id, planned: `2026-0${month}-10`, closed: `2026-0${month}-1${Math.floor(r() * 9)}`, hours: 2 + Math.floor(r() * 10) });
  }
  const hlpA = assets.find((a) => a.positionTag === "HLP-A");
  const hlpB = assets.find((a) => a.positionTag === "HLP-B");
  const histWo = wo({ kind: "CM", assetId: hlpA.id, title: "High DE vibration on HLP-A", state: "closed", priority: "P2", assigneeId: millwrights[0].id, planned: "2025-08-04", closed: "2025-08-06", hours: 9 });
  wo({ kind: "CM", assetId: hlpB.id, title: "HLP-B: replaced mechanical seal", state: "closed", priority: "P2", assigneeId: millwrights[2].id, planned: "2026-03-02", closed: "2026-03-03", hours: 6 });
  wo({ kind: "PM", assetId: hlpB.id, title: "HLP-B: 6-monthly vibration survey", state: "open", priority: "P3", assigneeId: millwrights[0].id, planned: "2026-10-20", hours: 2 });
  const dp2 = assets.find((a) => a.positionTag === "DP-2");
  wo({ kind: "CM", assetId: dp2.id, title: "DP-2 losing prime intermittently", state: "in_progress", priority: "P2", assigneeId: people.find((p) => p.role === "fitter").id, planned: "2026-10-14", hours: 3 });

  // Findings: verified history the copilot can cite
  add({ id: "FND-001", type: "Finding", partId: `PRT-HLP-A-05`, assetId: hlpA.id, workOrderId: histWo, authorRole: "millwright", authorId: millwrights[0].id, text: "Fretting on the DE bearing housing bore at 12 o'clock. Traced to 0.15 mm soft foot under the motor NDE foot; shimmed, realigned, vibration fell from 7.8 to 2.1 mm/s.", verified: true, verifiedBy: "reliability_engineer", at: "2025-08-06" }, "APP");
  link("FND-001", "ABOUT", "PRT-HLP-A-05");
  add({ id: "FND-002", type: "Finding", partId: `PRT-HLP-B-10`, assetId: hlpB.id, authorRole: "millwright", text: "Seal faces showed thermal cracking; flush line was partly blocked. Cleared flush line and replaced seal.", verified: true, verifiedBy: "reliability_engineer", at: "2026-03-03" }, "APP");
  link("FND-002", "ABOUT", "PRT-HLP-B-10");
  add({ id: "FND-003", type: "Finding", partId: `PRT-DP-1-07`, assetId: assets.find((a) => a.positionTag === "DP-1").id, authorRole: "fitter", text: "Loss of prime traced to a worn suction check-valve ball; replaced ball and seat.", verified: true, verifiedBy: "reliability_engineer", at: "2026-05-19" }, "APP");
  link("FND-003", "ABOUT", "PRT-DP-1-07");

  // Permits: RWP-C isolated under an open permit; nothing on HLP-B
  const rwpc = assets.find((a) => a.positionTag === "RWP-C");
  add({ id: "PTW-0412", type: "Permit", kind: "general", state: "open", assetId: rwpc.id, zoneId: "Z01", holderId: millwrights[3].id, opened: "2026-10-14T07:30:00Z", isolations: [{ point: "MCC-1 feeder 7", state: "applied", appliedBy: millwrights[3].id, verifiedBy: people.find((p) => p.role === "shift_supervisor").id }] }, "APP");
  link("PTW-0412", "COVERS", rwpc.id);

  // Lab samples (SANS 241): one turbidity non-compliance without a response
  let sn = 1;
  for (let d = 1; d <= 14; d++) {
    const day = `2026-10-${String(d).padStart(2, "0")}`;
    for (const [analyte, base, spread, limit, unit] of [["turbidity", 0.3, 0.2, 1.0, "NTU"], ["free_chlorine", 0.9, 0.3, 5, "mg/L"], ["e_coli", 0, 0, 0, "count/100mL"], ["ph", 7.8, 0.3, 9.7, "pH"]]) {
      let value = +(base + (r() - 0.5) * spread).toFixed(2);
      if (analyte === "turbidity" && d === 12) value = 1.3;
      add({ id: `SMP-${String(sn++).padStart(4, "0")}`, type: "Sample", point: "Final water", processUnitId: "PU-storage", zoneId: "Z11", analyte, value, limit, unit, takenAt: `${day}T08:00:00Z`, compliant: analyte === "e_coli" ? value <= 0 : value <= limit, response: null }, "SYNTH-LIMS");
    }
  }
  // Calibration certificates: Z06 residual analyser certificate missing on purpose
  add({ id: "DOC-CAL-FWTURB", type: "Document", kind: "certificate", title: "Calibration certificate: combined filtered turbidity analyser", revision: "2026-07", sensorId: "SEN-FW-turb", validTo: "2027-07-01" }, "SYNTH-DOCS");

  // Compliance requirements (simplified Blue Drop / SANS 241 / Reg. 3630 criteria)
  for (const [id, framework, criterion] of [
    ["REQ-BD-PROC", "Blue Drop", "Registered process controllers on every shift at or above the works minimum class"],
    ["REQ-BD-QUAL", "Blue Drop", "Final-water microbiological and chemical compliance with SANS 241"],
    ["REQ-BD-CAL", "Blue Drop", "Calibration of process-control analysers within the last 12 months"],
    ["REQ-BD-INC", "Blue Drop", "Every SANS 241 non-compliance has a documented response"],
    ["REQ-BD-AM", "Blue Drop", "Planned maintenance completed on critical assets"]
  ]) add({ id, type: "Requirement", framework, criterion }, "CONFIG");


  // ---- Workforce intelligence (Phase 2): chat channels, the CL-3 contract, past jobs, issues and field notes ----
  const byId = (id) => objects.find((o) => o.id === id);
  const hashNo = (s) => createHash("sha256").update(s).digest("hex");
  people.forEach((p, i) => {
    add({ id: `CHN-${p.id}`, type: "Channel", kind: "whatsapp", address: `+27 60 000 ${1000 + i}`, personId: p.id, members: [p.id], audience: [p.id], noticePosted: true }, "CHANNEL-STUB");
    link(`CHN-${p.id}`, "CHANNEL_OF", p.id);
  });
  const cl3 = assets.find((a) => a.positionTag === "CL-3");
  [["PAR-001", "Contractor site agent"], ["PAR-002", "Contractor fitter"], ["PAR-003", "Contractor fitter"]].forEach(([id, label], i) =>
    add({ id, type: "Participant", label, employer: "Synthetic Contractor (Pty) Ltd", numberHash: hashNo(`+27 82 555 010${i}`), channelIds: ["CHN-GRP-CL3"] }, "CHANNEL-STUB"));
  const grp = ["PAR-001", "PAR-002", "PAR-003", "P-004", sups[1].id];
  add({ id: "CHN-GRP-CL3", type: "Channel", kind: "whatsapp", address: "group:cl3-refurb", groupName: "CL-3 refurb", projectId: "PRJ-CL3", members: grp, audience: grp, noticePosted: true }, "CHANNEL-STUB");
  const ms = (id, title, due, keywords, extra = {}) => ({ id, title, due, keywords, claimedAt: null, confirmedAt: null, confirmedBy: null, ...extra });
  add({
    id: "PRJ-CL3", type: "Project", title: "Clarifier 3 scraper drive refurbishment", kind: "contract", contractorEmployer: "Synthetic Contractor (Pty) Ltd",
    assetIds: [cl3.id], assetId: cl3.id, start: "2026-09-28", end: "2026-11-06", ownerId: "P-004", channelId: "CHN-GRP-CL3", autoSubmit: false,
    milestones: [
      ms("M1", "Isolation and access scaffold", "2026-10-02", ["isolation", "scaffold"], { claimedAt: "2026-10-01T15:10:00Z", confirmedAt: "2026-10-02T08:05:00Z", confirmedBy: sups[1].id }),
      ms("M2", "Scraper arms and drive removed", "2026-10-09", ["scraper"], { claimedAt: "2026-10-08T16:20:00Z" }),
      ms("M3", "Bearings and slewing ring replaced", "2026-10-16", ["bearing", "slewing"]),
      ms("M4", "Scraper arm weld repairs", "2026-10-23", ["weld"]),
      ms("M5", "Gearbox refurbished and refitted", "2026-10-30", ["gearbox"]),
      ms("M6", "Commissioning and handover", "2026-11-06", ["commission", "handover"])
    ]
  }, "SYNTH-ERP");
  link("PRJ-CL3", "TARGETS", cl3.id);
  // Region design §4.4: CL-3 gains a footprint and money; six more projects, run by the works (no contractor group yet).
  for (const [id, f] of PROJECTS) {
    if (id === "PRJ-CL3") { Object.assign(byId(id), f, { takesOutOfService: f.takesOutOfService.map((t) => ({ ...t, id: cl3.id })) }); continue; }
    add({ id, type: "Project", contractorEmployer: "Synthetic Contractor (Pty) Ltd", assetIds: [], assetId: null, channelId: null, autoSubmit: false, ...f }, "SYNTH-ERP");
  }
  // Tags on vehicles and portable plant (Region design §4.3); their pings come from src/trackers.mjs
  // a year of Sentinel scene statistics, grids for the telemetry window (Region design §5)
  for (const sc of makeScenes({ seed })) add(sc, "SYNTH-EO");
  for (const t of TRACKERS) add({ id: t.id, type: "Tracker", kind: t.kind, name: t.name, boundTo: t.boundTo, projectId: t.projectId || null, geofences: t.geofences }, "SYNTH-AVL");
  link("CHN-GRP-CL3", "CHANNEL_OF", "PRJ-CL3");
  const msg = (id, channelId, from, at, text, extra = {}) => add({ id, type: "Message", channelId, direction: from === "WORKS" ? "out" : "in", from, at, text, media: [], audience: byId(channelId).audience, ...extra }, "CHANNEL-STUB");
  const progress = { parsed: { kind: "progress", confidence: 0.7 }, outcome: "recorded" };
  msg("MSG-H01", "CHN-GRP-CL3", "PAR-001", "2026-10-01T15:10:00Z", "Scaffold up and isolation confirmed with your supervisor, ready to start.", { ...progress, media: ["photo:cl3-scaffold.jpg"] });
  msg("MSG-H02", "CHN-GRP-CL3", "PAR-002", "2026-10-06T07:30:00Z", "Crew on site today, unbolting the drive cover.", progress);
  msg("MSG-H03", "CHN-GRP-CL3", "PAR-001", "2026-10-08T16:20:00Z", "Scraper arms off and drive removed, pics attached.", { ...progress, media: ["photo:cl3-arms-1.jpg", "photo:cl3-arms-2.jpg"] });
  msg("MSG-H04", "CHN-GRP-CL3", "PAR-002", "2026-10-08T17:00:00Z", "Issue: gearbox oil seal leaking on removal", { parsed: { kind: "issue", confidence: 0.9 }, outcome: "recorded" });
  msg("MSG-H05", "CHN-GRP-CL3", "PAR-001", "2026-10-10T16:40:00Z", "Parts delivered today, fitting next week.", progress);
  msg("MSG-H11", `CHN-${millwrights[0].id}`, millwrights[0].id, "2026-10-13T15:30:00Z", "HLP-B DE bearing sounds worn, housing warm to touch.", { parsed: { kind: "observation", confidence: 0.7 }, outcome: "recorded" });
  msg("MSG-H12", `CHN-${millwrights[0].id}`, "WORKS", "2026-10-13T15:31:00Z", "Logged against HLP-B. Asset Watch has it on alert and the 6-monthly survey is assigned to you.", { inReplyTo: "MSG-H11" });
  [["PCL-H01", "M1", "MSG-H01"], ["PCL-H02", null, "MSG-H02"], ["PCL-H03", "M2", "MSG-H03"], ["PCL-H05", null, "MSG-H05"]].forEach(([id, milestoneId, messageId]) => {
    const m = byId(messageId);
    add({ id, type: "ProgressClaim", projectId: "PRJ-CL3", milestoneId, messageId, by: m.from, at: m.at, text: m.text, evidence: m.media, confirmed: milestoneId === "M1" }, "CHANNEL-STUB");
    link(id, "CLAIMS", "PRJ-CL3");
  });

  // Past jobs, as executed against the released procedures: performance has something to read.
  const engineers = people.filter((p) => p.clearance === "engineer").map((p) => p.id);
  const closedWos = objects.filter((o) => o.type === "WorkOrder" && o.state === "closed" && o.assigneeId && byId(o.assetId) && byId(o.assetId).template).sort((a, b) => a.id.localeCompare(b.id));
  const isPump = (w) => byId(w.assetId).template === "centrifugal_pump";
  const lead = closedWos.filter((w) => isPump(w) && w.assigneeId === millwrights[0].id).slice(0, 3); // the demo artisan has history to show
  const pumpWos = [...lead, ...closedWos.filter((w) => isPump(w) && !lead.includes(w))].slice(0, 6);
  const otherWos = closedWos.filter((w) => byId(w.assetId).template !== "centrifugal_pump").slice(0, 12 - pumpWos.length);
  [...pumpWos, ...otherWos].forEach((w, i) => {
    const proc = byId(`PRC-${byId(w.assetId).template.toUpperCase()}-v3`);
    const person = byId(w.assigneeId);
    let t = Date.parse(`${w.closed}T07:00:00Z`);
    const startedAt = new Date(t).toISOString();
    const steps = proc.steps.map((s) => {
      // the heavy-lift withdrawal step runs well over its estimate for everyone: Procedure Steward's case
      const minutes = Math.max(1, Math.round(s.expectedMinutes * (s.hazard === "Heavy lift" ? 1.6 + r() * 0.3 : 0.8 + r() * 0.4)));
      t += minutes * 60000;
      const b = s.requires.reading && T[proc.template].bands[s.requires.reading.partName];
      return { step: s.step, state: "done", at: new Date(t).toISOString(), minutes, value: b ? +(b[1] + (b[2] - b[1]) * (0.2 + r() * 0.6)).toFixed(3) : null, readingId: null, note: null };
    });
    add({ id: `EXE-H${String(i + 1).padStart(2, "0")}`, type: "Execution", workOrderId: w.id, assetId: w.assetId, personId: person.id, procedureId: proc.id, procedureVersion: 3, startedAt, finishedAt: new Date(t).toISOString(), state: "done",
      audience: [...new Set([person.id, person.supervisorId, ...engineers].filter(Boolean))], steps }, "APP");
    link(`EXE-H${String(i + 1).padStart(2, "0")}`, "FOR", w.id);
  });

  // Issues and field notes
  const partOf = (tag, name) => objects.find((o) => o.type === "Part" && o.id.startsWith(`PRT-${tag}-`) && o.name === name);
  const astOf = (tag) => assets.find((a) => a.positionTag === tag);
  const fitter = people.find((p) => p.role === "fitter");
  const issue = (id, o) => { add({ id, type: "Issue", partId: null, workOrderId: null, projectId: null, procedureId: null, step: null, evidence: [], assigneeId: null, ...o }, "APP"); if (o.assetId) link(id, "ON", o.assetId); };
  issue("ISS-H01", { title: "Shaft sleeve scored, no spare sleeve in stores", state: "open", raisedBy: millwrights[2].id, assetId: astOf("HLP-C").id, partId: partOf("HLP-C", "Shaft sleeve").id, procedureId: "PRC-CENTRIFUGAL_PUMP-v3", step: 8, at: "2026-09-22T10:00:00Z" });
  issue("ISS-H02", { title: "SOP step 6 does not say to rig the lifting beam first", state: "triaged", raisedBy: millwrights[1].id, assetId: astOf("RWP-B").id, procedureId: "PRC-CENTRIFUGAL_PUMP-v3", step: 6, at: "2026-08-14T09:00:00Z" });
  issue("ISS-H03", { title: "Gearbox oil seal leaking on removal", state: "in_work", raisedBy: "PAR-002", assetId: cl3.id, projectId: "PRJ-CL3", assigneeId: "P-004", at: "2026-10-08T17:00:00Z" });
  issue("ISS-H04", { title: "DP-2 suction line has no air-release valve", state: "open", raisedBy: fitter.id, assetId: astOf("DP-2").id, procedureId: "PRC-DOSING_PUMP-v3", step: 2, at: "2026-10-12T11:00:00Z" });
  issue("ISS-H05", { title: "Belt guard bolts seized on BLW-A", state: "done", raisedBy: millwrights[3].id, assetId: astOf("BLW-A").id, procedureId: "PRC-BLOWER-v3", step: 3, at: "2026-07-03T08:30:00Z" });
  issue("ISS-H06", { title: "Wrong gasket size on the HLP-A drawing", state: "done", raisedBy: millwrights[0].id, assetId: astOf("HLP-A").id, at: "2026-06-18T13:00:00Z" });
  const note = (id, tag, partName, procedureId, step, authorId, at, text) => {
    const part = partOf(tag, partName);
    add({ id, type: "KnowledgeNote", text, authorId, partId: part ? part.id : null, assetId: astOf(tag).id, procedureId, step, executionId: null, messageId: null, verified: false, at }, "APP");
    link(id, "ABOUT", part ? part.id : astOf(tag).id);
  };
  note("KN-H01", "HLP-A", "Shaft sleeve", "PRC-CENTRIFUGAL_PUMP-v3", 8, millwrights[0].id, "2025-08-06T14:00:00Z", "Scoring sits under the seal face; wipe and check there before measuring the OD.");
  note("KN-H02", "RWP-B", "Shaft sleeve", "PRC-CENTRIFUGAL_PUMP-v3", 8, millwrights[2].id, "2026-04-09T11:20:00Z", "Measure the sleeve OD at three points; ours was oval, not undersize.");
  note("KN-H03", "HLP-C", "Shaft sleeve", "PRC-CENTRIFUGAL_PUMP-v3", 8, millwrights[3].id, "2026-09-22T10:05:00Z", "No spare sleeve in stores. Check stock before you strip the pump.");
  note("KN-H04", "RWP-A", "Bearing housing", "PRC-CENTRIFUGAL_PUMP-v3", 6, millwrights[1].id, "2026-05-21T09:40:00Z", "Rig the lifting beam over the motor end first or the back pull-out unit fouls the guard rail.");
  note("KN-H05", "BLW-A", "Belt drive", "PRC-BLOWER-v3", 3, millwrights[3].id, "2026-07-03T08:40:00Z", "Guard bolts seize; soak with penetrating oil the shift before.");
  note("KN-H06", "BLW-B", "Belt drive", "PRC-BLOWER-v3", 3, millwrights[2].id, "2026-08-27T13:10:00Z", "Belt deflection is easier to read with the tension gauge than by thumb.");
  note("KN-H07", "DP-1", "Suction check valve", "PRC-DOSING_PUMP-v3", 2, fitter.id, "2026-05-19T15:00:00Z", "Loss of prime was the suction ball, not the diaphragm. Check the ball first.");
  note("KN-H08", "DP-2", "Suction check valve", "PRC-DOSING_PUMP-v3", 2, fitter.id, "2026-10-12T11:05:00Z", "Air collects at the high point of the suction line; bleed it there.");
  note("KN-H09", "CL-1", "Worm gearbox", "PRC-CLARIFIER_DRIVE-v3", 3, millwrights[0].id, "2026-03-30T10:00:00Z", "Gearbox oil looked milky: water ingress through the breather. Fit the desiccant breather.");

  // one decision statement per agent (agents design §4.1)
  for (const m of AGENT_SPECS) add(specFromManifest(m), "SYNTH-HARNESS");

  // ---- Accounts and IT (plan 3b): added after every seeded draw, so no earlier value moves ----
  [["P-043", "Lerato Khumalo", "accounts_clerk", "operator", "P-044"], ["P-044", "Thandi Mokoena", "finance_officer", "supervisor", "P-001"],
    ["P-045", "Ayanda Mthembu", "it_admin", "operator", "P-001", { itAdmin: true }]].forEach(([id, name, role, clearance, supervisorId, extra], i) => {
    add({ id, type: "Person", name, role, clearance, trade: null, shift: "DAY", employer: "Riverbend Works", supervisorId, ...extra }, "SYNTH-HR");
    add({ id: `CHN-${id}`, type: "Channel", kind: "whatsapp", address: `+27 60 000 ${1000 + people.length + i}`, personId: id, members: [id], audience: [id], noticePosted: true }, "CHANNEL-STUB");
    link(`CHN-${id}`, "CHANNEL_OF", id);
  });
  // IT's connector catalogue (agents design §7): per connector and operation, the roles that may use it, the most an
  // agent may do with it, and whether one IT administrator must sign it off per role first
  const ALL = ["*"], line = (op, action, roles, maxLevel, itSignOff = false) => ({ op, action, roles, maxLevel, itSignOff, signedOff: {} });
  const money = ["accounts_clerk", "finance_officer"];
  for (const [kind, lines] of [
    ["m365.mail", [line("read", null, [...money, "works_manager"], "read")]],
    ["m365.files", [line("read", null, [...money, "works_manager"], "read"), line("write", "file_document", money, "act", true)]],
    ["m365.teams", [line("send", null, ALL, "notify")]], // Teams posting is not an action yet; send_message is the works chat
    ["google.mail", [line("read", null, ALL, "read")]], ["google.drive", [line("read", null, ALL, "read")]], ["google.sheets", [line("read", null, ALL, "read")]],
    ["erp", [line("read", null, [...money, "planner", "works_manager"], "read"), line("post", "post_invoice_match", money, "propose")]],
    ["cmms", [line("read", null, ALL, "read"), line("write", null, ALL, "act")]]
  ]) add({ id: connectorId(kind), type: "Connector", kind, lines }, "CONFIG");

  // ---- How people work (plan 3b Task 8): the history the Recommender reads, fixed values, no seeded draws ----
  const hlpb = astOf("HLP-B"), mill = millwrights[0];
  // P-028 checks the HLP-B bearing temperature by hand most mornings
  ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"].forEach((d, i) => {
    add({ id: `RDG-H${String(i + 1).padStart(2, "0")}`, type: "Reading", targetId: hlpb.id, assetId: hlpb.id, measure: "bearing temp", value: 66 + (i % 4) * 1.5, unit: "°C", workOrderId: null, at: `${d}T07:${String(5 + i).padStart(2, "0")}:00Z`, source: "field", by: mill.id }, "APP");
    link(`RDG-H${String(i + 1).padStart(2, "0")}`, "OF", hlpb.id);
  });
  // the planner rejected Scheduler five times for the same reason
  const cms = objects.filter((o) => o.type === "WorkOrder").slice(0, 5);
  cms.forEach((w, i) => {
    const at = `2026-10-${String(1 + i * 2).padStart(2, "0")}T08:30:00Z`, done = `2026-10-${String(1 + i * 2).padStart(2, "0")}T09:10:00Z`, id = `PRP-H${String(i + 1).padStart(2, "0")}`;
    add({ id, type: "Proposal", action: "schedule_work", params: { workOrderId: w.id, assigneeId: millwrights[i % 2].id }, actorId: "Scheduler", actorKind: "agent", runId: null, assetId: w.assetId || null, evidence: [], risk: null, state: "rejected", created: at, resolvedBy: "P-004", resolvedAt: done, zoneId: null, audience: null }, "APP");
    add({ id: `FBK-H${String(i + 1).padStart(2, "0")}`, type: "Feedback", targetId: id, runId: null, verdict: "reject", comment: "artisan on leave", authorId: "P-004", at: done }, "APP");
    link(`FBK-H${String(i + 1).padStart(2, "0")}`, "ON", id);
  });
  // raw-water sampling rounds wait about three hours for the C-shift supervisor's approval at night
  const cSup = sups.find((p) => p.shift === "C");
  [["2026-09-24", 150], ["2026-09-27", 180], ["2026-09-30", 165], ["2026-10-03", 210], ["2026-10-06", 195], ["2026-10-09", 170]].forEach(([night, wait], i) => {
    const created = Date.parse(`${night}T22:30:00Z`);
    const id = `PRP-H${String(6 + i).padStart(2, "0")}`;
    add({ id, type: "Proposal", action: "start_sampling_round", params: { detectionId: `GEO-H${i + 1}` }, actorId: "Geo Watch", actorKind: "agent", runId: null, assetId: null, evidence: [], risk: null, state: "approved",
      created: new Date(created).toISOString(), resolvedBy: cSup.id, resolvedAt: new Date(created + wait * 60000).toISOString(), zoneId: null, audience: null }, "APP");
  });
  // the supplier queries waiting on the clerk; the bank-change one is the invoice in the accounts inbox (connectors)
  [["new bank details on a resent invoice", "2026-09-26T10:00:00Z"], ["credit note missing for returned bearings", "2026-09-29T09:00:00Z"], ["statement does not reconcile for September", "2026-10-02T11:30:00Z"], ["VAT number missing on invoice", "2026-10-06T14:00:00Z"]].forEach(([what, at], i) =>
    add({ id: `ISS-A${String(i + 1).padStart(2, "0")}`, type: "Issue", title: `Supplier query: ${what}`, state: "open", raisedBy: "P-043", assetId: null, partId: null, workOrderId: null, projectId: null, procedureId: null, step: null, evidence: [], assigneeId: "P-043", audience: ["P-043", "P-044"], at }, "APP"));
  // ---- Specs, corrections and organisations (plan 4, job brief design §4, §7): fixed values after every seeded draw ----
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const sop = (tpl) => ({ kind: "Document", id: docsByTemplate[tpl], title: "SOP revision C", at: "2025-02-01", authorId: "P-001" });
  const fromSop = { confirmedBy: "P-001", confirmedAt: "2025-02-01T00:00:00Z", reason: "From SOP revision C" };
  for (const part of objects.filter((o) => o.type === "Part" && o.band)) {
    const a = byId(part.assetId), proc = objects.find((o) => o.type === "Procedure" && o.template === a.template && o.state === "released");
    const st = proc && proc.steps.find((x) => x.requires && x.requires.reading && x.requires.reading.partName === part.name);
    const key = slug(part.band.measure);
    add({ id: `SPC-${a.positionTag}-${key}`, type: "Spec", assetId: a.id, partName: part.name, step: st ? st.step : null, stepText: st ? st.text : null, key, measure: part.band.measure, unit: part.band.unit,
      lo: part.band.lo, hi: part.band.hi, target: null, condition: null, version: 1, state: "confirmed", sourceRefs: [sop(a.template)], ...fromSop, history: [] }, "SYNTH-DOCS");
  }
  // the coagulant pumps' delivery: the owner's spec revision B (source b) confirmed in March over the SOP's range
  for (const tag of ["DP-1", "DP-2"]) {
    add({ id: `SPC-${tag}-delivery`, type: "Spec", assetId: astOf(tag).id, partName: "Dosing head", step: 2, stepText: "Check suction line for air and the calibration column draw-down", key: "delivery", measure: "Delivery at 60% stroke", unit: "L/h",
      lo: 114, hi: 126, target: 120, condition: null, version: 2, state: "confirmed",
      sourceRefs: [{ kind: "m365.files", id: "ATT-ENG-01", title: "owner spec rev B", at: "2026-03-02", authorId: null }], confirmedBy: "P-001", confirmedAt: "2026-03-05T09:00:00Z", reason: "Owner specification revision B",
      history: [{ version: 1, lo: 100, hi: 140, target: null, sourceRefs: [sop("dosing_pump")], ...fromSop }] }, "SYNTH-DOCS");
  }
  [["ORG-OWNER", "Riverbend Water Board", "owner"], ["ORG-SYNCON", "Synthetic Contractor (Pty) Ltd", "contractor"], ["ORG-DOSATEC", "Dosatec", "oem"]]
    .forEach(([id, name, kind]) => add({ id, type: "Organisation", name, kind }, "SYNTH-ERP"));
  const dp1 = astOf("DP-1"), dp2a = astOf("DP-2");
  add({ id: "PRJ-H2025-DOSE", type: "Project", title: "Coagulant dosing upgrade", kind: "contract", state: "closed", start: "2025-04-01", end: "2025-07-31", ownerId: "P-004",
    assetIds: [dp1.id, dp2a.id], assetId: dp1.id, contractorEmployer: "Synthetic Contractor (Pty) Ltd", milestones: [], channelId: null, autoSubmit: false }, "SYNTH-ERP");
  link("PRJ-H2025-DOSE", "TARGETS", dp1.id);
  for (const p of objects.filter((o) => o.type === "Project")) Object.assign(p, { clientOrgId: "ORG-OWNER", ...(p.contractorEmployer ? { contractorOrgId: "ORG-SYNCON" } : {}) });
  const correction = (id, scope, fromId, at, line, text, wrongSourceRef = null) => {
    add({ id, type: "Correction", line, text, wrongSourceRef, wrongValue: null, rightValue: null, scope, fromId, by: "P-001", at }, "APP");
    link(id, "FROM", fromId);
  };
  correction("COR-H01", { template: "dosing_pump" }, "PRJ-H2025-DOSE", "2025-07-20T10:00:00Z", "Same model: check delivery by draw-down, never from the DM 400 table (40 Hz drives).",
    "The DM 400 manual's stroke-to-delivery table is for 50 Hz; our drives run at 40 Hz. Check delivery by draw-down, never from the table.", { kind: "Document", id: "DOC-OEM-DOSING_PUMP" });
  correction("COR-H02", { orgId: "ORG-SYNCON" }, "PRJ-H2025-DOSE", "2025-07-22T10:00:00Z", "Synthetic Contractor sheets give mL/min: ×0.06 for L/h.",
    "Their commissioning sheets give delivery in mL/min. Convert (×0.06) before comparing with L/h.");
  correction("COR-H03", { assetId: dp1.id }, "FND-003", "2026-05-19T16:00:00Z", "Loss of prime was the suction ball. Check it first.",
    "Loss of prime was the suction check-valve ball. Check the ball before the diaphragm.");
  // source f: the C-shift supervisor's word on the works chat after the storm
  msg("MSG-H-SPEC1", `CHN-${cSup.id}`, cSup.id, "2026-10-13T23:15:00Z", "we've had DP-2 delivering 125 L/h since the storm");
  return { objects, links, clock: CLOCK };
}
