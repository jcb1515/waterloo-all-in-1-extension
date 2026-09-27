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

/** Weekday `dow` (0=Sun) in the current Mon–Sun week at h:m — may be past. */
function thisWeekday(now, dow, h, m = 0) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  const mon = d.getDate() - ((d.getDay() + 6) % 7);
  d.setDate(mon + ((dow + 6) % 7));
  return d.toISOString();
}

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
 * @param {{cal?: string|null, imports?: boolean}} [variants]
 *   cal: "published" | "split" | "error" — calendar feed states for the
 *   options screenshots ("empty"/undefined = never published).
 *   imports: show two imported outline files under Sources.
 */
export function previewState(nowD = new Date(), variants = {}) {
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
    weight: 6,
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
    startAt: dayAt(nowD, 1, 19, 0), // overlaps the WATonomous sync tomorrow
    endAt: dayAt(nowD, 1, 19, 30),
    location: "WaterlooWorks — video call",
    url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/interviews.htm",
    meta: {
      jobId: "408117",
      prep: {
        format: "Video call",
        interviewer: "J. Rivera (hiring manager)",
        jobId: "408117",
        jobTitle: "Hardware Engineer — co-op",
        employer: "Acme Analog",
        instructions: "15-minute screen. Have your transcript and work-term record handy; a link arrives by email 10 minutes before.",
        method: "video",
      },
    },
    seenIn: seen("waterlooworks", "int-acme", "interviews", today),
  });
  add("waterlooworks:int-northwind", {
    source: "waterlooworks",
    type: "interview",
    title: "Northwind Optics — Photonics R&D intern interview",
    org: "Northwind Optics",
    category: "interview",
    startAt: dayAt(nowD, 3, 11, 0),
    endAt: dayAt(nowD, 3, 11, 45),
    location: "TC 2218",
    url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/interviews.htm",
    meta: {
      jobId: "407890",
      prep: {
        format: "In person",
        interviewer: "Panel (2 interviewers)",
        jobId: "407890",
        jobTitle: "Photonics R&D Intern",
        employer: "Northwind Optics",
        instructions: "Check in at the Tatham Centre desk 10 minutes early.",
      },
    },
    seenIn: seen("waterlooworks", "int-northwind", "interviews", today),
  });
  add("waterlooworks:rank-granite", {
    source: "waterlooworks",
    type: "offer-deadline",
    title: "Granite Peak Systems — rank match closes",
    org: "Granite Peak Systems",
    dueAt: dayAt(nowD, 4, 23, 59),
    url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/rankings.htm",
    seenIn: seen("waterlooworks", "rank-granite", "applications", today),
  });
  add("discord:wato-electrical-sync", {
    source: "discord",
    type: "meeting",
    title: "WATonomous — Electrical sync",
    org: "WATonomous",
    startAt: dayAt(nowD, 1, 19, 0),
    endAt: dayAt(nowD, 1, 19, 45),
    location: "#electrical",
    confidence: "exact",
    seenIn: seen("discord", "wato-sync", "channel:electrical", today),
  });
  add("portal:exams:MATH117", {
    source: "portal",
    type: "exam",
    category: "final",
    title: "Final exam",
    org: "MATH 117",
    startAt: dayAt(nowD, 5, 19, 30),
    endAt: dayAt(nowD, 5, 22, 0),
    location: "PAC 1-12",
    confidence: "exact",
    review: "auto",
    seenIn: seen("portal", "exams:MATH117", "portal:exams", today),
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

  // Crunch day: three weighted deliverables inside 24 h.
  add("learn:math115-asn5", {
    source: "learn",
    type: "deadline",
    title: "Assignment 5",
    org: "MATH 115",
    dueAt: dayAt(nowD, 2, 23, 59),
    weight: 8,
    url: "https://learn.uwaterloo.ca/d2l/home/107",
    seenIn: seen("learn", "math115-asn5", "dropbox", today),
  });
  add("learn:ece198-lab4", {
    source: "learn",
    type: "deadline",
    title: "Lab 4 report",
    org: "ECE 198",
    dueAt: dayAt(nowD, 2, 18, 0),
    weight: 10,
    url: "https://learn.uwaterloo.ca/d2l/home/105",
    seenIn: seen("learn", "ece198-lab4", "dropbox", today),
  });

  // A full week of LEC/TUT/LAB meetings so the Calendar views are populated.
  // [org, kind, dow (0=Sun), start h:m, length (min), room, this week's topic]
  /** @type {[string, string, number, number, number, number, string, string | null][]} */
  const classes = [
    ["MATH 117", "LEC", 1, 13, 30, 50, "MC 4021", "Integration by parts"],
    ["MATH 117", "LEC", 3, 13, 30, 50, "MC 4021", "The substitution rule"],
    ["MATH 117", "TUT", 2, 8, 30, 50, "MC 5479", null],
    ["MATH 115", "LEC", 2, 10, 0, 80, "RCH 305", "Eigenvalues"],
    ["MATH 115", "LEC", 4, 10, 0, 80, "RCH 305", "Diagonalization"],
    ["ECE 105", "LEC", 1, 9, 30, 50, "E7 5343", "Phasor analysis"],
    ["ECE 105", "LEC", 3, 9, 30, 50, "E7 5343", "AC power"],
    ["ECE 105", "LEC", 5, 9, 30, 50, "E7 5343", "Magnetic circuits"],
    ["ECE 105", "LAB", 4, 14, 30, 110, "E2 2363", null],
    ["ECE 150", "LEC", 2, 13, 0, 80, "STC 0060", "Linked structures"],
    ["ECE 150", "LEC", 4, 13, 0, 80, "STC 0060", "Recursion"],
    ["ECE 150", "LAB", 3, 8, 30, 110, "E5 6008", null],
    ["ECE 198", "LEC", 1, 10, 30, 80, "E7 2403", "Team standup"],
    ["ENGL 192", "LEC", 5, 10, 30, 80, "HH 1102", "Memo workshop"],
  ];
  for (const [org, kind, dow, h, m, dur, room, topic] of classes) {
    const type = kind === "LEC" ? "class" : kind === "TUT" ? "tutorial" : "lab";
    const slug = `${org.replace(/\s+/g, "").toLowerCase()}-${kind.toLowerCase()}`;
    add(`learn:${slug}-w${dow}`, {
      source: "learn",
      type,
      title: `${org} ${kind}`,
      org,
      startAt: thisWeekday(nowD, dow, h, m),
      endAt: thisWeekday(nowD, dow, h, m + dur),
      location: room,
      details: topic || undefined,
      url: "https://learn.uwaterloo.ca/d2l/home",
      seenIn: seen("learn", `${slug}-w${dow}`, "calendar", today),
    });
  }

  // Pending review: a Learn announcement date and a WaterlooWorks message
  // date. They wait in the Review view and stay out of the agenda.
  add("learn:ece105-news-quiz4", {
    source: "learn",
    type: "quiz",
    title: "Quiz 4 — moved up",
    org: "ECE 105",
    dueAt: nextWeekday(nowD, 5, 23, 59), // Friday 11:59 PM
    confidence: "tentative",
    review: "pending",
    url: "https://learn.uwaterloo.ca/d2l/le/news/102/555/view",
    evidence: {
      snippet: "Reminder: Quiz 4 is moved up — it closes Friday at 11:59 PM, not Sunday.",
      url: "https://learn.uwaterloo.ca/d2l/le/news/102/555/view",
      method: "text",
    },
    seenIn: seen("learn", "102:news:555", "102:news", today),
  });
  add("waterlooworks:msg-acme-window", {
    source: "waterlooworks",
    type: "deadline",
    title: "Acme Analog — confirm interview slot",
    org: "Acme Analog",
    dueAt: dayAt(nowD, 1, 17, 0), // tomorrow 5 PM
    confidence: "tentative",
    review: "pending",
    evidence: {
      snippet: "Please confirm your interview slot by tomorrow at 5 PM.",
      method: "text",
    },
    seenIn: seen("waterlooworks", "msg:99", "messages", today),
  });
  add("learn:engl192-old-news", {
    source: "learn",
    type: "event",
    title: "Library orientation replay",
    org: "ENGL 192",
    startAt: dayAt(nowD, -4, 14, 0),
    confidence: "tentative",
    review: "pending",
    evidence: {
      snippet: "The library orientation replay ran last week at 2 PM.",
      method: "text",
    },
    seenIn: seen("learn", "106:news:12", "106:news", today),
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
    portal: {
      lastRunAt: iso(now - 45 * MIN),
      lastOkAt: iso(now - 45 * MIN),
      session: "signed-in",
      error: null,
      complete: true,
      failures: 0,
      itemCount: 24,
      state: {},
    },
    discord: {
      lastRunAt: iso(now - 20 * MIN),
      lastOkAt: iso(now - 20 * MIN),
      session: "signed-in",
      error: null,
      complete: false,
      failures: 0,
      itemCount: 3,
      state: {
        guilds: {
          "9102": { name: "WATonomous", unread: 0, mentions: 0, channels: {} },
          "8804": { name: "ECE 2027", unread: 1, mentions: 0, channels: {} },
        },
        sweep: { startedAt: iso(now - 2 * DAY), done: { "9911": iso(now - DAY) } },
        sweepQueue: [
          { guildId: "9102", guildName: "WATonomous", channelId: "9912", name: "electrical", url: "https://discord.com/channels/9102/9912" },
          { guildId: "9102", guildName: "WATonomous", channelId: "9913", name: "meetings", url: "https://discord.com/channels/9102/9913" },
          { guildId: "8804", guildName: "ECE 2027", channelId: "9814", name: "announcements", url: "https://discord.com/channels/8804/9814" },
        ],
        unreadWatched: [
          { guildId: "9102", guildName: "WATonomous", channelId: "9915", name: "general", url: "https://discord.com/channels/9102/9915", mentions: 0 },
          { guildId: "8804", guildName: "ECE 2027", channelId: "9816", name: "labs", url: "https://discord.com/channels/8804/9816", mentions: 1 },
        ],
        unreadGuilds: [{ guildId: "8804", name: "ECE 2027", mentions: 0 }],
      },
    },
  };

  const courses = {
    "MATH 117": {
      code: "MATH 117",
      name: "Calculus 1",
      term: 1269,
      sections: ["LEC 002", "TUT 104"],
      learnOrgUnitId: 101,
      outlineUrl: "https://outline.uwaterloo.ca/viewer/npch7t",
      weights: [
        { component: "Assignments", weight: 20 },
        { component: "Quizzes", weight: 10 },
        { component: "Midterm", weight: 30 },
        { component: "Final exam", weight: 40 },
      ],
      grades: [
        { component: "Assignments", points: 17, max: 20 },
        { component: "Quizzes", points: 8, max: 10 },
        { component: "Midterm", points: 24, max: 30 },
      ],
      assessments: [
        { component: "Assignments", weight: 20, dateText: "Weekly, Fri 11:59 PM", itemId: null, from: "table" },
        { component: "Quizzes", weight: 10, dateText: "Alternate Fridays", itemId: null, from: "table" },
        { component: "Midterm", weight: 30, dateText: "Thu, 4:30–6:20 PM", itemId: "outline:math117-midterm", from: "table" },
        { component: "Final exam", weight: 40, dateText: "Dec exam window", itemId: null, from: "chart" },
      ],
      officeHours: "Mon/Wed 3:30–4:20 PM · MC 5417",
    },
    "MATH 115": {
      code: "MATH 115",
      name: "Linear Algebra",
      term: 1269,
      sections: ["LEC 005"],
      learnOrgUnitId: 107,
      weights: [
        { component: "Assignments", weight: 25 },
        { component: "Midterm", weight: 25 },
        { component: "Final exam", weight: 50 },
      ],
      assessments: [
        { component: "Assignments", weight: 25, dateText: "Weekly", itemId: null, from: "table" },
        { component: "Midterm", weight: 25, dateText: "TBD", itemId: null, from: "table" },
        { component: "Final exam", weight: 50, dateText: "Dec exam window", itemId: null, from: "table" },
      ],
    },
    "ECE 105": {
      code: "ECE 105",
      name: "Electrical and Computer Engineering",
      term: 1269,
      sections: ["LEC 001", "LAB 211"],
      learnOrgUnitId: 102,
      weights: [
        { component: "Quizzes", weight: 15 },
        { component: "Labs", weight: 15 },
        { component: "Midterm", weight: 25 },
        { component: "Final exam", weight: 45 },
      ],
      assessments: [
        { component: "Quizzes", weight: 15, dateText: "Biweekly, Fri 11:59 PM", itemId: "learn:ece105-quiz3", from: "table" },
        { component: "Labs", weight: 15, dateText: "Alternate Thu", itemId: null, from: "table" },
        { component: "Midterm", weight: 25, dateText: "TBD", itemId: null, from: "table" },
        { component: "Final exam", weight: 45, dateText: "Dec exam window", itemId: null, from: "table" },
      ],
    },
    "ECE 150": {
      code: "ECE 150",
      name: "Fundamentals of Programming",
      term: 1269,
      sections: ["LEC 001", "LAB 203"],
      learnOrgUnitId: 103,
      weights: [
        { component: "Project", weight: 25 },
        { component: "Assignments", weight: 20 },
        { component: "Midterm", weight: 20 },
        { component: "Final exam", weight: 35 },
      ],
      grades: [{ component: "Assignments", points: 44, max: 50 }],
      gradingSchemes: [
        {
          name: "Standard",
          rows: [
            { component: "Project", weight: 25, dateText: "Milestones", location: "" },
            { component: "Assignments", weight: 20, dateText: "Biweekly", location: "" },
            { component: "Midterm", weight: 20, dateText: "Week 7", location: "" },
            { component: "Final exam", weight: 35, dateText: "Dec exam window", location: "" },
          ],
        },
        {
          name: "Final-heavy",
          rows: [
            { component: "Project", weight: 25, dateText: "Milestones", location: "" },
            { component: "Assignments", weight: 20, dateText: "Biweekly", location: "" },
            { component: "Final exam", weight: 55, dateText: "Dec exam window", location: "" },
          ],
        },
      ],
      assessments: [
        { component: "Project", weight: 25, dateText: "Milestones", itemId: "learn:ece150-project1", from: "table" },
        { component: "Assignments", weight: 20, dateText: "Biweekly", itemId: null, from: "table" },
        { component: "Midterm", weight: 20, dateText: "Week 7", itemId: null, from: "table" },
        { component: "Final exam", weight: 35, dateText: "Dec exam window", itemId: null, from: "table" },
      ],
    },
    "ECE 190": {
      code: "ECE 190",
      name: "Engineering Profession and Practice",
      term: 1269,
      sections: ["LEC 003"],
      group: "5",
      learnOrgUnitId: 104,
      weights: [
        { component: "Deliverables", weight: 60 },
        { component: "Midterm test", weight: 20 },
        { component: "Final reflection", weight: 20 },
      ],
      assessments: [
        { component: "Deliverable 1", weight: 20, dateText: "Wed 11:59 PM", itemId: "learn:ece190-deliverable1", from: "table" },
        { component: "Midterm test", weight: 20, dateText: "TBD", itemId: "outline:ece190-midterm", from: "table" },
        { component: "Final reflection", weight: 20, dateText: "Last week", itemId: null, from: "table" },
      ],
    },
    "ECE 198": {
      code: "ECE 198",
      name: "Project Studio",
      term: 1269,
      sections: ["LEC 010"],
      learnOrgUnitId: 105,
      syllabusUrls: [{ title: "Studio syllabus", url: "https://learn.uwaterloo.ca/d2l/home/105" }],
      weights: [
        { component: "Lab reports", weight: 50 },
        { component: "Studio participation", weight: 20 },
        { component: "Final demo", weight: 30 },
      ],
    },
    "ENGL 192": {
      code: "ENGL 192",
      name: "Communication in Engineering",
      term: 1269,
      sections: ["LEC 081"],
      learnOrgUnitId: 106,
      weights: [
        { component: "Worksheets", weight: 30 },
        { component: "Memo report", weight: 30 },
        { component: "Final portfolio", weight: 40 },
      ],
    },
  };

  // Six applications across every status group, each with a change history.
  const applications = {
    "waterlooworks:408117": {
      id: "waterlooworks:408117",
      employer: "Acme Analog",
      jobTitle: "Hardware Engineer — co-op",
      jobId: "408117",
      cycle: "Winter 2027 main round",
      status: "interview-scheduled",
      url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/jobs/408117",
      history: [
        { status: "applied", at: iso(now - 9 * DAY) },
        { status: "selected-for-interview", at: iso(now - 3 * DAY) },
        { status: "interview-scheduled", at: iso(now - DAY) },
      ],
      itemIds: ["waterlooworks:int-acme"],
    },
    "waterlooworks:407890": {
      id: "waterlooworks:407890",
      employer: "Northwind Optics",
      jobTitle: "Photonics R&D Intern",
      jobId: "407890",
      cycle: "Winter 2027 main round",
      status: "selected-for-interview",
      url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/jobs/407890",
      history: [
        { status: "applied", at: iso(now - 8 * DAY) },
        { status: "selected-for-interview", at: iso(now - 2 * DAY) },
      ],
      itemIds: ["waterlooworks:int-northwind"],
    },
    "waterlooworks:405512": {
      id: "waterlooworks:405512",
      employer: "Blueleaf Robotics",
      jobTitle: "Embedded Software Co-op",
      jobId: "405512",
      cycle: "Winter 2027 main round",
      status: "applied",
      url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/jobs/405512",
      history: [{ status: "applied", at: iso(now - 12 * HOUR) }],
      itemIds: [],
    },
    "waterlooworks:403388": {
      id: "waterlooworks:403388",
      employer: "Riverline Software",
      jobTitle: "QA Analyst",
      jobId: "403388",
      cycle: "Winter 2027 main round",
      status: "applied",
      url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/jobs/403388",
      history: [{ status: "applied", at: iso(now - 6 * DAY) }],
      itemIds: [],
    },
    "waterlooworks:401771": {
      id: "waterlooworks:401771",
      employer: "Granite Peak Systems",
      jobTitle: "FPGA Design Co-op",
      jobId: "401771",
      cycle: "Winter 2027 main round",
      status: "ranked",
      url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/jobs/401771",
      history: [
        { status: "applied", at: iso(now - 12 * DAY) },
        { status: "interview-scheduled", at: iso(now - 5 * DAY) },
        { status: "ranked", at: iso(now - 8 * HOUR) },
      ],
      itemIds: ["waterlooworks:rank-granite"],
    },
    "waterlooworks:399560": {
      id: "waterlooworks:399560",
      employer: "Heliotrope Health",
      jobTitle: "Software Engineering Intern",
      jobId: "399560",
      cycle: "Winter 2027 main round",
      status: "not-selected",
      url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/jobs/399560",
      history: [
        { status: "applied", at: iso(now - 14 * DAY) },
        { status: "not-selected", at: iso(now - 2 * DAY) },
      ],
      itemIds: [],
    },
  };

  const published = variants.cal === "published" || variants.cal === "split" || variants.cal === "error";
  const settings = {
    theme: "system",
    density: "comfortable",
    termCode: 1269,
    agenda: { showClasses: "today" },
    sources: {
      discord: {
        enabled: true,
        watched: { WATonomous: { focus: ["electrical"], channels: [] }, "ECE 2027": { focus: [], channels: [] } },
        userId: "416820311045488640",
        roleIds: ["8804112233", "9102445566"],
        keywords: ["standup", "retro"],
      },
    },
    calendar: {
      enabled: published,
      serviceUrl: published ? "https://waterloo-all-in-1-feed.example.workers.dev" : "",
      split: variants.cal === "split",
      include: { classes: true, tentative: true, completed: true, termDates: true },
      alarms: false,
    },
  };

  const calendarFeed = published
    ? {
        serviceUrl: "https://waterloo-all-in-1-feed.example.workers.dev",
        feedId: "fx4k9m2p",
        feedUrl:
          "https://waterloo-all-in-1-feed.example.workers.dev/v1/calendars/xk7p4m2q9f3h8j2w5n6r.ics",
        groupFeeds: {
          classes: { feedId: "cl7a2f9k4m8p3x6w1q5e", feedUrl: "https://waterloo-all-in-1-feed.example.workers.dev/v1/calendars/cl7a2f9k4m8p3x6w1q5e.ics" },
          deadlines: { feedId: "de2r6t8y1u4i7o9p3a5s", feedUrl: "https://waterloo-all-in-1-feed.example.workers.dev/v1/calendars/de2r6t8y1u4i7o9p3a5s.ics" },
          coop: { feedId: "co9p3e7r2v6x1m5k8j4h", feedUrl: "https://waterloo-all-in-1-feed.example.workers.dev/v1/calendars/co9p3e7r2v6x1m5k8j4h.ics" },
          teams: { feedId: "te4a8m1s6f9q2w7x3z5n", feedUrl: "https://waterloo-all-in-1-feed.example.workers.dev/v1/calendars/te4a8m1s6f9q2w7x3z5n.ics" },
          other: { feedId: "ot8h3e6r1c4v9b2n7m5k", feedUrl: "https://waterloo-all-in-1-feed.example.workers.dev/v1/calendars/ot8h3e6r1c4v9b2n7m5k.ics" },
        },
        lastPublishedAt: iso(now - 3 * MIN),
        lastPayloadHash: "9f3e2c1a",
        eventCount: 142,
        accepted: 140,
        skipped: [
          { id: "manual:adhoc-1", reason: "no valid date" },
          { id: "manual:adhoc-2", reason: "no valid date" },
        ],
        expiresAt: iso(now + 365 * DAY),
        status: variants.cal === "error" ? "error" : "ok",
        error:
          variants.cal === "error"
            ? "Feed server error 500"
            : null,
        needsResubscribe: variants.cal === "error",
        retryAt: variants.cal === "error" ? iso(now + 15 * MIN) : null,
        failures: variants.cal === "error" ? 2 : 0,
      }
    : null;

  const outlineFiles = variants.imports
    ? [
        {
          id: "m1k2j3-x4y5z6",
          name: "ECE 105 Outline — Winter 2027.html",
          kind: "html",
          size: 184_320,
          addedAt: iso(now - 2 * DAY),
        },
        {
          id: "n7p8q9-a1b2c3",
          name: "MATH 117 course outline.pdf",
          kind: "pdf",
          size: 96_214,
          addedAt: iso(now - 6 * HOUR),
          text: "MATH 117 Calculus 1 — extracted text (preview fixture)",
        },
        {
          id: "p4r5s6-t7u8v9",
          name: "ENGL 192 syllabus.pdf",
          kind: "pdf",
          size: 61_802,
          addedAt: iso(now - 30 * MIN),
          textError: true, // extraction failed — the row shows "Couldn't read this PDF"
        },
      ]
    : [];

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

  // The updates feed: one of each kind, newest first. updatesSeenAt leaves
  // the newest two unread so the bell badge shows a count.
  const updates = [
    {
      id: "u1",
      at: iso(now - 30 * MIN),
      source: "learn",
      kind: "new",
      text: "New: Quiz #3 — DC circuits",
      refId: "learn:ece105-quiz3",
    },
    {
      id: "u2",
      at: iso(now - 3 * HOUR),
      source: "learn",
      kind: "moved",
      text: "Moved: Project 1 — Battleship milestone",
      refId: "learn:ece150-project1",
    },
    {
      id: "u3",
      at: iso(now - 5 * HOUR),
      source: "waterlooworks",
      kind: "status",
      text: "Acme Analog — Hardware Engineer: applied → selected for interview",
      refId: "waterlooworks:int-acme",
    },
    {
      id: "u4",
      at: iso(now - DAY),
      source: "learn",
      kind: "review",
      text: "Found a date in an ECE 105 announcement — review it",
      refId: "learn:ece105-news-quiz4",
    },
    {
      id: "u4b",
      at: iso(now - 26 * HOUR),
      source: "outline",
      kind: "review",
      text: "Portal lists ECE 105 LEC 002, TUT 103 but your profile says LEC 001, TUT 101; using Portal's.",
    },
    {
      id: "u5",
      at: iso(now - 2 * DAY),
      source: "learn",
      kind: "cancelled",
      text: "Removed: ENGL 192 participation check",
      refId: "learn:engl192-worksheet",
    },
    {
      id: "u6",
      at: iso(now - 3 * DAY),
      source: "waterlooworks",
      kind: "new",
      text: "New application tracked: Northwind Optics — Photonics intern",
    },
  ];
  const updatesSeenAt = iso(now - 4 * HOUR);

  return { items, userState, sourceState, courses, applications, terms: {}, settings, discovery, calendarFeed, outlineFiles, updates, updatesSeenAt };
}
