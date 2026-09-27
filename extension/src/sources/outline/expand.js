// @ts-check
/*
  Turns parseOutline() data into contract Items and a Course. Pure: no DOM, no
  fetch — the DOM work happened in parsers.js and the date words in textdates.
*/

import {
  extractDates,
  inferYear,
  parseWeekLabel,
  termCodeFor,
  weekdayOf,
  zonedIso,
  zonedParts,
} from "../../lib/textdates/index.js";
import { classify, factsOf, isDueish, TRIGGER_RE } from "../learn/classify.js";

/** @typedef {import("../../core/contract.js").Item} Item */
/** @typedef {import("../../core/contract.js").Course} Course */
/** Course plus outline extras pending in the contract. */
/** @typedef {Course & {assessments?: object[], gradingSchemes?: object[]}} OutlineCourse */

const DAY_MS = 24 * 60 * 60 * 1000;

const KIND_TYPE = /** @type {Record<string, Item["type"]>} */ ({
  LEC: "class",
  TUT: "tutorial",
  LAB: "lab",
  SEM: "class",
});
const KIND_WORD = { LEC: "lecture", TUT: "tutorial", LAB: "lab", SEM: "seminar" };
export const KIND_TITLE = { LEC: "Lecture", TUT: "Tutorial", LAB: "Lab", SEM: "Seminar" };

export const pad = (n) => String(n).padStart(2, "0");
export const dNum = (iso) => {
  const [y, m, d] = String(iso).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};
export const fromNum = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const addDays = (iso, n) => fromNum(dNum(iso) + n);
export const inRanges = (iso, ranges) => ranges.some(([a, b]) => a <= iso && iso <= b);
export const dow = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return weekdayOf(y, m, d);
};
/** Monday of the Mon–Sun week containing an ISO date. */
const mondayOf = (iso) => addDays(iso, -((dow(iso) + 6) % 7));
export const torontoDate = (isoInstant) => {
  const p = zonedParts(new Date(isoInstant));
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};
export const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item";
/** A DateHit -> [first day, last day] Toronto dates (endAt is exclusive). */
/** @param {any} hit @returns {[string, string]} */
const rangeDates = (hit) => [
  torontoDate(hit.startAt),
  hit.endAt ? torontoDate(new Date(Date.parse(hit.endAt) - DAY_MS).toISOString()) : torontoDate(hit.startAt),
];
/** True for a hit spanning at least ~two days (a plausible "week"). */
const isWeekRange = (hit) => !!hit.endAt && Date.parse(hit.endAt) - Date.parse(hit.startAt) >= 2 * DAY_MS;
/** "Sep 15" -> "YYYY-MM-DD"; the year comes from term/now inference. */
const dateFor = (monText, day, { now, termCode } = /** @type {{now?: Date, termCode?: number}} */ ({})) => {
  const i = "janfebmaraprmayjunjulaugsepoctnovdec".indexOf(String(monText).slice(0, 3).toLowerCase());
  if (i < 0) return null;
  const mon = i / 3 + 1;
  const year = inferYear(mon, Number(day), { now, termCode });
  return `${year}-${pad(mon)}-${pad(Number(day))}`;
};

const SKIP_LINE = /reading week|midterm week|no class|no lectures/i;
const REVIEW_FOR = /\breview (?:session )?for\b/i;
const OFFICE_RE =
  /(mon|tues|wednes|thurs|fri)days?\s+(\d{1,2}(?::\d{2})?\s*[ap]m)\s*-\s*(\d{1,2}(?::\d{2})?\s*[ap]m)\s+in\s+([A-Z]{2,4}\s*-?\s*\d{3,4}[A-Z]?)/gi;
const OFFICE_DAY = { mon: 1, tues: 2, wednes: 3, thurs: 4, fri: 5 };

/** "10:30am" / "2 pm" -> {h, mi} in 24h time. */
export function clockOf(text) {
  const m = String(text).match(/(\d{1,2})(?::(\d{2}))?\s*([ap])m/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "p") h += 12;
  return { h, mi: Number(m[2] || 0) };
}

/** Dates a schedule row meets: range days plus explicit dates, minus reading weeks. */
function occurrences(row, readingWeeks) {
  const out = new Set();
  for (const [a, b] of row.ranges || []) {
    for (let n = dNum(a); n <= dNum(b); n++) {
      const iso = fromNum(n);
      if ((row.days || []).includes(dow(iso)) && !inRanges(iso, readingWeeks)) out.add(iso);
    }
  }
  for (const d of row.dates || []) {
    if (!inRanges(d, readingWeeks)) out.add(d);
  }
  return [...out].sort();
}

/** The earliest range start among LEC rows (the term's first week anchor). */
function firstLecDate(data) {
  let first = null;
  for (const r of data.schedule || []) {
    if (r.kind !== "LEC") continue;
    for (const [a] of r.ranges || []) if (!first || a < first) first = a;
  }
  return first;
}

/**
 * The course's week table: plan rows whose first cell parses as a Week label.
 * Undated labels fall back to the calendar-week rule: week 1 is the Mon–Sun
 * week containing the earliest LEC range start.
 * @returns {{n: number, start: string|null, end: string|null, topics: string}[]}
 */
export function weeksOf(data, opts = {}) {
  const now = opts.now || new Date();
  const termCode = data.term ?? undefined;
  const week1 = firstLecDate(data) ? mondayOf(firstLecDate(data)) : null;
  const weeks = [];
  for (const t of data.tables || []) {
    if (t.section !== "plan") continue;
    for (const row of t.rows) {
      const w = parseWeekLabel(String(row[0] || "").replace(/\n/g, " "), { now, termCode });
      if (!w) continue;
      let { start, end } = w;
      if (!start && week1) {
        start = addDays(week1, 7 * (w.n - 1));
        end = addDays(start, 6);
      }
      const topics = row
        .slice(1)
        .map((c) => String(c).replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" · ")
        .slice(0, 300);
      weeks.push({ n: w.n, start: start || null, end: end || null, topics });
    }
  }
  return weeks;
}

/**
 * Reading-week ranges [start, end] (inclusive YYYY-MM-DD): plan-table rows
 * labelled /reading week/i (label dates or the calendar-week rule) and
 * plan/assessments prose lines whose textDates hit.
 */
export function readingWeeksOf(data, opts = {}) {
  const now = opts.now || new Date();
  const termCode = data.term ?? undefined;
  const textDates = opts.textDates || extractDates;
  /** @type {[string, string][]} */
  const out = [];
  for (const t of data.tables || []) {
    if (t.section !== "plan") continue;
    for (const row of t.rows) {
      const whole = row.join(" ");
      if (!/reading week/i.test(whole)) continue;
      const w = parseWeekLabel(String(row[0] || "").replace(/\n/g, " "), { now, termCode });
      if (w && w.start && w.end) {
        out.push([w.start, w.end]);
        continue;
      }
      const firstLec = firstLecDate(data);
      if (w && firstLec) {
        const start = addDays(mondayOf(firstLec), 7 * (w.n - 1));
        out.push([start, addDays(start, 6)]);
        continue;
      }
      for (const cell of row) {
        for (const h of textDates(String(cell).replace(/\n/g, " "), { now, termCode })) {
          if (isWeekRange(h)) out.push(rangeDates(h));
        }
      }
    }
  }
  for (const src of [data.text && data.text.plan, data.text && data.text.assessments]) {
    for (const line of String(src || "").split("\n")) {
      if (!/reading week/i.test(line)) continue;
      // A week is a multi-day range; lone dates in a long paragraph (e.g.
      // "...reading weeks. Holidays like Sep 28 ...") are noise.
      for (const h of textDates(line, { now, termCode })) {
        if (isWeekRange(h)) out.push(rangeDates(h));
      }
    }
  }
  return out.filter(([a, b]) => a && b && a <= b);
}

/**
 * Deadline-cell lines like "Grp 1-20: Tue Oct 6" -> [{text, group, perGroup}].
 * A chosen group picks its line; no group (or a group matching nothing) emits
 * every group line pending.
 */
function deadlineLines(lines, group) {
  const grp = /^grp\s*(\d+)\s*[-–—]\s*(\d+)\s*:\s*(.*)$/i;
  const all = /^all groups\s*:\s*(.*)$/i;
  /** @type {{text: string, group: string|null, perGroup: boolean}[]} */
  const out = [];
  let picked = false;
  for (const line of lines) {
    const g = line.match(grp);
    if (g) {
      const range = `${g[1]}-${g[2]}`;
      if (group == null) out.push({ text: g[3], group: range, perGroup: true });
      else if (Number(g[1]) <= group && group <= Number(g[2])) {
        out.push({ text: g[3], group: range, perGroup: false });
        picked = true;
      }
      continue;
    }
    const a = line.match(all);
    out.push({ text: a ? a[1] : line, group: null, perGroup: false });
  }
  if (group != null && !picked) {
    for (const line of lines) {
      const g = line.match(grp);
      if (g) out.push({ text: g[3], group: `${g[1]}-${g[2]}`, perGroup: true });
    }
  }
  return out;
}

/**
 * @param {any} data  parseOutline() output
 * @param {{now?: Date, url?: string, sections?: string[], group?: number|null, officeHours?: boolean, readingWeeks?: [string, string][], textDates?: any}} opts
 * @returns {{items: Item[], course: OutlineCourse}}
 */
export function buildOutline(data, opts = {}) {
  const now = opts.now || new Date();
  const nowIso = now.toISOString();
  const textDates = opts.textDates || extractDates;
  const code = String(data.code || "");
  const CODE = code.replace(/\s+/g, "");
  const termCode = data.term ?? termCodeFor(now);
  const url = opts.url;
  const sections = new Set(opts.sections || []);
  const readingWeeks = opts.readingWeeks || [];

  /** @type {Item[]} */
  const items = [];
  const usedIds = new Set();
  const uid = (id) => {
    let out = id;
    for (let i = 2; usedIds.has(out); i++) out = `${id}-${i}`;
    usedIds.add(out);
    return out;
  };
  const seen = (key) => [{ source: /** @type {const} */ ("outline"), key, scope: code, at: nowIso }];
  const evidence = () => (url ? { url, method: /** @type {const} */ ("html") } : undefined);
  const clock = (d, hm) => {
    const [y, m, dd] = d.split("-").map(Number);
    return zonedIso(y, m, dd, Number(hm.slice(0, 2)), Number(hm.slice(3, 5)));
  };
  const dueEndOfDay = (isoInstant) => {
    const p = zonedParts(new Date(isoInstant));
    return zonedIso(p.y, p.m, p.d, 23, 59);
  };

  const weeks = weeksOf(data, { now });
  const topicsFor = (dateIso) => {
    const w = weeks.find((w) => w.start && w.end && w.start <= dateIso && dateIso <= w.end);
    return w && w.topics ? w.topics : undefined;
  };

  // All LEC occurrence dates, for office-hours bounds.
  const lecDates = [];
  for (const row of data.schedule || []) {
    if (row.kind === "LEC") lecDates.push(...occurrences(row, readingWeeks));
  }
  lecDates.sort();

  // The first team-text line office-hours parsing reads — reused as the
  // "Office hours" fact on class items and Course.officeHours.
  /** @type {string|undefined} */
  let officeHoursText;
  for (const line of String((data.text && data.text.team) || "").split("\n")) {
    if ([...line.matchAll(OFFICE_RE)].length) {
      officeHoursText = line.trim();
      break;
    }
  }

  /* ---- classes + TST exams ---- */
  /** @type {any[]} midterm occurrences (each later gets .item / .merged) */
  const midterms = [];
  for (const row of data.schedule || []) {
    const label = `${row.kind} ${row.section}`;
    if (row.kind === "TST") {
      for (const d of occurrences(row, readingWeeks)) midterms.push({ d, row });
      continue;
    }
    if (!sections.has(label)) continue;
    const makeup = (row.dates || []).length > 0 && !(row.ranges || []).length;
    const word = KIND_WORD[row.kind] || "class";
    for (const d of occurrences(row, readingWeeks)) {
      const id = uid(`outline:${CODE}:${row.kind}${row.section}:${d}T${row.start || "00:00"}`);
      const topic = topicsFor(d);
      const facts = factsOf([
        ["Instructor", row.instructor],
        ["Week topic", topic],
        ["Office hours", officeHoursText],
      ]);
      items.push({
        id,
        source: "outline",
        type: KIND_TYPE[row.kind] || "class",
        category: makeup ? "make-up" : word,
        title: makeup ? `Make-up ${word}` : KIND_TITLE[row.kind] || "Class",
        org: code,
        startAt: row.start ? clock(d, row.start) : undefined,
        endAt: row.end ? clock(d, row.end) : undefined,
        location: row.location || undefined,
        section: label,
        status: "open",
        confidence: "exact",
        review: "auto",
        seenIn: seen(id.replace(/^outline:/, "")),
        evidence: evidence(),
        details: topic,
        meta: facts ? { facts } : undefined,
      });
    }
  }
  midterms.sort((a, b) => a.d.localeCompare(b.d));
  midterms.forEach((t, i) => {
    const { row, d } = t;
    const id = uid(`outline:${CODE}:exam:midterm${midterms.length > 1 ? `-${i + 1}` : ""}`);
    t.item = {
      id,
      source: "outline",
      type: "exam",
      category: "midterm",
      title: "Midterm",
      org: code,
      startAt: row.start ? clock(d, row.start) : undefined,
      endAt: row.end ? clock(d, row.end) : undefined,
      location: row.location || undefined,
      section: `${row.kind} ${row.section}`,
      status: "open",
      confidence: "exact",
      review: "auto",
      seenIn: seen(id.replace(/^outline:/, "")),
      evidence: evidence(),
    };
    items.push(t.item);
  });

  /** Merge an exam/midterm table row into the TST item instead of emitting a second one. */
  const mergeMidterm = (t, { weight, component, dateText, hit }) => {
    t.merged = true;
    if (weight != null) t.item.weight = weight;
    t.item.meta = { ...t.item.meta, component };
    if (hit && hit.startAt !== t.item.startAt) {
      t.item.meta.conflict = dateText;
      t.item.review = "pending";
    }
    return t.item.id;
  };

  /* ---- assessments table (first scheme) ---- */
  const assessments = [];
  const schemes = data.schemes || [];
  const scheme0 = schemes[0];
  if (scheme0) {
    for (const row of scheme0.rows || []) {
      const cls = classify({ title: row.component });
      const hits = row.dateText ? textDates(row.dateText, { now, termCode }) : [];
      const hit = hits.find((h) => h.confidence >= 0.5) || null;
      /** @type {string|null} */
      let itemId = null;
      if (cls.type === "exam" && cls.category === "midterm" && midterms.length) {
        const t = midterms.find((x) => !x.merged) || midterms[0];
        itemId = mergeMidterm(t, { weight: row.weight, component: row.component, dateText: row.dateText, hit });
      } else if (hit) {
        const id = uid(`outline:${CODE}:assess:${slug(row.component)}`);
        /** @type {Item} */
        const item = {
          id,
          source: "outline",
          type: /** @type {Item["type"]} */ (cls.type),
          category: cls.category || undefined,
          title: String(row.component).slice(0, 120),
          org: code,
          status: "open",
          confidence: hit.allDay ? "tentative" : "exact",
          review: "auto",
          weight: row.weight ?? undefined,
          seenIn: seen(id.replace(/^outline:/, "")),
          evidence: evidence(),
        };
        if (!hit.allDay) {
          if (item.type === "exam" || item.type === "quiz" || item.type === "presentation") {
            item.startAt = hit.startAt;
            if (hit.endAt) item.endAt = hit.endAt;
          } else {
            item.dueAt = hit.startAt;
          }
        } else if (hit.endAt) {
          item.startAt = hit.startAt;
          item.endAt = hit.endAt;
          item.allDay = true;
          item.meta = { window: true };
        } else {
          item.dueAt = dueEndOfDay(hit.startAt);
          item.allDay = true;
        }
        if (hit.weekdayMismatch) {
          item.review = "pending";
          item.meta = { ...item.meta, weekdayMismatch: true };
        }
        items.push(item);
        itemId = item.id;
      }
      assessments.push({
        component: row.component,
        weight: row.weight ?? null,
        dateText: row.dateText || "",
        itemId,
        from: "table",
      });
    }
  }

  /* ---- deadline charts: assessments tec-tables with a Deadline column ---- */
  for (const t of data.tables || []) {
    if (t.section !== "assessments") continue;
    const hdr = t.rows[0] || [];
    const dlCol = hdr.findIndex((c) => /deadline/i.test(c));
    if (dlCol < 0) continue;
    const actCol = hdr.findIndex((c) => /activity/i.test(c));
    const valCol = hdr.findIndex((c) => /value|weight/i.test(c));
    const locCol = hdr.findIndex((c) => /location/i.test(c));
    for (const row of t.rows.slice(1)) {
      const act = String(row[actCol] || "");
      const title = (act.split("\n")[0] || "").replace(/^\((?:I|G)\)\s*/i, "").trim();
      if (!title) continue;
      const wm = valCol >= 0 ? String(row[valCol] || "").match(/(\d+(?:\.\d+)?)\s*%/) : null;
      const weight = wm && Number(wm[1]) > 0 ? Number(wm[1]) : undefined;
      const location = locCol >= 0 ? String(row[locCol] || "").split("\n")[0].trim() : "";
      const dlCell = String(row[dlCol] || "");
      /** @type {string|null} */
      let firstId = null;
      for (const choice of deadlineLines(dlCell.split("\n"), opts.group ?? null)) {
        const hit = (textDates(choice.text, { now, termCode }) || []).find((h) => h.confidence >= 0.5);
        const cls = classify({ title });
        if (cls.type === "exam" && cls.category === "midterm" && midterms.length) {
          const t = midterms.find((x) => !x.merged) || midterms[0];
          firstId = mergeMidterm(t, { weight, component: title, dateText: choice.text, hit });
          continue;
        }
        if (!hit) continue;
        const id = uid(`outline:${CODE}:due:${slug(title)}${choice.perGroup ? `:g${choice.group}` : ""}`);
        /** @type {Item} */
        const item = {
          id,
          source: "outline",
          type: /** @type {Item["type"]} */ (cls.type),
          category: cls.category || undefined,
          title: title.slice(0, 120),
          org: code,
          status: "open",
          confidence: hit.allDay ? "tentative" : "exact",
          review: choice.perGroup ? "pending" : "auto",
          weight,
          group: choice.group || undefined,
          location: location || undefined,
          seenIn: seen(id.replace(/^outline:/, "")),
          evidence: evidence(),
        };
        if (hit.allDay) {
          item.dueAt = dueEndOfDay(hit.startAt);
          item.allDay = true;
        } else {
          item.dueAt = hit.startAt;
          if (hit.endAt) item.endAt = hit.endAt;
        }
        if (hit.weekdayMismatch) {
          item.review = "pending";
          item.meta = { ...item.meta, weekdayMismatch: true };
        }
        items.push(item);
        if (!firstId) firstId = item.id;
      }
      assessments.push({
        component: title,
        weight: weight ?? null,
        dateText: dlCell.replace(/\n+/g, " | "),
        itemId: firstId,
        from: "chart",
      });
    }
  }

  /* ---- prose and non-label plan cells -> review items ---- */
  // Structured (table/chart/TST/schedule) items already on the board cover the
  // Toronto day of their startAt/dueAt — or, for all-day items, the whole
  // [startAt, endAt) window. A prose hit inside that coverage is a duplicate.
  /** @type {{cat: string, a: string, b: string}[]} */
  const covered = [];
  for (const i of items) {
    if (!i.category) continue;
    const a = i.startAt ? torontoDate(i.startAt) : i.dueAt ? torontoDate(i.dueAt) : null;
    if (!a) continue;
    const b = i.allDay && i.endAt ? torontoDate(i.endAt) : addDays(a, 1);
    covered.push({ cat: i.category, a, b });
  }
  const isCovered = (cat, day) => covered.some((c) => c.cat === cat && c.a <= day && day < c.b);
  /** @type {string[]} */
  const proseLines = [];
  for (const line of String(data.text && data.text.plan || "").split("\n")) proseLines.push(line);
  for (const line of String(data.text && data.text.assessments || "").split("\n")) proseLines.push(line);
  for (const t of data.tables || []) {
    if (t.section !== "plan") continue;
    for (const row of t.rows) {
      for (const cell of row.slice(1)) {
        for (const line of String(cell).split("\n")) proseLines.push(line);
      }
    }
  }
  for (const raw of proseLines) {
    const line = String(raw).trim();
    if (!line || /^week\s+\d+/i.test(line) || SKIP_LINE.test(line) || !TRIGGER_RE.test(line)) continue;
    for (const hit of textDates(line, { now, termCode })) {
      if (hit.confidence < 0.5) continue;
      const cls = classify({ title: line });
      const isReview = REVIEW_FOR.test(line);
      const cat = isReview ? "review-session" : cls.category;
      const day = torontoDate(hit.startAt);
      if (cat && day && isCovered(cat, day)) continue;
      let title;
      if (!isReview && cls.type === "exam" && cls.category === "midterm") title = "Midterm";
      else if (!isReview && cls.type === "exam" && cls.category === "final") title = "Final exam";
      else {
        const head = line.slice(0, hit.index).replace(/(?:\b(?:due|on|by|is)|[:-])\s*$/i, "").trim();
        const tail = line.slice(hit.index + hit.text.length).trim();
        title = (head.match(/[a-z]/gi) || []).length >= 3 ? head : tail;
        title = title.replace(/^[-–—:,.()\s]+|[-–—:,.()\s]+$/g, "").slice(0, 80) || "Untitled";
      }
      const dueish = !isReview && isDueish(line);
      const id = uid(`outline:${CODE}:text:${slug(title)}`);
      /** @type {Item} */
      const item = {
        id,
        source: "outline",
        type: isReview ? "event" : /** @type {Item["type"]} */ (cls.type),
        category: cat || undefined,
        title,
        org: code,
        status: "open",
        confidence: "tentative",
        review: "pending",
        seenIn: seen(id.replace(/^outline:/, "")),
        evidence: { snippet: line.slice(0, 300), url, method: "text" },
        meta: hit.weekdayMismatch ? { weekdayMismatch: true } : undefined,
      };
      if (dueish) {
        item.dueAt = hit.allDay ? dueEndOfDay(hit.startAt) : hit.startAt;
        if (hit.allDay) item.allDay = true;
      } else {
        item.startAt = hit.startAt;
        if (hit.endAt) item.endAt = hit.endAt;
        if (hit.allDay) item.allDay = true;
      }
      items.push(item);
      break; // one item per line
    }
  }

  /* ---- office hours ---- */
  if (opts.officeHours) {
    const team = String((data.text && data.text.team) || "");
    const startM = team.match(/starting\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})/i);
    const excl = new Set();
    const exclM = team.match(/exclud\w*\s+([^)]*)/i);
    if (exclM) {
      /** @type {number|null} */
      let mon = null;
      for (const tok of exclM[1].matchAll(/([A-Za-z]{3,9})\.?|(\d{1,2})/g)) {
        if (tok[1]) {
          const i = "janfebmaraprmayjunjulaugsepoctnovdec".indexOf(tok[1].slice(0, 3).toLowerCase());
          if (i >= 0) mon = i / 3 + 1;
        } else if (mon && tok[2]) {
          excl.add(`${inferYear(mon, Number(tok[2]), { now, termCode })}-${pad(mon)}-${pad(Number(tok[2]))}`);
        }
      }
    }
    const bounds = [lecDates[0], startM ? dateFor(startM[1], startM[2], { now, termCode }) : null].filter(Boolean).sort();
    const from = bounds[bounds.length - 1];
    const to = lecDates[lecDates.length - 1];
    let series = 0;
    for (const line of team.split("\n")) {
      for (const m of line.matchAll(OFFICE_RE)) {
        const day = OFFICE_DAY[m[1].toLowerCase()];
        const start = clockOf(m[2]);
        const end = clockOf(m[3]);
        const loc = m[4].replace(/\s+/g, " ").trim();
        if (day == null || !start || !from || !to) continue;
        series++;
        for (let n = dNum(from); n <= dNum(to); n++) {
          const iso = fromNum(n);
          if (dow(iso) !== day || inRanges(iso, readingWeeks) || excl.has(iso)) continue;
          const [y, mo, dd] = iso.split("-").map(Number);
          const id = uid(`outline:${CODE}:oh${series}:${iso}`);
          items.push({
            id,
            source: "outline",
            type: "event",
            category: "office-hours",
            title: "Office hours",
            org: code,
            startAt: zonedIso(y, mo, dd, start.h, start.mi),
            endAt: end ? zonedIso(y, mo, dd, end.h, end.mi) : undefined,
            location: loc,
            status: "open",
            confidence: "tentative",
            review: "pending",
            seenIn: seen(id.replace(/^outline:/, "")),
            evidence: { snippet: line.slice(0, 300), url, method: "text" },
            meta: { series: `outline:${CODE}:oh${series}` },
          });
        }
      }
    }
  }

  /* ---- exam coverage details ---- */
  const coverLines = String((data.text && data.text.assessments) || "")
    .split(/\n|(?<=[.!?])\s+/)
    .filter((s) => /cover(s|ed)?\b|\bmaterial\b/i.test(s));
  for (const item of items) {
    if (item.type !== "exam" || (item.category !== "midterm" && item.category !== "final")) continue;
    const re = item.category === "midterm" ? /midterm|\bME\b/i : /final/i;
    const found = coverLines.filter((s) => re.test(s)).map((s) => s.trim());
    if (found.length) {
      const note = found.join(" ");
      item.details = [item.details, ...found].filter(Boolean).join(" ").slice(0, 500);
      const fact = factsOf([["Covers", note]]);
      if (fact) {
        const prior = /** @type {any[]} */ (((item.meta || {}).facts) || []);
        item.meta = { ...item.meta, facts: [...prior, ...fact] };
      }
    }
  }

  /** @type {OutlineCourse} */
  const course = {
    code,
    name: data.title || undefined,
    term: termCode,
    outlineUrl: url,
    weights: (scheme0 ? scheme0.rows : [])
      .filter((r) => r.weight != null)
      .map((r) => ({ component: r.component, weight: r.weight })),
    assessments,
  };
  if (officeHoursText) course.officeHours = officeHoursText;
  if (schemes.length > 1) course.gradingSchemes = schemes;
  return { items, course };
}
