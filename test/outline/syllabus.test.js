// @ts-check
// ENGL 192 PDF-syllabus parsing: redacted .txt fixture, plus a live pdfText
// comparison when the raw PDF capture is present.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSyllabusText } from "../../extension/src/sources/outline/syllabus.js";
import { pdfText } from "../../extension/src/sources/outline/pdf.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "outline");
const CAPTURES = path.resolve(DIR, "..", "..", "..", "..", "captures", "outlines");
const PDF = path.join(CAPTURES, "ENGL 192 (008) - Engineering Communications Fall 2026 Syllabus.pdf");
const NOW = new Date("2026-09-27T16:00:00Z");

const FIXTURE = fs.readFileSync(path.join(DIR, "ENGL192-syllabus.txt"), "utf8");
const parse = (text, opts = {}) => parseSyllabusText(text, { now: NOW, termCode: 1269, sections: [], ...opts });

const at = (i) => i.dueAt || i.startAt;

test("ENGL192 header: code, term, section, room, title", () => {
  const r = parse(FIXTURE);
  assert.ok(r);
  assert.equal(r.code, "ENGL 192");
  assert.equal(r.term, 1269);
  assert.equal(r.section, "008");
  assert.equal(r.room, "DWE 1515");
  assert.equal(r.title, "Communication in the Engineering Profession");
});

test("ENGL192 expands to exactly 22 Tue/Thu classes, breaks excluded", () => {
  const { items } = parse(FIXTURE);
  const classes = items.filter((i) => i.type === "class");
  assert.equal(classes.length, 22);
  assert.equal(classes[0].startAt, "2026-09-10T17:00:00.000Z"); // Thu Sep 10 13:00 EDT
  assert.equal(classes[classes.length - 1].startAt, "2026-12-08T18:00:00.000Z"); // Tue Dec 8 13:00 EST
  for (const c of classes) {
    assert.equal(new Date(c.endAt) - new Date(c.startAt), 80 * 60000); // 13:00-14:20
    assert.equal(c.location, "DWE 1515");
    assert.equal(c.confidence, "exact");
    assert.equal(c.review, "auto");
  }
  const days = new Set(classes.map((c) => c.startAt.slice(0, 10)));
  for (const excluded of ["2026-10-13", "2026-10-15", "2026-10-22", "2026-10-27"]) {
    assert.ok(!days.has(excluded), excluded);
  }
  assert.ok(days.has("2026-10-20") && days.has("2026-10-29"));
});

test("ENGL192 produces exactly 16 non-class items", () => {
  const { items } = parse(FIXTURE);
  const rest = items.filter((i) => i.type !== "class");
  assert.equal(rest.length, 16);
  const ids = items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("ENGL192 single-date deliverables are exact 23:59 deadlines", () => {
  const { items } = parse(FIXTURE);
  const find = (re) => items.find((i) => re.test(i.title));
  /** [title matcher, expected dueAt, weight, type?] */
  const expected = [
    [/Syllabus & Assignment Outline Quiz/, "2026-09-14T03:59:00.000Z", 1, "quiz"],
    [/Information Sourcing\/Seeking/, "2026-09-21T03:59:00.000Z", 1, undefined],
    [/Defining an Engineering Problem/, "2026-09-21T03:59:00.000Z", 3, undefined],
    [/Shark-Tank/, "2026-10-05T03:59:00.000Z", 3, "deadline"], // "Pitch" title, but a single date is a deadline
    [/Technical Manual Analysis/, "2026-11-01T03:59:00.000Z", 3, undefined], // Due Oct 31, not Assigned Oct 19
    [/Report Rationale, Part I/, "2026-11-01T03:59:00.000Z", 3, undefined],
    [/Rationale, Part II/, "2026-11-09T04:59:00.000Z", 3, undefined],
    [/Technical Report Draft/, "2026-11-23T04:59:00.000Z", undefined, undefined],
    [/^Peer Reviews/, "2026-11-27T04:59:00.000Z", 2, undefined],
    [/^Technical Report$/, "2026-11-30T04:59:00.000Z", 35, undefined],
    [/^Posters/, "2026-12-07T04:59:00.000Z", 5, undefined],
    [/End of course quiz/, "2026-12-09T04:59:00.000Z", 1, "quiz"],
    [/Last chance/, "2026-12-10T04:59:00.000Z", undefined, undefined],
  ];
  for (const [re, dueAt, weight, type] of expected) {
    const item = find(re);
    assert.ok(item, String(re));
    assert.equal(item.dueAt, dueAt, String(re));
    assert.equal(item.weight, weight, String(re));
    assert.equal(item.confidence, "exact", String(re));
    assert.equal(item.review, "auto", String(re));
    if (type) assert.equal(item.type, type, String(re));
    assert.equal(item.evidence.method, "text", String(re));
  }
  // exactly one Technical Report item — the schedule's copy merged into it
  assert.equal(items.filter((i) => /^Technical Report$/.test(i.title)).length, 1);
});

test("ENGL192 windows and the showcase event", () => {
  const { items } = parse(FIXTURE);
  const pitch = items.find((i) => i.title === "Project Pitch & Presentation");
  assert.equal(pitch.type, "presentation");
  assert.equal(pitch.startAt, "2026-10-05T04:00:00.000Z");
  assert.equal(pitch.endAt, "2026-10-09T04:00:00.000Z");
  assert.equal(pitch.allDay, true);
  assert.equal(pitch.confidence, "tentative");
  assert.equal(pitch.review, "pending");
  assert.equal(pitch.weight, 15);
  // the schedule's own "Pitch Presentations (Oct. 5-8)" merged in
  assert.equal(items.filter((i) => /Pitch Presentations/.test(i.title)).length, 0);
  const pres = items.find((i) => i.title === "Engineering Presentation");
  assert.equal(pres.startAt, "2026-11-30T05:00:00.000Z");
  assert.equal(pres.endAt, "2026-12-07T05:00:00.000Z");
  assert.equal(pres.weight, 10);
  // "Technical Report Presentations (in class (10%))" merged/dropped
  assert.equal(items.filter((i) => /Technical Report Presentations/.test(i.title)).length, 0);
  const show = items.find((i) => /Showcase/.test(i.title));
  assert.equal(show.type, "event");
  assert.equal(show.startAt, "2026-12-07T05:00:00.000Z");
  assert.equal(show.allDay, true);
  assert.equal(show.confidence, "tentative");
  assert.equal(show.review, "pending");
});

test("ENGL192 course.weights is the grade breakdown", () => {
  const { course } = parse(FIXTURE);
  assert.deepEqual(course.weights, [
    { component: "Project Pitch & Presentation", weight: 15 },
    { component: "Technical Report", weight: 35 },
    { component: "Engineering Presentation", weight: 10 },
    { component: "Contributions", weight: 40 },
  ]);
});

test("ENGL192 respects section selection", () => {
  const off = parse(FIXTURE, { sections: ["LEC 009"] });
  assert.equal(off.items.filter((i) => i.type === "class").length, 0);
  assert.equal(off.skippedClasses, 22);
  const on = parse(FIXTURE, { sections: ["LEC 008"] });
  assert.equal(on.items.filter((i) => i.type === "class").length, 22);
});

test("pdfText + parseSyllabusText agree with the .txt fixture", { skip: !fs.existsSync(PDF) && "raw PDF not present" }, async () => {
  const text = await pdfText(new Uint8Array(fs.readFileSync(PDF)));
  const a = parse(FIXTURE);
  const b = parse(text);
  assert.ok(b);
  const sig = (r) =>
    r.items.filter((i) => i.type !== "class").map((i) => `${i.title}|${at(i)}`).sort();
  assert.deepEqual(sig(b), sig(a));
  assert.equal(b.items.filter((i) => i.type === "class").length, a.items.filter((i) => i.type === "class").length);
});
