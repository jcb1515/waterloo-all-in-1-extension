// @ts-check
/*
  Pure DOM parsers for outline.uwaterloo.ca pages. Registered in the offscreen
  document as "outline/parseOutline" (W1's registry calls named exports with a
  Document), and unit-tested under linkedom. textContent only — never innerText.
*/

import { normCourseCode } from "../../core/contract.js";
import { termFromText } from "../learn/reader.js";
import { inferYear } from "../../lib/textdates/index.js";

/** Line-breaking tags for prose extraction (tables are skipped or handled as grids). */
const BREAK = new Set(["BR", "P", "LI", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "TD", "TH", "TABLE"]);

const DAY3 = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Element text as a list of lines: whitespace collapsed per line, lines broken
 * at br/p/li/div/headings (and table structure when tables are kept).
 * @param {any} el @param {boolean} [skipTables]
 * @returns {string[]}
 */
function linesOf(el, skipTables = true) {
  const lines = [];
  let cur = "";
  const flush = () => {
    const t = cur.replace(/\s+/g, " ").trim();
    if (t) lines.push(t);
    cur = "";
  };
  const walk = (node) => {
    if (node.nodeType === 3) {
      cur += node.nodeValue;
      return;
    }
    const tag = node.tagName;
    if (tag === "TABLE" && skipTables) return;
    const br = BREAK.has(tag);
    if (br) flush();
    for (const child of node.childNodes || []) walk(child);
    if (br) flush();
  };
  walk(el);
  flush();
  return lines;
}

/** One td/th as a single line (cell-internal line breaks join with "\n"). */
const cellText = (cell, skipTables = false) => linesOf(cell, skipTables).join("\n");

/**
 * A table expanded to a rectangular grid: rowspan/colspan cells are repeated
 * into every covered slot. Cell text keeps its line breaks ("\n").
 * @param {any} table @returns {string[][]}
 */
export function tableGrid(table) {
  /** @type {string[][]} */
  const grid = [];
  /** @type {Map<number, {left: number, text: string}>} */
  const carry = new Map();
  for (const tr of table.querySelectorAll("tr")) {
    const row = /** @type {string[]} */ ([]);
    let c = 0;
    const fillCarry = () => {
      while (carry.has(c)) {
        const k = /** @type {{left: number, text: string}} */ (carry.get(c));
        row[c] = k.text;
        if (--k.left <= 0) carry.delete(c);
        c++;
      }
    };
    for (const cell of tr.children) {
      if (cell.tagName !== "TD" && cell.tagName !== "TH") continue;
      fillCarry();
      const text = cellText(cell);
      const cs = Number(cell.getAttribute("colspan")) || 1;
      const rs = Number(cell.getAttribute("rowspan")) || 1;
      for (let k = 0; k < cs; k++) {
        row[c + k] = text;
        if (rs > 1) carry.set(c + k, { left: rs - 1, text });
      }
      c += cs;
    }
    fillCarry();
    grid.push(row);
  }
  return grid;
}

/** "Sep 9" / "Oct 20," -> "2026-09-09" (the outline's term year). */
function dayOf(text, termCode) {
  const m = String(text || "").match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})\b/);
  if (!m) return null;
  const mon = "janfebmaraprmayjunjulaugsepoctnovdec".indexOf(m[1].slice(0, 3).toLowerCase());
  if (mon < 0) return null;
  const month = mon / 3 + 1;
  const day = Number(m[2]);
  const y = inferYear(month, day, { termCode });
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const addYear = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

/** A `.date-range` span: "Sep 9 - Oct 20" -> range, "Sep 11," -> single date. */
function spanDates(text, termCode) {
  const t = String(text || "").replace(/[,.\s]+$/, "").trim();
  if (!t) return null;
  const m = t.match(/^(.*?)\s*[-–—]\s*(.*)$/);
  if (m) {
    const a = dayOf(m[1], termCode);
    let b = dayOf(m[2], termCode);
    if (a && b && b < a) b = addYear(b);
    if (a && b) return { range: [a, b] };
  }
  const d = dayOf(t, termCode);
  return d ? { date: d } : null;
}

const DAY_TOKEN = /^([A-Za-z]+)/;
const dayNum = (token) => {
  const m = String(token || "").match(DAY_TOKEN);
  if (!m) return null;
  const k = m[1].slice(0, 3).toLowerCase();
  return k in DAY3 ? DAY3[/** @type {keyof typeof DAY3} */ (k)] : null;
};

/** "04:30PM - 06:20PM" -> ["16:30", "18:20"] */
function timesOf(text) {
  const hits = [...String(text || "").matchAll(/(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?/gi)];
  if (!hits.length) return { start: null, end: null };
  const to24 = (h) => {
    let hh = Number(h[1]) % 12;
    if (h[3].toUpperCase() === "P") hh += 12;
    return `${String(hh).padStart(2, "0")}:${h[2]}`;
  };
  return { start: to24(hits[0]), end: hits[1] ? to24(hits[1]) : null };
}

/** Siblings of `#id` up to the next h2.header. (ids are fixed literals) */
export function sectionEls(doc, id) {
  const h2 = doc.querySelector(`#${id}`);
  const out = [];
  if (!h2) return out;
  for (let sib = h2.nextElementSibling; sib && sib.tagName !== "H2"; sib = sib.nextElementSibling) out.push(sib);
  return out;
}

/**
 * @param {any} doc  a DOM Document (linkedom or real)
 * @param {Record<string, any>} [opts]
 */
export function parseOutline(doc, opts = {}) {
  const coursesEl = doc.querySelector(".outline-courses");
  if (!coursesEl) return null;
  const codeRaw = String(coursesEl.textContent || "").match(/[A-Za-z]{2,8}\s*[_ -]?\s*\d{3}[A-Z]{0,2}/);
  const code = normCourseCode(codeRaw ? codeRaw[0] : coursesEl.textContent);
  const term = termFromText((doc.querySelector(".outline-term") || {}).textContent || "");
  const title = String((doc.querySelector(".outline-title-full") || {}).textContent || "").replace(/\s+/g, " ").trim();
  const termCode = term || null;

  // ---- class schedule ----
  /** @type {any[]} */
  const schedule = [];
  for (const el of sectionEls(doc, "class_schedule")) {
    const tbody = el.querySelector("figure.schedule-info tbody") || el.querySelector(".schedule-info tbody") || el.querySelector("tbody");
    if (!tbody) continue;
    /** @type {string|null} */
    let section = null;
    /** @type {string|null} */
    let kind = null;
    // The instructor cell carries rowspan over a section's meeting rows;
    // instructorLeft counts down the covered continuation rows.
    /** @type {string} */
    let instructor = "";
    /** @type {number} */
    let instructorLeft = 0;
    for (const tr of tbody.querySelectorAll("tr")) {
      const th = tr.querySelector("th");
      if (th) {
        const secEl = th.querySelector(".section");
        const m = String(secEl ? secEl.textContent : th.textContent).match(/(\w+)\s*\[\s*([A-Za-z]+)\s*\]/);
        section = m ? m[1] : null;
        kind = m ? m[2].toUpperCase() : null;
      }
      const info = tr.querySelector(".instructor-info");
      if (info) {
        instructor = String(info.textContent || "").replace(/\s+/g, " ").trim();
        const td = info.closest ? info.closest("td") : null;
        instructorLeft = (td && Number(td.getAttribute("rowspan")) > 1 ? Number(td.getAttribute("rowspan")) : 1) - 1;
      } else if (instructorLeft > 0) {
        instructorLeft--;
      } else {
        instructor = "";
      }
      const daysTd = tr.querySelector("td.meet-days");
      if (!daysTd) continue;
      const days = [...daysTd.querySelectorAll(".days-visual span.present")]
        .map((s) => dayNum(s.textContent))
        .filter((d) => d != null);
      const ranges = [];
      const dates = [];
      for (const span of daysTd.querySelectorAll(".date-range span")) {
        const r = spanDates(span.textContent, termCode);
        if (r && r.range) ranges.push(r.range);
        else if (r && r.date) dates.push(r.date);
      }
      const tds = [...tr.querySelectorAll("td")];
      const iMeet = tds.indexOf(daysTd);
      const timeTd = tds.slice(iMeet + 1).find((td) => /\d{1,2}:\d{2}\s*[AP]\.?M/i.test(td.textContent));
      const { start, end } = timesOf(timeTd ? timeTd.textContent : "");
      const iTime = timeTd ? tds.indexOf(timeTd) : -1;
      const locTd = iTime >= 0 ? tds[iTime + 1] : null;
      const location = locTd ? String(locTd.textContent || "").replace(/\s+/g, " ").trim() : "";
      if (section == null) continue;
      schedule.push({ section, kind, days, start, end, location, instructor: instructor || undefined, ranges, dates });
    }
  }

  // ---- assessments: multitable schemes ----
  /** @type {any[]} */
  const schemes = [];
  let noScheme = false;
  const assessmentEls = sectionEls(doc, "assessments_amp_activities");
  for (const el of assessmentEls) {
    if (el.classList && el.classList.contains("multitable-blank")) noScheme = true;
    if (!(el.classList && el.classList.contains("multitable-container"))) continue;
    const hdr = el.querySelector(".multitable-header");
    const name = hdr ? String(hdr.textContent || "").replace(/\s+/g, " ").trim() : null;
    const rows = [];
    for (const tr of el.querySelectorAll("table.multitable tr")) {
      if (tr.querySelector("th")) continue; // header row
      const cells = [...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH");
      if (!cells.length) continue;
      const [component, dateText, location, weightText] = cells.map((td) => linesOf(td).join(" "));
      const w = String(weightText || "").match(/(\d+(?:\.\d+)?)\s*%/);
      rows.push({
        component: component || "",
        dateText: dateText || "",
        location: location || "",
        weight: w ? Number(w[1]) : null,
      });
    }
    schemes.push({ name, rows });
  }

  // ---- tec-tables in the plan and assessments sections ----
  /** @type {any[]} */
  const tables = [];
  const tableIn = (els, section) => {
    for (const el of els) {
      if (!(el.classList && el.classList.contains("html-block"))) continue;
      for (const tb of el.querySelectorAll("table.tec-table")) tables.push({ section, rows: tableGrid(tb) });
    }
  };
  const planEls = sectionEls(doc, "tentative_class_plan");
  tableIn(planEls, "plan");
  tableIn(assessmentEls, "assessments");

  // ---- prose ----
  const prose = (els, withTables) => {
    const lines = [];
    for (const el of els) {
      if (!(el.classList && el.classList.contains("html-block"))) continue;
      lines.push(...linesOf(el, !withTables));
    }
    return lines.join("\n");
  };
  const text = {
    plan: prose(planEls, false),
    assessments: prose(assessmentEls, false),
    // Team info often sits inside a table (ECE 190 office hours), so the team
    // text keeps table content, broken at cell/row boundaries.
    team: prose(sectionEls(doc, "instructional_team"), true),
  };

  return { code, term: termCode, title, schedule, schemes, noScheme, tables, text };
}
