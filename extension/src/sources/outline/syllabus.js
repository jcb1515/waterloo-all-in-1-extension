// @ts-check
/*
  PDF-syllabus text -> items/course. Some courses (ENGL 192) have no
  outline.uwaterloo.ca page, only a PDF syllabus; pdf.js extracts its text and
  this parses it. Pure: no DOM, no fetch, no chrome.
*/

import { extractDates, zonedIso, zonedParts } from "../../lib/textdates/index.js";
import { termFromText } from "../learn/live-source.js";
import { classify } from "../learn/classify.js";
import { addDays, clockOf, dNum, dow, fromNum, inRanges, pad, slug, torontoDate } from "./expand.js";

/** @typedef {import("../../core/contract.js").Item} Item */
/** @typedef {import("../../core/contract.js").Course} Course */
/** @typedef {import("../../core/contract.js").DateHit} DateHit */

const LIGATURES = { ﬀ: "ff", ﬁ: "fi", ﬂ: "fl", ﬃ: "ffi", ﬄ: "ffl" };
const DAY_TOKEN = { su: 0, m: 1, t: 2, w: 3, th: 4, f: 5, sa: 6 };
const DUE_WORD = /\bdue\b|\bbefore\b|\bby\b/i;
const WEEK_RANGE = /through\b|\b&\b|\/\d{1,2}\b|,\s*complete the following/i;

/** T/Th, M/W/F etc -> weekday numbers. */
function daysOf(text) {
  /** @type {number[]} */
  const out = [];
  for (const tok of String(text).split(/[\/,\s]+/)) {
    const d = DAY_TOKEN[tok.toLowerCase()];
    if (d != null && !out.includes(d)) out.push(d);
  }
  return out;
}

/** Shared words (3+ letters, trailing s ignored) between two titles. */
function titleOverlap(a, b) {
  const words = (s) =>
    new Set(
      String(s)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3)
        .map((w) => w.replace(/s$/, "")),
    );
  const wa = words(a);
  return [...words(b)].some((w) => wa.has(w));
}

/**
 * @param {string} text   raw text of a PDF syllabus (pdf.js output)
 * @param {{now?: Date, termCode?: number, sections?: string[], officeHours?: boolean}} opts
 * @returns {{code: string, term: number|null, section: string|null, room: string|null, title: string|null,
 *            items: Item[], course: any, skippedClasses: number} | null}
 */
export function parseSyllabusText(text, opts = {}) {
  const now = opts.now || new Date();
  const nowIso = now.toISOString();
  const clean = String(text)
    .replace(/[ﬀﬁﬂﬃﬄ]/g, (c) => LIGATURES[c] || c)
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ");
  const lines = clean.split("\n").map((l) => l.trim());

  /* ---- header ---- */
  const headM = clean.match(/^([A-Z]{2,5})\s*(\d{3}[A-Z]?)\s*:\s*(.+)$/m);
  if (!headM) return null;
  const code = `${headM[1]} ${headM[2]}`;
  const CODE = code.replace(/\s+/g, "");
  const title = headM[3].trim();
  const metaM = clean.match(/([A-Z][a-z]+)\s+(\d{4})\s*\|\s*Section\s+(\w+)\s*\|\s*Room:\s*([A-Z]+\s*\d+)/);
  const term = opts.termCode ?? (metaM ? termFromText(`${metaM[1]} ${metaM[2]}`) : null);
  const section = metaM ? metaM[3] : null;
  const room = metaM ? metaM[4].replace(/\s+/g, " ") : null;
  const hoursM = clean.match(/Class Hours:\s*([A-Za-z\/,\s]+?),?\s*(\d{1,2}:\d{2}\s*[ap]m)\s*[-–—]\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  const classDays = hoursM ? daysOf(hoursM[1]) : [];
  const classStart = hoursM ? clockOf(hoursM[2]) : null;
  const classEnd = hoursM ? clockOf(hoursM[3]) : null;

  const hits = (line) => extractDates(line, { now, termCode: term ?? undefined });
  const dueEnd = (hit) => {
    const p = zonedParts(new Date(hit.startAt));
    return zonedIso(p.y, p.m, p.d, 23, 59);
  };

  /** @type {Item[]} */
  const items = [];
  const usedIds = new Set();
  const uid = (id) => {
    let out = id;
    for (let i = 2; usedIds.has(out); i++) out = `${id}-${i}`;
    usedIds.add(out);
    return out;
  };
  const seen = (id) => [{ source: /** @type {const} */ ("outline"), key: id.replace(/^outline:/, ""), scope: code, at: nowIso }];
  const emit = (kind, titleText, snippet, extra) => {
    const id = uid(`outline:${CODE}:${kind}:${slug(titleText)}`);
    items.push({
      id,
      source: "outline",
      org: code,
      title: titleText.slice(0, 120),
      status: "open",
      seenIn: seen(id),
      evidence: { snippet: snippet.slice(0, 300), method: "text" },
      ...extra,
    });
    return items[items.length - 1];
  };

  /* ---- Course Assignments Grade Breakdown -> course.weights ---- */
  const weights = [];
  const breakdownIdx = lines.findIndex((l) => /course assignments grade breakdown/i.test(l));
  if (breakdownIdx >= 0) {
    for (const line of lines.slice(breakdownIdx + 1)) {
      if (!line) continue;
      const m = line.match(/^\d+\s*\.\s*(.+?)\s*\((\d+(?:\.\d+)?)\s*%\)\s*$/);
      if (!m) {
        if (weights.length) break;
        continue;
      }
      const component = m[1].replace(/^Assignment\s+\d+\s*:\s*/i, "").split(":")[0].trim();
      weights.push({ component, weight: Number(m[2]) });
    }
  }

  /* ---- Outline of Assignments -> assessment items ---- */
  const outlineIdx = lines.findIndex((l) => /^outline of assignments/i.test(l));
  const schedIdx = lines.findIndex((l) => /^course schedule\b/i.test(l));
  /** @type {{component: string, weight: number|null, dateText: string, itemId: string|null, from: "chart" | "table"}[]} */
  const assessments = [];
  if (outlineIdx >= 0) {
    for (const line of lines.slice(outlineIdx + 1, schedIdx > outlineIdx ? schedIdx : undefined)) {
      const m = line.match(/^Assignment\s+\d+\s*:\s*(.+?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*%\s*(\([^)]*\))?\s*\|\s*Due:\s*(.+)$/i)
        || line.match(/^(.+?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*%\s*(\([^)]*\))?\s*\|\s*Due:\s*(.+)$/i);
      if (!m) continue;
      const name = m[1].trim();
      const weight = Number(m[2]);
      const dateText = m[4].trim();
      const cls = classify({ title: name });
      const hit = hits(dateText).find((h) => h.confidence >= 0.5);
      /** @type {string|null} */
      let itemId = null;
      if (hit) {
        const extra = {
          type: /** @type {Item["type"]} */ (cls.type),
          category: cls.category || undefined,
          weight,
        };
        if (hit.allDay && hit.endAt) {
          Object.assign(extra, {
            startAt: hit.startAt, endAt: hit.endAt, allDay: true,
            confidence: "tentative", review: "pending", meta: { window: true },
          });
        } else {
          Object.assign(extra, {
            dueAt: hit.allDay ? dueEnd(hit) : hit.startAt,
            allDay: hit.allDay || undefined,
            confidence: "exact", review: "auto",
            meta: hit.allDay ? { timeAssumed: true } : undefined,
          });
        }
        itemId = emit("assess", name, line, extra).id;
      }
      assessments.push({ component: name, weight, dateText, itemId, from: "table" });
    }
  }

  /* ---- Course Schedule: week ranges, exclusions, Complete/Attend lines ---- */
  const schedEnd = lines.findIndex((l, i) => i > (schedIdx < 0 ? 0 : schedIdx) && /^course policies\b/i.test(l));
  const schedLines = schedIdx < 0 ? [] : lines.slice(schedIdx + 1, schedEnd > schedIdx ? schedEnd : undefined);
  /** Week ranges (inclusive Toronto dates) and no-class exclusion ranges. */
  /** @type {{start: string, end: string}[]} */
  const weeks = [];
  /** @type {[string, string][]} */
  const exclusions = [];
  /** @type {{line: string, week: {start: string, end: string}|null}[]} */
  const tasks = [];
  /** @type {{start: string, end: string}|null} */
  let curWeek = null;
  for (const line of schedLines) {
    if (!line) continue;
    if (/^WEEK\s/i.test(line)) continue;
    const wHits = hits(line.replace(/,\s*complete the following.*$/i, ""));
    const looksWeek = /^(for\s+)?[a-z]+\s+\d+/i.test(line) && (wHits.length > 0) && /:|through|&|\//.test(line);
    if (looksWeek && wHits.length) {
      const h = wHits[0];
      const a = torontoDate(h.startAt);
      const b = h.endAt ? addDays(torontoDate(h.endAt), -1) : a;
      curWeek = { start: a, end: b };
      weeks.push(curWeek);
      if (/no class(es)?/i.test(line)) exclusions.push([a, b]);
      continue;
    }
    tasks.push({ line, week: curWeek });
  }

  /* ---- classes ---- */
  let skippedClasses = 0;
  const lecLabel = section ? `LEC ${section}` : null;
  const emitClasses = classDays.length > 0 && weeks.length > 0 &&
    (!opts.sections || !opts.sections.length || (lecLabel && opts.sections.includes(lecLabel)));
  if (classDays.length && weeks.length) {
    const a = weeks[0].start;
    const b = weeks[weeks.length - 1].end;
    let count = 0;
    const dates = [];
    for (let n = dNum(a); n <= dNum(b); n++) {
      const iso = fromNum(n);
      if (!classDays.includes(dow(iso))) continue;
      if (inRanges(iso, exclusions)) continue;
      dates.push(iso);
      count++;
    }
    if (emitClasses) {
      for (const iso of dates) {
        const [y, mo, dd] = iso.split("-").map(Number);
        const id = uid(`outline:${CODE}:${lecLabel ? lecLabel.replace(/\s+/g, "") : "LEC"}:${iso}T${pad(classStart ? classStart.h : 0)}:${pad(classStart ? classStart.mi : 0)}`);
        items.push({
          id,
          source: "outline",
          type: "class",
          category: "lecture",
          title: "Lecture",
          org: code,
          startAt: classStart ? zonedIso(y, mo, dd, classStart.h, classStart.mi) : undefined,
          endAt: classEnd ? zonedIso(y, mo, dd, classEnd.h, classEnd.mi) : undefined,
          location: room || undefined,
          section: lecLabel || undefined,
          status: "open",
          confidence: "exact",
          review: "auto",
          seenIn: seen(id),
          evidence: { snippet: "Course Schedule", method: "text" },
        });
      }
    } else {
      skippedClasses = count;
    }
  }

  /* ---- assessment coverage map for schedule-line merging ---- */
  const assessCover = [];
  for (const i of items) {
    if (!i.id.includes(":assess:")) continue;
    const a = i.startAt ? torontoDate(i.startAt) : i.dueAt ? torontoDate(i.dueAt) : null;
    if (!a) continue;
    const b = i.allDay && i.endAt ? addDays(torontoDate(i.endAt), -1) : a;
    assessCover.push({ item: i, a, b });
  }

  /* ---- schedule task lines ---- */
  for (const { line, week } of tasks) {
    const cm = line.match(/^(?:\*\s*)?Complete(?:\s+(Quiz|Module|Worksheet))?\s*:\s*(.+)$/i);
    const am = !cm && line.match(/^(?:\*\s*)?Attend\b\s*:?\s*(.+)$/i);
    if (am && /\blecture\b/i.test(am[1])) continue;
    if (!cm && !am) continue;

    let rest = (cm ? cm[2] : (am && am[1]) || "").trim();
    // title: text before the trailing parenthetical, quotes stripped
    let titleText = rest
      .replace(/\((?:[^()]|\([^()]*\))*\)\s*$/, "")
      .replace(/[“”"]/g, "")
      .replace(/\s*\|\s*/g, " — ")
      .trim();
    const lineHits = hits(rest);
    const wM = rest.match(/(\d+(?:\.\d+)?)\s*%/);
    const weight = wM ? Number(wM[1]) : null;

    if (am) {
      // An attended event with no own date -> the week's first day.
      const d = lineHits.length ? torontoDate(lineHits[0].startAt) : week ? week.start : null;
      if (!d) continue;
      const [y, mo, dd] = d.split("-").map(Number);
      emit("due", titleText, line, {
        type: "event",
        category: "showcase",
        startAt: zonedIso(y, mo, dd, 0, 0),
        allDay: true,
        confidence: "tentative",
        review: "pending",
        weight: weight ?? undefined,
      });
      continue;
    }

    // Due date: the hit after a due/by/before word, else the last hit.
    /** @type {DateHit|null} */
    let hit = null;
    const dw = rest.search(DUE_WORD);
    if (dw >= 0) hit = lineHits.find((h) => h.index >= dw) || null;
    if (!hit) hit = lineHits[lineHits.length - 1] || null;

    if (!hit) {
      // No date: drop it only if an assessment already covers this week.
      if (week && assessCover.some((c) => c.a <= week.end && week.start <= c.b &&
        (titleOverlap(c.item.title, titleText) || (weight != null && c.item.weight === weight)))) continue;
      continue;
    }
    const day = torontoDate(hit.startAt);
    const kind = cm && cm[1] ? cm[1].toLowerCase() : /\bquiz\b/i.test(titleText) ? "quiz" : undefined;
    const cls = classify({ title: titleText, kind });

    // Merge into an assessment item on the same day / inside its window.
    const coveredBy = assessCover.find((c) => c.a <= day && day <= c.b &&
      (titleOverlap(c.item.title, titleText) || (weight != null && c.item.weight === weight)));
    if (coveredBy) {
      coveredBy.item.details = [coveredBy.item.details, rest].filter(Boolean).join(" ").slice(0, 500);
      continue;
    }

    // Windows keep the classify type; a single date is a deadline unless
    // it's literally a quiz.
    const isWindow = !!(hit.allDay && hit.endAt);
    const extra = {
      type: /** @type {Item["type"]} */ (isWindow ? cls.type : cls.type === "quiz" ? "quiz" : "deadline"),
      category: cls.category || undefined,
      weight: weight ?? undefined,
    };
    if (isWindow) {
      Object.assign(extra, {
        startAt: hit.startAt, endAt: hit.endAt, allDay: true,
        confidence: "tentative", review: "pending", meta: { window: true },
      });
    } else if (hit.allDay) {
      Object.assign(extra, {
        dueAt: dueEnd(hit), allDay: true,
        confidence: "exact", review: "auto", meta: { timeAssumed: true },
      });
    } else {
      Object.assign(extra, { dueAt: hit.startAt, confidence: "exact", review: "auto" });
    }
    emit("due", titleText, line, extra);
  }

  /* ---- "Last chance" deadline ---- */
  for (const line of lines) {
    if (!/last chance/i.test(line)) continue;
    const hit = hits(line).find((h) => h.confidence >= 0.5);
    if (!hit) continue;
    const titleText = line.replace(/^\*+/, "").replace(/:.*$/, "").trim();
    emit("text", titleText, line, {
      type: "deadline",
      dueAt: hit.allDay ? dueEnd(hit) : hit.startAt,
      allDay: hit.allDay || undefined,
      confidence: "exact",
      review: "auto",
      meta: hit.allDay ? { timeAssumed: true } : undefined,
    });
  }

  /** @type {Course & {assessments?: object[]}} */
  const course = {
    code,
    name: title || undefined,
    term: term ?? undefined,
    weights,
    assessments,
  };
  return { code, term, section, room, title, items, course, skippedClasses };
}
