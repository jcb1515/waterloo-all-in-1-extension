// @ts-check
/*
  Preview fixtures for the panel and options screenshots — a realistic slice
  of the merged store, anchored relative to "now" so it always looks current.
  Open src/panel/panel.html?preview=1 (or load it where chrome.storage is
  unavailable) to render these.
*/

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

/** @param {Date} base @param {number} h @param {number} [m] */
const at = (base, h, m = 0) =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m).toISOString();

/** Calendar-day anchor: `dayOffset` days from `base`, at local h:m — so due
 * times stay realistic (11:59 PM deadlines, not "1:33 AM"). */
const dayAt = (base, dayOffset, h, m = 0) =>
  at(new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset), h, m);

/** Next occurrence of weekday `dow` (0=Sun) at h:m, strictly after `now`. */
function nextWeekday(now, dow, h, m = 0) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  let delta = (dow - d.getDay() + 7) % 7;
  if (delta === 0 && d.getTime() <= now.getTime()) delta = 7;
  d.setDate(d.getDate() + delta);
  return d.toISOString();
}

const iso = (ms) => new Date(ms).toISOString();
const seen = (source, key, scope, at) => [{ source, key, scope, at }];

/**
 * @param {Date} [nowD]
 */
export function previewState(nowD = new Date()) {
  const now = nowD.getTime();
  const today = at(nowD, 12, 30);

  /** @type {Record<string, any>} */
  const items = {};
  const add = (id, fields) => {
    items[id] = {
      id,
      status: "open",
      confidence: "exact",
      review: "auto",
      ...fields,
    };
  };

  // Today — classes + a deadline under 3h away.
  add("learn:math117-lec-today", {
    source: "learn",
    type: "class",
    title: "MATH 117 Lecture",
    org: "MATH 117",
    startAt: at(nowD, 12, 30),
    endAt: at(nowD, 13, 20),
    location: "PSE 5353",
    url: "https://learn.uwaterloo.ca/d2l/home/101",
    seenIn: seen("learn", "math117-lec-today", "calendar", today),
  });
  add("learn:ece105-lec-today", {
    source: "learn",
    type: "class",
    title: "ECE 105 Lecture",
    org: "ECE 105",
    startAt: at(nowD, 15, 30),
    endAt: at(nowD, 16, 20),
    location: "E7 5343",
    url: "https://learn.uwaterloo.ca/d2l/home/102",
    seenIn: seen("learn", "ece105-lec-today", "calendar", today),
  });
  add("learn:engl192-worksheet", {
    source: "learn",
    type: "deadline",
    title: "Reading response worksheet",
    org: "ENGL 192",
    dueAt: dayAt(nowD, -2, 23, 59),
    url: "https://learn.uwaterloo.ca/d2l/home/106",
    seenIn: seen("learn", "engl192-worksheet", "dropbox", today),
  });
  add("learn:ece105-quiz3", {
    source: "learn",
    type: "quiz",
    title: "Quiz #3 — DC circuits",
    org: "ECE 105",
    dueAt: nextWeekday(nowD, 5, 23, 59), // Friday
    weight: 4,
    url: "https://learn.uwaterloo.ca/d2l/home/102",
    seenIn: seen("learn", "ece105-quiz3", "quizzes", today),
  });
  add("learn:ece190-deliverable1", {
    source: "learn",
    type: "deadline",
    title: "Deliverable 1 (Part 1)",
    org: "ECE 190",
    dueAt: dayAt(nowD, 2, 23, 59),
    weight: 8,
    group: "5",
    url: "https://learn.uwaterloo.ca/d2l/home/104",
    seenIn: seen("learn", "ece190-deliverable1", "dropbox", today),
  });
  add("outline:math117-midterm", {
    source: "outline",
    type: "exam",
    title: "MATH 117 Midterm",
    org: "MATH 117",
    startAt: nextWeekday(nowD, 4, 16, 30), // Thursday 4:30 PM
    endAt: nextWeekday(nowD, 4, 18, 20),
    weight: 33,
    location: "MC 4021",
    seenIn: seen("outline", "math117-midterm", "assessments", today),
  });
  add("learn:ece150-project1", {
    source: "learn",
    type: "deadline",
    title: "Project 1 — Battleship milestone",
    org: "ECE 150",
    dueAt: dayAt(nowD, 5, 22, 0),
    weight: 12,
    url: "https://learn.uwaterloo.ca/d2l/home/103",
    moved: { from: dayAt(nowD, 4, 22, 0), at: iso(now - DAY) },
    seenIn: seen("learn", "ece150-project1", "dropbox", today),
  });
  add("outline:ece190-midterm", {
    source: "outline",
    type: "exam",
    title: "ECE 190 Midterm test",
    org: "ECE 190",
    dueAt: dayAt(nowD, 8, 23, 59),
    weight: 20,
    confidence: "tentative",
    details: "Date TBD on the course outline — confirm on Learn.",
    seenIn: seen("outline", "ece190-midterm", "assessments", today),
  });
  add("waterlooworks:int-acme", {
    source: "waterlooworks",
    type: "interview",
    title: "Acme Analog — Hardware Engineer co-op interview",
    org: "Acme Analog",
    category: "interview",
    startAt: (() => {
      const d = new Date(nowD.getFullYear(), 9, 2, 16, 0); // Oct 2, 4:00 PM
      if (d.getTime() <= now) d.setFullYear(d.getFullYear() + 1);
      return d.toISOString();
    })(),
    location: "WaterlooWorks — video call",
    seenIn: seen("waterlooworks", "int-acme", "interviews", today),
  });
  add("discord:wato-electrical-sync", {
    source: "discord",
    type: "meeting",
    title: "WATonomous — Electrical sync",
    org: "WATonomous",
    startAt: dayAt(nowD, 1, 19, 0),
    endAt: dayAt(nowD, 1, 19, 45),
    location: "#electrical",
    confidence: "tentative",
    seenIn: seen("discord", "wato-sync", "channel:electrical", today),
  });
  add("learn:ece198-lab3", {
    source: "learn",
    type: "deadline",
    title: "Lab 3 report",
    org: "ECE 198",
    dueAt: dayAt(nowD, -2, 23, 59),
    status: "submitted",
    url: "https://learn.uwaterloo.ca/d2l/home/105",
    seenIn: seen("learn", "ece198-lab3", "dropbox", today),
  });
  add("learn:math115-asn4", {
    source: "learn",
    type: "deadline",
    title: "Assignment 4",
    org: "MATH 115",
    dueAt: dayAt(nowD, -3, 23, 59),
    seenIn: seen("learn", "math115-asn4", "dropbox", today),
  });

  const userState = {
    "learn:math115-asn4": { done: true, doneAt: iso(now - 30 * HOUR) },
  };

  const sourceState = {
    learn: {
      lastRunAt: iso(now - 4 * MIN),
      lastOkAt: iso(now - 4 * MIN),
      session: "signed-in",
      error: null,
      complete: true,
      failures: 0,
      itemCount: 9,
    },
    waterlooworks: {
      lastRunAt: iso(now - 2 * HOUR),
      lastOkAt: iso(now - 2 * HOUR),
      session: "signed-in",
      error: null,
      complete: true,
      failures: 0,
      itemCount: 1,
    },
    // Portal is "soon"-stage and has never run: no sourceState entry, so the
    // card shows neither a synced line nor Clear data.
  };

  const courses = {
    "MATH 117": { code: "MATH 117", name: "Calculus 1", term: 1269 },
    "MATH 115": { code: "MATH 115", name: "Linear Algebra", term: 1269 },
    "ECE 105": { code: "ECE 105", name: "Electrical and Computer Engineering", term: 1269 },
    "ECE 150": { code: "ECE 150", name: "Fundamentals of Programming", term: 1269 },
    "ECE 190": { code: "ECE 190", name: "Engineering Profession and Practice", term: 1269 },
    "ECE 198": { code: "ECE 198", name: "Project Studio", term: 1269 },
    "ENGL 192": { code: "ENGL 192", name: "Communication in Engineering", term: 1269 },
  };

  const settings = {
    theme: "system",
    density: "comfortable",
    termCode: 1269,
    agenda: { showClasses: "today" },
    sources: {},
  };

  const discovery = {
    learn: {
      updatedAt: iso(now - 30 * MIN),
      net: { "GET /d2l/api/* 200": {}, "GET /d2l/le/* 200": {}, "GET /home 200": {} },
      pages: { "/d2l/home": {}, "/d2l/lms/dropbox": {} },
    },
    outline: {
      updatedAt: iso(now - 2 * DAY),
      net: { "GET /viewer/view/* 200": {} },
      pages: { "/viewer/view/npch7t": {} },
    },
    waterlooworks: {
      updatedAt: iso(now - 2 * HOUR),
      net: { "GET /api/interviews 200": {}, "GET /api/applications 200": {} },
      pages: {},
    },
  };

  return { items, userState, sourceState, courses, applications: {}, terms: {}, settings, discovery };
}
