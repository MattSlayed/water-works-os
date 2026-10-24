// The engineering sources behind spec triage (job brief design §7): the works mailbox, the Engineering folders and the
// coagulant dose sheet. Fixed values, no seeded draws, so nothing in the accounts history moves.
export const WORKS_MAILBOX = "works@riverbend.example";
export const DOSE_SHEET = "Coagulant dose calc!A1:F20";

const att = (id, name, contentType, quality, createdDateTime, lines) => ({ id, name, contentType, size: 120000, quality, createdDateTime, textLayer: lines.join("\n") });
const ATTS = [
  att("ATT-ENG-01", "Riverbend coagulant dosing spec rev B.pdf", "application/pdf", "clean", "2026-03-02T09:00:00Z", [
    "RIVERBEND WATER BOARD", "Coagulant dosing specification, revision B", "Date: 2026-03-02", "Signed: J. Molefe, for the owner",
    "DP-1 and DP-2 delivery at 60% stroke: 120 L/h ±5%", "Coagulant: polyaluminium chloride"]),
  att("ATT-ENG-02", "13QCA10 dosing data sheet.pdf", "application/pdf", "clean", "2024-11-20T09:00:00Z", [
    "INSTRUMENT AND EQUIPMENT DATA SHEET", "Drawing: RB-P-130 rev 2", "Date: 2024-11-20",
    "Tag: 13QCA10AP001 design delivery 100 L/h", "Tag: 13QCA10AP002 design delivery 100 L/h"]),
  att("ATT-ENG-03", "IMG_4410.jpg", "image/jpeg", "photo", "2026-10-12T14:20:00Z", ["DP-2 delivery 1?5 L/h"])
];
const FOLDER = { "ATT-ENG-01": "Engineering/Specs", "ATT-ENG-02": "Engineering/Drawings", "ATT-ENG-03": "Engineering/Site photos" };

const mail = (id, address, name, subject, receivedDateTime, content) => ({ id, subject, from: { emailAddress: { address, name } }, receivedDateTime,
  hasAttachments: false, attachments: [], body: { contentType: "text", content } });

export function seedEngineering() {
  return {
    messages: [
      mail("M365-WRK-002", "noreply@riverbend.example", "Riverbend Works", "Canteen closed on Friday", "2026-10-12T08:00:00Z", "The canteen is closed on Friday for maintenance."),
      mail("M365-WRK-001", "precious.sithole@riverbend.example", "Precious Sithole", "Coag dosing after the storm", "2026-10-13T16:40:00Z", "Team, run DP-2 at 135 L/h ±5% until raw turbidity settles. Precious")
    ],
    files: ATTS.map((a, i) => ({ id: `DRV-ENG-0${i + 1}`, name: a.name, parentReference: { path: `/drive/root:/${FOLDER[a.id]}` }, createdBy: { user: { id: "P-001" } },
      createdDateTime: a.createdDateTime, file: { mimeType: a.contentType }, attachmentId: a.id })),
    attachments: new Map(ATTS.map((a) => [a.id, a])),
    sheets: { [DOSE_SHEET]: [["Pump", "Design dose mg/L", "Flow ML/d", "Delivery L/h", "Updated", "By"], ["DP-1", "4.0", "60", "110", "2025-06-10", "P-002"], ["DP-2", "4.0", "60", "110", "2025-06-10", "P-002"]] }
  };
}
