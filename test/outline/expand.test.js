// @ts-check
// expand tests: parsed outline -> contract items.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { parseOutline } from "../../extension/src/sources/outline/parsers.js";
import { buildOutline, readingWeeksOf } from "../../extension/src/sources/outline/expand.js";
import { extractDates } from "../../extension/src/lib/textdates/index.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "outline");
const NOW = new Date("2026-09-26T16:00:00Z");
const SECTIONS = {
  "MATH 117": ["LEC 002"],
  "MATH 115": ["LEC 002"],
  "ECE 105": ["LEC 002"],
  "ECE 190": ["LEC 002"],
  "ECE 198": ["LEC 002"],
  "GENE 119": ["SEM 003"],
};
const GROUPS = { "ECE 190": 5 };
const CODES = ["MATH117", "ECE105", "GENE119", "ECE190", "ECE150", "MATH115", "ECE198"];

const data = new Map();
for (const c of CODES) data.set(c, parseOutline(parseHTML(fs.readFileSync(path.join(DIR, `${c}.html`), "utf8")).document));
const READING = CODES.flatMap((c) => readingWeeksOf(data.get(c), { now: NOW, textDates: extractDates }));

function build(code, opts = {}) {
  const d = data.get(code);
  return buildOutline(d, {
    now: NOW,
    url: `https://outline.uwaterloo.ca/viewer/${code}`,
    sections: SECTIONS[d.code] || [],
    group: GROUPS[d.code] ?? null,
    officeHours: false,
    readingWeeks: READING,
    textDates: extractDates,
    ...opts,
  });
}

const torontoDay = (i) => i.id.match(/:(\d{4}-\d{2}-\d{2})T/) ? i.id.split(":").pop().slice(0, 10) : null;

test("MATH117 expands to 37 classes with reading week excluded", () => {
  const { items, course } = build("MATH117");
  const classes = items.filter((i) => i.type === "class");
  assert.equal(classes.length, 37);
  const lecture = items.find((i) => i.id === "outline:MATH117:LEC002:2026-09-14T12:30");
  assert.equal(lecture.startAt, "2026-09-14T16:30:00.000Z");
  assert.equal(lecture.endAt, "2026-09-14T17:20:00.000Z");
  assert.equal(lecture.location, "PSE 5353");
  assert.equal(lecture.section, "LEC 002");
  assert.match(lecture.details || "", /Heaviside/);
  // EST after the Nov 1 DST transition
  const nov2 = classes.find((i) => i.id === "outline:MATH117:LEC002:2026-11-02T12:30");
  assert.equal(nov2.startAt, "2026-11-02T17:30:00.000Z");
  // make-up lectures are single-date rows
  const makeup = items.find((i) => i.id === "outline:MATH117:LEC002:2026-09-09T09:30");
  assert.equal(makeup.startAt, "2026-09-09T13:30:00.000Z");
  assert.equal(makeup.category, "make-up");
  // nothing during reading week
  const rw = classes.filter((i) => {
    const d = i.startAt.slice(0, 10);
    return d >= "2026-10-12" && d <= "2026-10-16T23:59" && ["2026-10-12","2026-10-13","2026-10-14","2026-10-15","2026-10-16"].includes(d);
  });
  assert.equal(rw.length, 0);
  assert.equal(course.code, "MATH 117");
  assert.equal(course.name, "Calculus 1 for Engineering");
  assert.equal(course.term, 1269);
});

test("MATH117 midterm from TST and tentative final window", () => {
  const { items, course } = build("MATH117");
  const mid = items.find((i) => i.id === "outline:MATH117:exam:midterm");
  assert.equal(mid.startAt, "2026-10-22T20:30:00.000Z");
  assert.equal(mid.endAt, "2026-10-22T22:20:00.000Z");
  assert.equal(mid.weight, 33);
  assert.equal(mid.review, "auto");
  assert.ok(!mid.meta || !mid.meta.conflict);
  const fin = items.find((i) => i.category === "final");
  assert.equal(fin.startAt, "2026-12-10T05:00:00.000Z");
  assert.equal(fin.endAt, "2026-12-24T05:00:00.000Z");
  assert.equal(fin.allDay, true);
  assert.equal(fin.confidence, "tentative");
  assert.equal(fin.weight, 53);
  assert.equal(course.weights.length, 3);
  const ta = course.assessments.find((a) => a.component === "Tutorial Assignments (best 7 of 9)");
  assert.equal(ta.itemId, null);
  assert.equal(ta.weight, 14);
});

test("class items carry Instructor, Week topic and Office hours facts", () => {
  const { items, course } = build("ECE190");
  const cls = items.find((i) => i.type === "class");
  const facts = Object.fromEntries((cls.meta.facts || []).map((f) => [f.label, f.value]));
  assert.equal(facts.Instructor, "Instructor"); // redacted placeholder
  assert.match(facts["Office hours"] || "", /Tuesdays 10:30am - 12:30pm in EIT 3114/);
  // The whole office-hours block, bullet markers stripped, no dangling "and".
  assert.ok(course.officeHours.startsWith("Tuesdays 10:30am"), course.officeHours);
  assert.ok(!/and\s*$/i.test(course.officeHours));
  assert.match(course.officeHours, /Thursdays 10:30am - 12:30pm in EIT 3114/);

  // A class with a plan-week details line repeats it as the Week topic fact.
  const m = build("MATH117");
  const withTopic = m.items.find((i) => i.type === "class" && i.details);
  assert.ok(withTopic);
  const tf = Object.fromEntries((withTopic.meta.facts || []).map((f) => [f.label, f.value]));
  assert.equal(tf["Week topic"], withTopic.details);
  assert.equal(tf.Instructor, "Instructor");
});

test("exam coverage notes become a Covers fact", () => {
  const { items } = build("ECE105");
  const mid = items.find((i) => i.id === "outline:ECE105:exam:midterm");
  assert.match(mid.details, /Energy Conservation/);
  const covers = (mid.meta.facts || []).find((f) => f.label === "Covers");
  assert.ok(covers);
  assert.match(covers.value, /Energy Conservation/);
});

test("ECE105 midterm dedupe and prose items", () => {
  const { items, course } = build("ECE105");
  const mids = items.filter((i) => i.category === "midterm");
  assert.equal(mids.length, 1);
  assert.equal(mids[0].id, "outline:ECE105:exam:midterm");
  assert.equal(mids[0].startAt, "2026-10-27T20:30:00.000Z");
  assert.equal(mids[0].review, "auto");
  const a1 = items.find((i) => i.title === "Assignment #1");
  assert.equal(a1.dueAt, "2026-09-21T03:59:00.000Z");
  assert.equal(a1.allDay, true);
  assert.equal(a1.review, "pending");
  assert.equal(a1.evidence.method, "text");
  const q1 = items.find((i) => i.title === "Quiz #1");
  assert.ok(q1);
  assert.equal(q1.review, "pending");
  assert.equal((q1.startAt || q1.dueAt || "").slice(0, 10), "2026-09-18");
  const rev = items.find((i) => i.category === "review-session");
  assert.ok(rev);
  assert.equal(rev.type, "event");
  assert.equal((rev.startAt || "").slice(0, 10), "2026-10-23");
  assert.match(rev.title, /^Review for Midterm/); // not "Midterm" — the line's own text wins
  assert.deepEqual(course.weights, []);
});

test("ECE190 deadline chart, groups, classes, office hours", () => {
  const { items, course } = build("ECE190");
  const d1 = items.find((i) => /Deliverable 1 \(Part 1\)/.test(i.title));
  assert.equal(d1.dueAt, "2026-10-07T03:59:00.000Z");
  assert.equal(d1.weight, 8);
  assert.equal(d1.group, "1-20");
  const d1p2 = items.find((i) => /Deliverable 1 \(Part 2\)/.test(i.title));
  assert.equal(d1p2.dueAt, "2026-10-29T03:59:00.000Z"); // Oct 28 23:59 EDT
  assert.equal(d1p2.weight, 7);
  const d2 = items.find((i) => /Deliverable 2/.test(i.title));
  assert.equal(d2.dueAt, "2026-11-11T04:59:00.000Z"); // Nov 10 23:59 EST
  assert.equal(d2.weight, 8);
  const vid = items.find((i) => /Short Video/.test(i.title));
  assert.equal(vid.dueAt, "2026-09-21T03:59:00.000Z"); // Sep 20 23:59 EDT
  assert.equal(vid.weight, 3);
  const sched = items.find((i) => /^Find schedule/.test(i.title));
  assert.equal(sched.dueAt, "2026-09-09T12:30:00.000Z");
  assert.equal(sched.confidence, "exact");
  // midterm is TBD -> no item, but the assessment row keeps its weight
  assert.equal(items.filter((i) => i.category === "midterm").length, 0);
  const mrow = course.assessments.find((a) => a.component === "Midterm test");
  assert.equal(mrow.weight, 20);
  assert.equal(mrow.itemId, null);
  // LEC 002: Tue/Thu 14:30 and Wed 16:30 Toronto time
  const classes = items.filter((i) => i.type === "class");
  assert.ok(classes.some((i) => i.startAt === "2026-09-15T18:30:00.000Z")); // Tue 14:30 EDT
  assert.ok(classes.some((i) => i.startAt === "2026-09-16T20:30:00.000Z")); // Wed 16:30 EDT
  // group null -> one pending item per group range
  const { items: g0 } = build("ECE190", { group: null });
  const gp = g0.filter((i) => /Deliverable 1 \(Part 1\)/.test(i.title));
  assert.equal(gp.length, 2);
  assert.ok(gp.every((i) => i.review === "pending"));
  assert.ok(gp.some((i) => i.id.endsWith(":g1-20")) && gp.some((i) => i.id.endsWith(":g21-40")));
});

test("ECE190 office hours: 19 sessions from Sep 15, exclusions honoured", () => {
  const on = build("ECE190", { officeHours: true });
  const oh = on.items.filter((i) => i.category === "office-hours");
  assert.equal(oh.length, 19);
  assert.equal(oh[0].startAt, "2026-09-15T14:30:00.000Z");
  assert.equal(oh[0].location, "EIT 3114");
  for (const excluded of ["2026-10-13", "2026-10-15", "2026-10-22", "2026-10-27", "2026-11-19", "2026-11-24"]) {
    assert.ok(!oh.some((i) => i.startAt.slice(0, 10) === excluded), excluded);
  }
  const off = build("ECE190", { officeHours: false });
  assert.equal(off.items.filter((i) => i.category === "office-hours").length, 0);
});

test("MATH115 TST midterm merges scheme weight", () => {
  const { items, course } = build("MATH115");
  const mid = items.find((i) => i.id === "outline:MATH115:exam:midterm");
  assert.equal(mid.startAt, "2026-10-27T00:00:00.000Z");
  assert.equal(mid.weight, 30);
  assert.equal(mid.review, "auto");
  assert.equal(course.gradingSchemes.length, 2);
});

test("GENE119 seminar classes", () => {
  const { items } = build("GENE119");
  const sems = items.filter((i) => i.type === "class");
  assert.ok(sems.length > 0);
  assert.ok(sems.every((i) => i.category === "seminar"));
  assert.equal(sems[0].startAt, "2026-09-14T14:30:00.000Z"); // Mon 10:30 EDT
});

test("prose hit inside a structured all-day window is a duplicate", () => {
  const synthetic = {
    code: "TEST 100",
    term: 1269,
    title: "Synthetic",
    schedule: [],
    noScheme: false,
    schemes: [{ name: null, rows: [{ component: "Final Exam", dateText: "December 10 - 23", location: "", weight: 50 }] }],
    tables: [],
    text: {
      plan: "",
      assessments:
        "The final exam will be held during the exam period, December 10 - 23.\n" +
        "The final exam ends the exam period on December 23.",
      team: "",
    },
  };
  const { items } = buildOutline(synthetic, {
    now: NOW, url: "u", sections: [], group: null, officeHours: false, readingWeeks: [], textDates: extractDates,
  });
  const finals = items.filter((i) => i.category === "final");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].id, "outline:TEST100:assess:final-exam");
  assert.equal(finals[0].startAt, "2026-12-10T05:00:00.000Z");
  assert.equal(items.filter((i) => i.review === "pending").length, 0);
});

test("assess row: out-of-term year is corrected, uncorrectable is dropped", () => {
  // Live shape (ECE 198, Fall 2026): the assess cell reads "Nov. 23, 25" —
  // a trailing number eaten as a 2-digit year produced Nov 23 2025, a year
  // before the term. The same month/day at the term year lands inside the
  // window, so the year is corrected and marked tentative.
  const synthetic = {
    code: "ECE 198",
    term: 1269,
    title: "Synthetic",
    schedule: [],
    noScheme: false,
    schemes: [
      {
        name: null,
        rows: [
          { component: "Project Symposium Demonstration", dateText: "Nov. 23, 25", location: "In person", weight: 30 },
          { component: "Ghost Deadline", dateText: "Mar. 14, 25", location: "", weight: 10 },
        ],
      },
    ],
    tables: [],
    text: { plan: "", assessments: "", team: "" },
  };
  const { items } = buildOutline(synthetic, {
    now: NOW, url: "u", sections: [], group: null, officeHours: false, readingWeeks: [], textDates: extractDates,
  });
  const symp = items.find((i) => i.id === "outline:ECE198:assess:project-symposium-demonstration");
  assert.ok(symp);
  assert.equal(symp.dueAt, "2026-11-24T04:59:00.000Z"); // Nov 23 2026 23:59 EST
  assert.equal(symp.confidence, "tentative");
  assert.match((symp.meta?.facts || []).map((f) => f.value).join(" "), /year corrected/i);
  // "Mar. 14" lands outside the Fall 2026 window in any candidate year => dropped.
  assert.equal(items.find((i) => i.id === "outline:ECE198:assess:ghost-deadline"), undefined);
});

test("prose: regrade sentences are admin deadlines, not exams", () => {
  const synthetic = {
    code: "TEST 101",
    term: 1269,
    title: "Synthetic",
    schedule: [],
    noScheme: false,
    schemes: [],
    tables: [],
    text: {
      plan: "",
      assessments:
        "Midterm or Final Exam: If you have concerns about the grading of your midterm or final " +
        "exam, please bring them to the attention of your instructor. Students have until " +
        "December 8 at 4:30pm to request a regrade of their midterm.",
      team: "",
    },
  };
  const { items } = buildOutline(synthetic, {
    now: NOW, url: "u", sections: [], group: null, officeHours: false, readingWeeks: [], textDates: extractDates,
  });
  // The "Midterm or Final Exam:" heading must not turn the Dec 8 regrade
  // sentence into an exam.
  assert.equal(items.filter((i) => i.type === "exam").length, 0);
  const re = items.find((i) => i.category === "admin");
  assert.ok(re);
  assert.equal(re.type, "deadline");
  assert.equal(re.title, "Midterm regrade request deadline");
  assert.equal(re.review, "pending");
  assert.equal(re.dueAt, "2026-12-08T21:30:00.000Z"); // 4:30pm EST
});

test("prose: begin statements with no due wording emit nothing", () => {
  const synthetic = {
    code: "TEST 102",
    term: 1269,
    title: "Synthetic",
    schedule: [],
    noScheme: false,
    schemes: [],
    tables: [],
    text: {
      plan: "",
      assessments:
        "Tutorial assignments need to be submitted in the tutorial session. " +
        "Tutorials will begin on September 16 - there are no tutorials before then.",
      team: "",
    },
  };
  const { items } = buildOutline(synthetic, {
    now: NOW, url: "u", sections: [], group: null, officeHours: false, readingWeeks: [], textDates: extractDates,
  });
  assert.equal(items.length, 0);
});

const foldBase = (schemes, assessments) => ({
  code: "TEST 104",
  term: 1269,
  title: "Synthetic",
  schedule: [],
  noScheme: false,
  schemes,
  tables: [],
  text: { plan: "", assessments, team: "" },
});
const foldOpts = {
  now: NOW, url: "u", sections: [], group: null, officeHours: false, readingWeeks: [], textDates: extractDates,
};

test("fold: a same-day prose hit folds into the assess item", () => {
  const d = foldBase(
    [{ name: null, rows: [{ component: "Team Contract", dateText: "October 2", location: "", weight: 5 }] }],
    "Team Contract due October 2 at 11:59pm.",
  );
  const { items } = buildOutline(d, foldOpts);
  const hits = items.filter((i) => /team contract/i.test(i.title));
  assert.equal(hits.length, 1);
  const it = hits[0];
  assert.equal(it.id, "outline:TEST104:assess:team-contract");
  assert.equal(it.dueAt, "2026-10-03T03:59:00.000Z"); // Oct 2 23:59 EDT
  assert.ok(it.details && it.details.includes("Team Contract due October 2 at 11:59pm."));
  assert.equal(it.evidence && it.evidence.snippet, "Team Contract due October 2 at 11:59pm.");
  assert.equal(items.filter((i) => i.id.includes(":text:")).length, 0);
});

test("fold: 'Individual term reflection due' prose folds into its assess item", () => {
  const d = foldBase(
    [{ name: null, rows: [{ component: "Individual Term Reflection", dateText: "December 8", location: "", weight: 10 }] }],
    "Individual term reflection due December 8.",
  );
  const { items } = buildOutline(d, foldOpts);
  const hits = items.filter((i) => /term reflection/i.test(i.title));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "outline:TEST104:assess:individual-term-reflection");
  assert.equal(hits[0].dueAt, "2026-12-09T04:59:00.000Z"); // Dec 8 23:59 EST
  assert.ok(hits[0].details && hits[0].details.includes("Individual term reflection due December 8."));
});

test("fold: the same title on a different day still emits a text item", () => {
  const d = foldBase(
    [{ name: null, rows: [{ component: "Team Contract", dateText: "October 2", location: "", weight: 5 }] }],
    "Team Contract due November 5 at 11:59pm.",
  );
  const { items } = buildOutline(d, foldOpts);
  const hits = items.filter((i) => /team contract/i.test(i.title));
  assert.equal(hits.length, 2);
  assert.ok(hits.some((i) => i.id === "outline:TEST104:assess:team-contract"));
  const text = hits.find((i) => i.id.includes(":text:"));
  assert.ok(text);
  assert.equal(text.dueAt, "2026-11-06T04:59:00.000Z"); // Nov 5 23:59 EST
});

test("fold: a different title on the same day still emits a text item", () => {
  const d = foldBase(
    [{ name: null, rows: [{ component: "Team Contract", dateText: "October 2", location: "", weight: 5 }] }],
    "Project proposal due October 2.",
  );
  const { items } = buildOutline(d, foldOpts);
  assert.equal(items.length, 2);
  const text = items.find((i) => i.id.includes(":text:"));
  assert.ok(text);
  assert.equal(text.title, "Project proposal");
});

test("prose: run-together split + Registrar final window + midterm kept", () => {
  const synthetic = {
    code: "TEST 103",
    term: 1269,
    title: "Synthetic",
    schedule: [],
    noScheme: false,
    schemes: [],
    tables: [],
    text: {
      plan: "",
      assessments:
        "Midterm Exam: The midterm will be written on Monday, October 26 from 8:00pm to 9:30pm. " +
        "More information regarding this exam will appear later in the semester." +
        "Final Exam: A 150 minute (2.5 hour) cumulative final examination will be scheduled by " +
        "the Registrar's Office during the examination period from Thursday, December 10, 2026 " +
        "to Wednesday, December 23, 2026.",
      team: "",
    },
  };
  const { items } = buildOutline(synthetic, {
    now: NOW, url: "u", sections: [], group: null, officeHours: false, readingWeeks: [], textDates: extractDates,
  });
  const mid = items.find((i) => i.category === "midterm");
  assert.ok(mid);
  assert.equal(mid.type, "exam");
  assert.equal(mid.title, "Midterm");
  assert.equal(mid.startAt, "2026-10-27T00:00:00.000Z"); // Mon Oct 26 8:00pm EDT
  assert.equal(mid.endAt, "2026-10-27T01:30:00.000Z");
  // The Registrar sentence names the exam period -> tentative all-day window,
  // not an exact final.
  const fin = items.find((i) => i.category === "final");
  assert.ok(fin);
  assert.equal(fin.title, "Final exam");
  assert.equal(fin.allDay, true);
  assert.equal(fin.confidence, "tentative");
  assert.equal(fin.startAt, "2026-12-10T05:00:00.000Z"); // Dec 10 EST
  assert.equal(fin.endAt, "2026-12-24T05:00:00.000Z"); // Dec 23 inclusive
});

test("office-hours 'starting' year comes from term inference, not the wall clock", () => {
  const synthetic = {
    code: "TEST 200",
    term: null,
    title: "Synthetic",
    schedule: [{ section: "001", kind: "LEC", days: [2], start: "10:00", end: "11:00", location: "", ranges: [["2026-09-08", "2026-12-08"]], dates: [] }],
    schemes: [],
    noScheme: true,
    tables: [],
    text: {
      plan: "",
      assessments: "",
      team: "Office hours (starting Sep 15):\nTuesdays 10am - 11am in EIT 1000",
    },
  };
  // now is months after the term ended; "Sep 15" must still be 2026.
  const { items } = buildOutline(synthetic, {
    now: new Date("2027-02-01T00:00:00Z"), url: "u", sections: ["LEC 001"], group: null,
    officeHours: true, readingWeeks: [], textDates: extractDates,
  });
  const oh = items.filter((i) => i.category === "office-hours");
  assert.ok(oh.length > 0);
  assert.equal(oh[0].startAt, "2026-09-15T14:00:00.000Z"); // Tue Sep 15 2026, 10am EDT
});

test("all expanded item ids are unique", () => {
  const ids = [];
  for (const c of CODES) ids.push(...build(c).items.map((i) => i.id));
  assert.equal(new Set(ids).size, ids.length);
});
