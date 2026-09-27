// @ts-check
// parser tests: redacted real captures -> plain data.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { parseOutline } from "../../extension/src/sources/outline/parsers.js";
import { readingWeeksOf } from "../../extension/src/sources/outline/expand.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "outline");
const CODES = ["MATH117", "ECE105", "GENE119", "ECE190", "ECE150", "MATH115", "ECE198"];

export function load(code) {
  return parseOutline(parseHTML(fs.readFileSync(path.join(DIR, `${code}.html`), "utf8")).document);
}

test("MATH117 parses header and LEC 002 rows", () => {
  const d = load("MATH117");
  assert.equal(d.code, "MATH 117");
  assert.equal(d.term, 1269);
  assert.equal(d.title, "Calculus 1 for Engineering");
  const rows = d.schedule.filter((r) => r.section === "002" && r.kind === "LEC");
  assert.ok(rows.length >= 3);
  const makeup = rows.find((r) => r.dates.length);
  assert.deepEqual(makeup.dates, ["2026-09-09", "2026-10-07", "2026-11-04", "2026-11-18"]);
  assert.equal(makeup.start, "09:30");
});

test("schedule rows carry the rowspan instructor cell", () => {
  const d = load("MATH117");
  const rows = d.schedule.filter((r) => r.section === "002" && r.kind === "LEC");
  assert.ok(rows.length >= 3);
  // "Instructor" is the redacted placeholder name in the fixture; the
  // rowspan=4 td covers all four meeting rows of the section block.
  assert.ok(rows.every((r) => r.instructor === "Instructor"));
});

test("MATH115 multi-day row and two grading schemes", () => {
  const d = load("MATH115");
  const multi = d.schedule.find((r) => r.days.length === 3);
  assert.deepEqual(multi.days, [1, 3, 5]);
  assert.equal(d.schemes.length, 2);
  assert.deepEqual(d.schemes[0].rows.map((r) => r.weight), [10, 5, 30, 55]);
});

test("ECE105 reports no grading scheme", () => {
  const d = load("ECE105");
  assert.equal(d.noScheme, true);
  assert.equal(d.schemes.length, 0);
});

test("a non-outline document parses to null", () => {
  const { document } = parseHTML("<html><body><h1>Hello</h1><p>no outline here</p></body></html>");
  assert.equal(parseOutline(document), null);
});

test("every fixture parses without throwing", () => {
  for (const code of CODES) {
    const d = load(code);
    assert.ok(d && d.code, code);
    assert.ok(Array.isArray(d.schedule) && Array.isArray(d.tables) && d.text, code);
  }
});

test("reading weeks cover Oct 12-16 and stay plausible", () => {
  const ranges = CODES.flatMap((c) => readingWeeksOf(load(c), { now: new Date("2026-09-26T16:00:00Z") }));
  assert.ok(ranges.some(([a, b]) => a <= "2026-10-12" && b >= "2026-10-16"));
  // no stray single-day "weeks" from holiday dates inside long prose lines
  assert.ok(ranges.every(([a, b]) => a < b));
});
