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

import { deriveTodos } from "../core/todos.js";

const iso = (ms) => new Date(ms).toISOString();
const seen = (source, key, scope, at) => [{ source, key, scope, at }];

/**
 * @param {Date} [nowD]
 * @param {{cal?: string|null, imports?: boolean, mailscan?: boolean}} [variants]
 *   cal: "published" | "split" | "error" — calendar feed states for the
 *   options screenshots ("empty"/undefined = never published).
 *   imports: show two imported outline files under Sources.
 *   mailscan: an in-progress guided Gmail scan on the Email source card.
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
    details: "30 minutes, on Learn. Closed book; one formula sheet allowed.",
    meta: {
      facts: [
        { label: "Coverage", value: "Ch. 3–4: Thevenin, superposition" },
        { label: "Attempts", value: "2, best counts" },
      ],
    },
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
  add("gmail:invite:k7:evt", {
    source: "gmail",
    type: "meeting",
    title: "Robotics design review",
    startAt: dayAt(nowD, 2, 18, 0),
    endAt: dayAt(nowD, 2, 19, 0),
    location: "https://meet.google.com/abc-defg-hij",
    url: "https://mail.google.com/mail/u/0/#inbox/thread-abc123",
    meta: {
      provider: "gmail",
      onCalendar: "google", // Google already put the invite on the calendar
      facts: [
        { label: "Organizer", value: "Jane Student" },
        { label: "Join", value: "meet.google.com/abc-defg-hij" },
      ],
    },
    seenIn: seen("gmail", "invite:k7", "email:gmail:thread-abc123", today),
  });
  add("outlook:mail:k41:offer", {
    source: "outlook",
    type: "offer-deadline",
    title: "Acme Analog — Hardware Engineer offer deadline",
    org: "Acme Analog",
    dueAt: dayAt(nowD, 4, 23, 59),
    confidence: "tentative",
    url: "https://outlook.office.com/mail/inbox/id/k41",
    evidence: {
      method: "text",
      snippet: "Your offer for Hardware Engineer — co-op expires this Friday.",
      url: "https://outlook.office.com/mail/inbox/id/k41",
    },
    meta: {
      provider: "outlook",
      employer: "acmeanalog",
      applicationId: "waterlooworks:408117",
      facts: [{ label: "From", value: "Talent Team" }],
    },
    seenIn: seen("outlook", "mail:k41", "email:outlook:k41", today),
  });
  add("discord:wato-electrical-sync", {
    source: "discord",
    type: "meeting",
    title: "Electrical sync (weekly)",
    org: "WATonomous",
    startAt: dayAt(nowD, 1, 19, 0),
    endAt: dayAt(nowD, 1, 19, 45),
    location: "#electrical",
    confidence: "exact",
    meta: {
      guildId: "9102",
      channelId: "9912",
      recurrence: { freq: "WEEKLY", byDay: "MO", time: "19:00", tz: "America/Toronto", weeks: 4 },
      facts: [
        { label: "Server", value: "WATonomous" },
        { label: "Pattern", value: "Weekly, Mon 19:00" },
      ],
    },
    seenIn: seen("discord", "wato-sync", "channel:electrical", today),
  });
  add("discord:wato-pcb-review", {
    source: "discord",
    type: "task",
    title: "Review the power board schematic",
    org: "WATonomous",
    dueAt: dayAt(nowD, 2, 23, 59),
    meta: {
      guildId: "9102",
      channelId: "9912",
      assignedToMe: true,
      facts: [{ label: "Assigned to you", value: "Yes" }],
    },
    url: "https://discord.com/channels/9102/9912/88214",
    seenIn: seen("discord", "wato-pcb", "channel:electrical", today),
  });
  add("discord:wato-firmware-deadline", {
    source: "discord",
    type: "deadline",
    title: "Firmware freeze for demo day",
    org: "WATonomous",
    dueAt: dayAt(nowD, 5, 20, 0),
    url: "https://discord.com/channels/9102/9912/88310",
    seenIn: seen("discord", "wato-freeze", "channel:electrical", today),
  });
  add("discord:wato-standup-pending", {
    source: "discord",
    type: "meeting",
    title: "Standup (weekly)",
    org: "WATonomous",
    startAt: nextWeekday(nowD, 4, 9, 30),
    endAt: nextWeekday(nowD, 4, 9, 45),
    confidence: "tentative",
    review: "pending",
    meta: {
      guildId: "9102",
      recurrence: { freq: "WEEKLY", byDay: "TH", time: "09:30", tz: "America/Toronto", weeks: 3 },
      facts: [{ label: "Pattern", value: "Weekly, Thu 09:30" }],
    },
    seenIn: seen("discord", "wato-standup", "channel:general", today),
  });
  add("discord:ece2027-design-review", {
    source: "discord",
    type: "meeting",
    title: "ECE 2027 — design review",
    org: "ECE 2027",
    startAt: dayAt(nowD, 3, 17, 0),
    endAt: dayAt(nowD, 3, 18, 0),
    location: "#meetings",
    confidence: "exact",
    meta: { guildId: "8804", channelId: "9913" },
    url: "https://discord.com/channels/8804/9913/88402",
    seenIn: seen("discord", "ece2027-review", "channel:meetings", today),
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

  add("manual:capstone-demo", {
    source: "manual",
    type: "deadline",
    title: "Capstone demo poster",
    org: "ECE 198",
    dueAt: dayAt(nowD, 6, 23, 59),
    allDay: true,
    confidence: "exact",
    review: "auto",
    evidence: { method: "manual" },
    seenIn: seen("manual", "capstone-demo", "manual", today),
  });

  // ——— To-do fixtures: a timeslot pick, an offer deadline, the rankings
  // deadline, two reply tasks and two manual tasks. ———
  add("waterlooworks:slot-blueleaf", {
    source: "waterlooworks",
    type: "deadline",
    category: "interview-timeslot",
    title: "Pick an interview slot — Blueleaf Robotics",
    org: "Blueleaf Robotics",
    dueAt: dayAt(nowD, 1, 23, 59),
    url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/interviews.htm",
    meta: { jobId: "405512" },
    seenIn: seen("waterlooworks", "slot-405512", "interviews", today),
  });
  add("waterlooworks:offer-copperleaf", {
    source: "waterlooworks",
    type: "offer-deadline",
    title: "Copperleaf Energy — respond to offer",
    org: "Copperleaf Energy",
    dueAt: dayAt(nowD, 2, 23, 59),
    url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/offers.htm",
    meta: { jobId: "405577" },
    seenIn: seen("waterlooworks", "offer-405577", "applications", today),
  });
  add("waterlooworks:cycle-rankings", {
    source: "waterlooworks",
    type: "cycle-date",
    category: "rankings-due",
    title: "Winter 2027 main round: Student rankings due",
    org: "Co-op",
    dueAt: dayAt(nowD, 6, 23, 59),
    url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/coopdates.htm",
    meta: {
      cycle: "Winter 2027 main round",
      facts: [{ label: "Cycle", value: "Winter 2027 main round" }],
    },
    seenIn: seen("waterlooworks", "cycle-rankings", "coopdates", today),
  });
  add("outlook:mail:k52:reply", {
    source: "outlook",
    type: "task",
    category: "reply",
    title: "Reply to Prof. Rivera — midterm conflicts with an interview",
    org: "MATH 117",
    dueAt: dayAt(nowD, 1, 17, 0),
    url: "https://outlook.office.com/mail/inbox/id/k52",
    evidence: {
      method: "text",
      snippet: "Please confirm whether Thursday's midterm conflicts.",
      url: "https://outlook.office.com/mail/inbox/id/k52",
    },
    meta: { provider: "outlook", facts: [{ label: "From", value: "J. Rivera" }] },
    seenIn: seen("outlook", "mail:k52", "email:outlook:k52", today),
  });
  add("discord:reply-mentor", {
    source: "discord",
    type: "task",
    category: "reply",
    title: "Reply to Alex — lab pairing for Friday",
    org: "ECE 2027",
    dueAt: dayAt(nowD, 0, 20, 0),
    url: "https://discord.com/channels/8804/9916/88501",
    meta: {
      guildId: "8804",
      channelId: "9916",
      facts: [{ label: "Server", value: "ECE 2027" }],
    },
    seenIn: seen("discord", "reply-mentor", "channel:labs", today),
  });
  add("manual:tax-forms", {
    source: "manual",
    type: "task",
    title: "Upload tax forms to WaterlooWorks",
    dueAt: dayAt(nowD, 3, 12, 0),
    evidence: { method: "manual" },
    seenIn: seen("manual", "tax-forms", "manual", today),
  });
  add("manual:email-advisor", {
    source: "manual",
    type: "task",
    title: "Email the academic advisor about course overload",
    dueAt: dayAt(nowD, 1, 9, 0),
    evidence: { method: "manual" },
    seenIn: seen("manual", "email-advisor", "manual", today),
  });

  // ——— Projects: three user projects; their items are ordinary manual
  // items with meta.projectId and org = the project name. ———
  const projects = [
    {
      id: "proj_communihacks",
      name: "CommuniHacks (MLH)",
      color: 2,
      description: "36-hour hackathon — team of four, hardware track.",
      dueAt: dayAt(nowD, 12, 9, 0),
      allDay: true,
      status: "active",
      calendar: true,
      createdAt: iso(now - 6 * DAY),
    },
    {
      id: "proj_uwasic",
      name: "UWASIC tapeout prep",
      color: 5,
      description: "Get the tile ready for the shuttle run.",
      status: "active",
      calendar: false, // kept off the calendar feed
      createdAt: iso(now - 14 * DAY),
    },
    {
      id: "proj_coopapps",
      name: "Co-op applications",
      color: 6,
      status: "active",
      calendar: true,
      createdAt: iso(now - 3 * DAY),
    },
  ];
  /** @param {string} key @param {string} pid @param {Record<string, any>} f */
  const padd = (key, pid, f) =>
    add(`manual:proj:${key}`, {
      source: "manual",
      org: (projects.find((p) => p.id === pid) || {}).name,
      confidence: "exact",
      evidence: { method: "manual" },
      meta: { projectId: pid },
      seenIn: seen("manual", `proj:${key}`, "manual", today),
      ...f,
    });
  // CommuniHacks: due item synced from project.dueAt + milestones/tasks.
  padd("communihacks-due", "proj_communihacks", {
    id: "manual:project:proj_communihacks:due",
    type: "deadline",
    title: "CommuniHacks (MLH) due",
    dueAt: dayAt(nowD, 12, 23, 59),
    allDay: true,
    meta: { projectId: "proj_communihacks", projectDue: true },
  });
  padd("communihacks-video", "proj_communihacks", {
    type: "task",
    title: "Film the 2-minute demo video",
    dueAt: dayAt(nowD, 4, 20, 0),
  });
  padd("communihacks-proto", "proj_communihacks", {
    type: "deadline",
    title: "Milestone: working prototype",
    dueAt: dayAt(nowD, 9, 23, 59),
  });
  padd("communihacks-sync", "proj_communihacks", {
    type: "meeting",
    title: "Team sync — hackathon plan",
    startAt: dayAt(nowD, 2, 18, 0),
    endAt: dayAt(nowD, 2, 18, 45),
  });
  padd("communihacks-parts", "proj_communihacks", {
    type: "task",
    title: "Order sensor parts",
    status: "done",
  });
  // UWASIC: calendar off, mixed dates.
  padd("uwasic-checklist", "proj_uwasic", {
    type: "task",
    title: "Tapeout checklist review",
    dueAt: dayAt(nowD, 7, 12, 0),
  });
  padd("uwasic-pcb", "proj_uwasic", {
    type: "task",
    title: "Order test PCBs",
  });
  // Co-op applications: no project due date.
  padd("coopapps-resume", "proj_coopapps", {
    type: "task",
    title: "Tailor resume for firmware roles",
  });
  padd("coopapps-batch", "proj_coopapps", {
    type: "task",
    title: "Submit three more applications",
    dueAt: dayAt(nowD, 5, 17, 0),
  });

  const userState = {
    "learn:math115-asn4": { done: true, doneAt: iso(now - 30 * HOUR) },
    "learn:ece105-quiz3": {
      estimateMin: 90,
      notes: "Review Thevenin equivalents and the 2024 practice quiz.",
      subtasks: [
        { text: "Redo practice problems 4.1–4.6", done: true },
        { text: "Memorise the formula sheet", done: false },
      ],
    },
    "learn:ece150-project1": { estimateMin: 180 },
    "learn:ece190-deliverable1": { estimateMin: 45 },
    "learn:math115-asn5": { snoozedUntil: nextWeekday(nowD, 1, 8, 0) },
    "manual:capstone-demo": { hidden: true },
    "manual:email-advisor": { done: true, doneAt: iso(now - 2 * HOUR) },
    "todo:study:outline:math117-midterm": { estimateMin: 240 },
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
    outlook: {
      lastRunAt: iso(now - 30 * MIN),
      lastOkAt: iso(now - 30 * MIN),
      session: "signed-in",
      error: null,
      complete: false,
      failures: 0,
      itemCount: 2,
      state: variants.mailscan
        ? {
            scan: {
              provider: "gmail",
              startedAt: iso(now - 40 * MIN),
              days: 60,
              query: 'newer_than:60d (subject:interview OR subject:deadline OR subject:"calendar event")',
            },
            scanQueue: [
              {
                provider: "gmail",
                key: "t9",
                subject: "Acme Analog — interview confirmation",
                url: "https://mail.google.com/mail/u/0/#all/thread-t9",
              },
              {
                provider: "gmail",
                key: "t10",
                subject: "Copperleaf Energy — your co-op offer",
                url: "https://mail.google.com/mail/u/0/#all/thread-t10",
              },
            ],
            scanned: { t7: iso(now - 30 * MIN) },
          }
        : {},
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
      instructors: [
        { name: "J. Rivera", email: "jrivera@example.edu", section: "LEC 002" },
        { name: "A. Chen", section: "TUT 104" },
      ],
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
      itemIds: ["waterlooworks:int-acme", "outlook:mail:k41:offer"],
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
    "waterlooworks:405577": {
      id: "waterlooworks:405577",
      employer: "Copperleaf Energy",
      jobTitle: "Power Systems Intern",
      jobId: "405577",
      cycle: "Winter 2027 main round",
      status: "offer",
      url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/jobs/405577",
      history: [
        { status: "applied", at: iso(now - 10 * DAY) },
        { status: "interview-scheduled", at: iso(now - 4 * DAY) },
        { status: "offer", at: iso(now - 6 * HOUR) },
      ],
      itemIds: ["waterlooworks:offer-copperleaf"],
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

  // Derived to-dos come straight from the real engine so the To-do tab shows
  // exactly what recompute would store.
  const todos = deriveTodos({ items, applications, userState, settings, now: nowD });

  // "Check readers" preview data: a deliberately mixed set — WaterlooWorks
  // reads OK, Discord's channel probe failed, everything else is a mix of
  // readStats-satisfied and not-yet-checked rows.
  const probes = {
    waterlooworks: {
      applications: {
        counts: { listRows: 25, interviews: 3, deadlines: 2 },
        ok: true,
        hints: [],
        at: iso(now - 4 * MIN),
      },
      interviews: {
        counts: { rows: 6, datetimes: 6, employers: 4 },
        ok: true,
        hints: [],
        at: iso(now - 6 * MIN),
      },
    },
    discord: {
      channel: {
        counts: { guildRail: 4, channelRows: 0, categories: 0, unreadChannels: 0, messageRows: 0, messageTimes: 0 },
        ok: false,
        hints: ["Scroll the channel list so channels load.", "Open a channel with recent messages."],
        at: iso(now - 3 * MIN),
      },
    },
    outlook: {
      "outlook-list": {
        counts: { listRows: 18, unread: 3, datedRows: 5 },
        ok: true,
        hints: [],
        at: iso(now - 8 * MIN),
      },
    },
  };
  const readStats = [
    { source: "learn", at: iso(now - 12 * MIN), kind: "sync", scope: "learn", items: 30 },
    { source: "waterlooworks", at: iso(now - 5 * MIN), kind: "observe", path: "/applications", scope: "waterlooworks", items: 3 },
    { source: "discord", at: iso(now - 2 * MIN), kind: "observe", path: "/api/channels/<id>", scope: "discord", items: 2 },
  ];

  return { items, todos, userState, sourceState, courses, applications, terms: {}, settings, discovery, calendarFeed, outlineFiles, updates, updatesSeenAt, projects, probes, readStats };
}
