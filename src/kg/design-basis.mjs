// The Riverbend Design Basis, generated from the layout (src/layout.mjs) so its numbers cannot drift from the 3D scene.
// Deterministic: scripts/make-design-basis.mjs writes data/riverbend/design-basis.md and a test pins the bytes.
import { PLAN, STRUCTURES, CAPACITY_MLD } from "../layout.mjs";

const byTag = Object.fromEntries(STRUCTURES.map((s) => [s.tag, s]));
const lvl = (x) => x.toFixed(1), m2 = (x) => Math.round(x), m3 = (x) => Math.round(x / 10) * 10;
const area = (s) => (s.diameter ? (Math.PI * s.diameter * s.diameter) / 4 : s.w * s.l);

// one line per structure: tag, plan size, floor level, top water level and volume where the layout carries them
function line(asset) {
  const s = byTag[PLAN[asset].tag];
  const plan = s.diameter ? `${lvl(s.diameter)} m diameter` : `${lvl(s.w)} m by ${lvl(s.l)} m`;
  const parts = [`${s.tag} (${asset}): ${plan}, ${m2(area(s))} m²`, `floor ${lvl(s.baseLevel)} m`];
  if (s.twl != null) parts.push(`top water level ${lvl(s.twl)} m`, `volume ${m3(s.volumeM3)} m³`);
  return `- ${parts.join(", ")}`;
}
const list = (assets) => assets.map(line).join("\n");
const seq = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

export function designBasis() {
  const beds = Array.from({ length: 8 }, (_, i) => `F0${i + 1}`), bedArea = area(byTag[PLAN.F01.tag]);
  const rate = CAPACITY_MLD * 1000 / 24 / (beds.length * bedArea);
  const perClarifier = CAPACITY_MLD / 4, perOfThree = 90 / 3;
  return `# Riverbend Design Basis

Revision A. Riverbend Water Treatment Works, generated from the plant layout. Levels are metres above datum, rounded to 0.1 m; volumes are rounded to 10 m³ and areas to 1 m². Roofed reservoirs have no water mesh in the layout, so their top water level is the wall top.

## Basis of design

The works is designed for ${CAPACITY_MLD} ML/d with all four clarifiers in service. With clarifier CL-4 out of service for refurbishment the works is rated at 90 ML/d, which is the canonical capacity until CL-4 is returned to service.

Treatment runs in one stream: raw water intake and pumping, inlet works and coagulation, clarification, filtration, disinfection, storage and high-lift pumping to the distribution system.

## Raw water intake and pumping

Raw water is lifted from the intake pump station by the duty pumps RWP-A, RWP-B and RWP-C and delivered to the raw water reservoirs, which hold the buffer ahead of the inlet works.

${list(["RWP-1", "RWR-1", "RWR-2"])}

## Inlet works and coagulation

Raw water enters the mixing chamber, where coagulant is dosed from the chemical tanks by dosing pumps DP-1 and DP-2 in the dosing house.

${list(["MIX", "DOS-1", ...seq("T-20", 4)])}

## Clarification

The splitter box DB-1 shares flow evenly between the clarifiers. At ${CAPACITY_MLD} ML/d each of the four carries ${perClarifier} ML/d; with CL-4 out of service the three remaining clarifiers CL-1, CL-2 and CL-3 carry ${perOfThree} ML/d each. CL-4 is drained for refurbishment and so has no top water level.

${list(["DB-1", ...seq("CL-", 4)])}

## Filtration

Eight rapid gravity filters, ${beds[0]} to ${beds[7]}, stand in two filter buildings, ${beds.slice(0, 4).join(", ")} in FB-1 and ${beds.slice(4).join(", ")} in FB-2. At ${CAPACITY_MLD} ML/d with every bed in service the filtration rate is ${rate.toFixed(1)} m/h. Backwash water comes from the wash water tank BWR-1 through backwash pumps BWP-A and BWP-B, with air from blowers BLW-A and BLW-B in the filter pump room FPR-1.

${list([...beds, "FB-1", "FB-2", "FPR-1", "BWR-1"])}

## Disinfection

Filtered water is chlorinated from the chlorine house CLB-1 by chlorinators CHL-A and CHL-B and passes through the contact tanks CCT-1 and CCT-2, which are the slabs under the filter buildings.

${list(["CLB-1", "CCT-1", "CCT-2"])}

## Storage

Disinfected water is held in the clear water reservoirs RES-1 and RES-2 ahead of the high-lift pumps.

${list(["RES-1", "RES-2"])}

## High-lift pumping

Five high-lift pumps, HLP-A to HLP-E, draw from the clear water reservoirs in the high-lift pump house HLP-H and deliver to the distribution header.

${list(["HLP-H"])}
`;
}
