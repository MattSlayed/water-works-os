import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The Ask page's render helpers, lifted out of web/app.js (a browser module) and run against stubs.
const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const block = app.slice(app.indexOf("// ---------- Ask:"), app.indexOf("const views = {"));
const { askBullets, askTimeline } = new Function("esc", "dot", "link", "AREAS", `${block}; return { askBullets, askTimeline };`)(
  (v) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), (st) => `[${st}]`, (id) => id, []);

const src = (n, id, dates = [], type = "Permit") => ({ n, id, type, title: id, status: "amber", dates });

test("ask page: each cite becomes its numbered source; unresolved cites drop; the picked source's bullets are marked", () => {
  const html = askBullets("Permit lapsed [PTW-1]. Pump at risk [ALT-9] [NOPE].", [src(1, "PTW-1"), src(2, "ALT-9")], 2);
  const lis = html.split("</li>");
  assert.equal(lis.length - 1, 2, "one paragraph splits into sentences");
  assert.match(lis[0], /^<li class="">Permit lapsed <button[^>]*data-src="1"/);
  assert.match(lis[1], /<li class="hit">Pump at risk <button[^>]*class="srcn on" data-src="2"/);
  assert.ok(!html.includes("NOPE"));
});

test("ask page: events on nearby dates pack into separate rows; an event near the end flips left; undated sources are listed", () => {
  const s = [src(1, "A", [{ at: "2026-10-30", label: "MCC certificate due", done: false }, { at: "2026-10-30", label: "Lock-out approval", done: false }]),
    src(2, "B", [{ at: "2026-10-31", label: "Works notification due", done: false }]), src(3, "C")];
  const html = askTimeline(s, 1, "2026-10-14", 900);
  const tops = [...html.matchAll(/top:(\d+)px/g)].map((m) => Number(m[1]));
  assert.equal(new Set(tops).size, 3, "three rows for three overlapping labels");
  assert.match(html, /class="tev flip on"/);
  assert.match(html, /No date: source 3/);
  assert.match(html, /left:41\.94%">Today · 14 Oct/);
  assert.equal(askTimeline([src(1, "A")], 1, "2026-10-14", 900), `<p class="meta">None of the sources has a date.</p>`);
});
