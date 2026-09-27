// @ts-check
// WaterlooWorks page parsers. Pure (doc, opts) => data — W1's offscreen
// registry imports this module and calls the named export with a Document.
// No chrome APIs, no fetch, no DOM mutation.

import { parseWwDate, parseWwRange, parseWwTimeRange } from "./dates.js";
import {
  ICON_SELECTOR,
  HEADER_KEYS,
  TABLE_RULES,
  POSTING_H1_RE,
  POSTING_DEADLINE_RE,
  POSTING_SKIP_LABELS,
  LABEL_SELECTOR,
  VALUE_SELECTOR,
  INTERVIEW_DETAIL_LABEL,
  INTERVIEW_DETAIL_HEADING_RE,
  MESSAGE_DETAIL_HEADING_RE,
  RANKINGS_HEADING_RE,
  RANKINGS_CLOSED_RE,
  LOGGED_OUT_PATH_RE,
  LOGGED_OUT_TEXT_RE,
} from "./selectors.js";

// ---------------------------------------------------------------------------
// DOM helpers

/**
 * Text content with every Material icon ligature removed (their inner text is
 * words like "swap_vert"/"preview"/"print"), whitespace collapsed.
 * @param {any} el
 * @returns {string}
 */
function cleanText(el) {
  if (!el) return "";
  let out = "";
  const walk = (node) => {
    if (node.nodeType === 3) {
      out += node.nodeValue;
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.matches && node.matches(ICON_SELECTOR)) return;
    for (const child of node.childNodes || []) walk(child);
  };
  walk(el);
  return out.replace(/\s+/g, " ").trim();
}

const BLOCK_TAGS = new Set([
  "BR", "DIV", "P", "LI", "TR", "SECTION", "ARTICLE",
  "H1", "H2", "H3", "H4", "H5", "H6", "DT", "DD", "TABLE",
]);

/**
 * Like cleanText but keeps one array entry per line: <br> and block-level
 * elements are line boundaries. Used for multi-line cell values.
 * @param {any} el
 * @returns {string[]}
 */
function cleanLines(el) {
  let out = "";
  const walk = (node) => {
    if (node.nodeType === 3) {
      out += node.nodeValue;
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.matches && node.matches(ICON_SELECTOR)) return;
    if (node.tagName === "BR") {
      out += "\n";
      return;
    }
    for (const child of node.childNodes || []) walk(child);
    if (BLOCK_TAGS.has(node.tagName)) out += "\n";
  };
  walk(el);
  return out
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * @param {any} tr
 * @returns {any[]} th/td child elements
 */
function cellElements(tr) {
  return Array.from(tr.children || []).filter(
    (el) => el.tagName === "TH" || el.tagName === "TD"
  );
}

/**
 * @param {any} el
 * @returns {any} nearest ancestor TABLE or null
 */
function ownerTable(el) {
  let node = el.parentElement;
  while (node) {
    if (node.tagName === "TABLE") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * @param {any} table
 * @returns {any[]} rows owned by this table (nested-table rows excluded)
 */
function tableRows(table) {
  return Array.from(table.querySelectorAll("tr")).filter(
    (tr) => ownerTable(tr) === table
  );
}

/**
 * The header row is the first row containing a <th>. Its cells align by index
 * with body-row cells.
 * @param {any} table
 * @returns {{row: any, cells: any[]}|null}
 */
function headerRowOf(table) {
  for (const tr of tableRows(table)) {
    const cells = cellElements(tr);
    if (cells.some((cell) => cell.tagName === "TH")) return { row: tr, cells };
  }
  return null;
}

/**
 * Cleaned header label: icon text stripped, trailing "(1)" sort index removed.
 * @param {any} cell
 */
function cleanHeader(cell) {
  return cleanText(cell).replace(/\s*\(\d+\)\s*$/, "").toLowerCase();
}

/**
 * @param {any} table
 * @returns {string[]} cleaned lowercase header labels, or [] when the table
 *   has no header row
 */
function headerLabels(table) {
  const header = headerRowOf(table);
  return header ? header.cells.map(cleanHeader) : [];
}

/**
 * Find the table of a kind via TABLE_RULES (all required labels present).
 * Column order is user-configurable — never positional.
 * @param {any} doc
 * @param {keyof typeof TABLE_RULES} kind
 */
function tableOfKind(doc, kind) {
  const rule = TABLE_RULES[kind];
  for (const table of doc.querySelectorAll("table")) {
    const labels = headerLabels(table);
    if (labels.length && rule.every((label) => labels.includes(label))) return table;
  }
  return null;
}

/**
 * Body rows -> objects keyed by the table's header-label map.
 * @param {any} table
 * @param {keyof typeof HEADER_KEYS} kind
 * @returns {Record<string, string>[]}
 */
function rowsAsObjects(table, kind) {
  const header = headerRowOf(table);
  if (!header) return [];
  const map = HEADER_KEYS[kind];
  const keys = header.cells.map((cell) => map[cleanHeader(cell)] ?? null);
  const rows = [];
  for (const tr of tableRows(table)) {
    if (tr === header.row) continue;
    const cells = cellElements(tr);
    if (!cells.length) continue;
    /** @type {Record<string, string>} */
    const obj = {};
    cells.forEach((cell, i) => {
      const key = keys[i];
      if (key) obj[key] = cleanText(cell);
    });
    rows.push(obj);
  }
  return rows;
}

/**
 * @param {any} node
 * @returns {any} next element sibling, skipping text nodes
 */
function nextElement(node) {
  let sib = node.nextSibling;
  while (sib && sib.nodeType !== 1) sib = sib.nextSibling;
  return sib;
}

/**
 * Label/value pairs from three layouts: 2-cell <tr>, <dt>/<dd>, and sibling
 * .label/.value-style divs. Returns [{label, value, valueEl}] in document order.
 * @param {any} root
 * @returns {{label: string, value: string, valueEl: any}[]}
 */
function collectLabelValues(root) {
  const pairs = [];
  const seen = new Set();
  for (const tr of root.querySelectorAll("tr")) {
    const cells = cellElements(tr);
    if (cells.length === 2) {
      const label = cleanText(cells[0]);
      const value = cleanText(cells[1]);
      if (label && value && !seen.has(`${label}${value}`)) {
        seen.add(`${label}${value}`);
        pairs.push({ label, value, valueEl: cells[1] });
      }
    }
  }
  for (const dt of root.querySelectorAll("dt")) {
    const dd = nextElement(dt);
    if (dd && dd.tagName === "DD") {
      const label = cleanText(dt);
      const value = cleanText(dd);
      if (label && value) pairs.push({ label, value, valueEl: dd });
    }
  }
  for (const lab of root.querySelectorAll(LABEL_SELECTOR)) {
    if (lab.tagName === "DT") continue; // handled above
    const val = nextElement(lab);
    if (val && val.matches && val.matches(VALUE_SELECTOR) && val.tagName !== "DD") {
      const label = cleanText(lab);
      const value = cleanText(val);
      if (label && value) pairs.push({ label, value, valueEl: val });
    }
  }
  return pairs;
}

const TEXTY = "h1,h2,h3,h4,h5,h6,strong,b,caption,th,td,span,p,div";

/**
 * The tightest element whose cleaned text matches `re` (shortest text wins,
 * so wrappers containing extra content lose to the element itself).
 * @param {any} doc
 * @param {RegExp} re
 * @returns {any|null}
 */
function findTextElement(doc, re) {
  let best = null;
  let bestLen = Infinity;
  for (const el of doc.querySelectorAll(TEXTY)) {
    const text = cleanText(el);
    if (text && re.test(text) && text.length < bestLen) {
      best = el;
      bestLen = text.length;
    }
  }
  return best;
}

/** @param {string|null|undefined} text @param {number} max */
const clamp = (text, max) => (text && text.length > max ? text.slice(0, max) : text);

const pathOf = (url) => {
  try {
    return new URL(url, "https://waterlooworks.uwaterloo.ca").pathname;
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------------------
// detection

const isLoggedOut = (doc, url) =>
  LOGGED_OUT_PATH_RE.test(pathOf(url)) ||
  LOGGED_OUT_TEXT_RE.test(doc.title || "") ||
  Boolean(findTextElement(doc, LOGGED_OUT_TEXT_RE));

const isInterviewDetail = (doc) =>
  Boolean(
    findTextElement(doc, INTERVIEW_DETAIL_HEADING_RE) ||
      collectLabelValues(doc).some(
        (pair) => pair.label.trim().toLowerCase() === INTERVIEW_DETAIL_LABEL
      )
  );

const isMessageDetail = (doc) =>
  Boolean(findTextElement(doc, MESSAGE_DETAIL_HEADING_RE));

const isPosting = (doc) => {
  const h1 = doc.querySelector("h1");
  return Boolean(h1 && POSTING_H1_RE.test(cleanText(h1)));
};

const isRankings = (doc) => Boolean(findTextElement(doc, RANKINGS_HEADING_RE));

/**
 * @param {any} doc
 * @param {{url?: string}} [opts]
 */
export function detectPage(doc, opts = {}) {
  const url = opts.url || "";
  if (isLoggedOut(doc, url)) return "logged-out";
  if (tableOfKind(doc, "applications")) return "applications";
  if (tableOfKind(doc, "interviews")) return "interviews";
  if (tableOfKind(doc, "events")) return "events";
  if (tableOfKind(doc, "messages")) return "messages";
  if (isInterviewDetail(doc)) return "interview-detail";
  if (isMessageDetail(doc)) return "message-detail";
  if (isPosting(doc)) return "posting";
  if (isRankings(doc)) return "rankings";
  return "unknown";
}

// ---------------------------------------------------------------------------
// table parsers

export function parseApplications(doc) {
  const table = tableOfKind(doc, "applications");
  if (!table) return { ok: false, rows: [] };
  const rows = [];
  for (const obj of rowsAsObjects(table, "applications")) {
    if (!obj.jobId) continue;
    rows.push({
      jobId: obj.jobId,
      jobTitle: obj.jobTitle || "",
      employer: obj.employer || "",
      division: obj.division || undefined,
      term: obj.term || undefined,
      appStatusText: obj.appStatusText || "",
      jobStatusText: obj.jobStatusText || undefined,
      location: obj.location || undefined,
      city: obj.city || undefined,
      openings: obj.openings || undefined,
      appDeadline: parseWwDate(obj.appDeadline || ""),
      submittedOn: parseWwDate(obj.submittedOn || ""),
    });
  }
  return { ok: true, rows };
}

export function parseInterviews(doc) {
  const table = tableOfKind(doc, "interviews");
  if (!table) return { ok: false, rows: [] };
  const rows = [];
  for (const obj of rowsAsObjects(table, "interviews")) {
    if (!obj.jobId) continue;
    rows.push({
      jobId: obj.jobId,
      jobTitle: obj.jobTitle || "",
      employer: obj.employer || "",
      division: obj.division || undefined,
      term: obj.term || undefined,
      scheduleStatus: obj.scheduleStatus || undefined,
      confirmationStatus: obj.confirmationStatus || undefined,
      startAt: parseWwDate(obj.startAtText || ""),
      type: obj.type || undefined,
      location: obj.location || undefined,
      method: obj.method || undefined,
    });
  }
  return { ok: true, rows };
}

export function parseEventRegistrations(doc) {
  const table = tableOfKind(doc, "events");
  if (!table) return { ok: false, rows: [] };
  const rows = [];
  for (const obj of rowsAsObjects(table, "events")) {
    if (!obj.event) continue;
    rows.push({
      module: obj.module || undefined,
      event: obj.event,
      startAt: parseWwDate(obj.startAtText || ""),
      location: obj.location || undefined,
      registeredAt: parseWwDate(obj.registeredAtText || ""),
      registrationStatus: obj.registrationStatus || undefined,
    });
  }
  return { ok: true, rows };
}

export function parseMessages(doc) {
  const table = tableOfKind(doc, "messages");
  if (!table) return { ok: false, rows: [] };
  const rows = [];
  for (const obj of rowsAsObjects(table, "messages")) {
    if (!obj.subject && !obj.receivedAtText) continue;
    rows.push({
      priority: obj.priority || undefined,
      receivedAt: parseWwDate(obj.receivedAtText || ""),
      respondedAt: parseWwDate(obj.respondedAtText || ""),
      from: obj.from || undefined,
      to: obj.to || undefined,
      subject: obj.subject || "",
    });
  }
  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// label/value page parsers

export function parsePosting(doc) {
  const h1 = doc.querySelector("h1");
  const match = h1 ? POSTING_H1_RE.exec(cleanText(h1)) : null;
  if (!match) return { ok: false };

  const pairs = collectLabelValues(doc);
  /** @type {Record<string, string>} */
  const fields = {};
  /** @type {string|null} */
  let deadline = null;
  let jobPostingStatus;
  let internalStatus;
  let fieldCount = 0;
  for (const { label, value } of pairs) {
    const key = label.replace(/:$/, "").trim();
    if (!key || !value) continue;
    if (POSTING_DEADLINE_RE.test(key) && !deadline) {
      const parsed = parseWwDate(value);
      if (parsed) deadline = parsed;
    }
    if (/^job posting status$/i.test(key)) jobPostingStatus = value;
    if (/^internal status$/i.test(key)) internalStatus = value;
    if (POSTING_SKIP_LABELS.has(key.toLowerCase())) continue;
    if (fieldCount < 60 && !Object.hasOwn(fields, key)) {
      fields[key] = value.slice(0, 300);
      fieldCount++;
    }
  }

  // h2 "Organization - Division" — split on the LAST " - ".
  const h2 = doc.querySelector("h2");
  const h2Text = h2 ? cleanText(h2) : "";
  let employer;
  let division;
  const split = h2Text.lastIndexOf(" - ");
  if (split > 0) {
    employer = h2Text.slice(0, split).trim();
    division = h2Text.slice(split + 3).trim();
  } else if (h2Text) {
    employer = h2Text;
  }
  employer = employer || fields["Organization"];
  division = division || fields["Division"];

  return {
    ok: true,
    jobId: match[1],
    jobTitle: match[2].trim(),
    employer,
    division,
    deadline,
    fields,
    jobPostingStatus,
    internalStatus,
  };
}

export function parseInterviewDetail(doc) {
  const pairs = collectLabelValues(doc);
  /** @type {Map<string, {label: string, value: string, valueEl: any}>} */
  const byLabel = new Map();
  for (const pair of pairs) {
    const key = pair.label.replace(/:$/, "").trim().toLowerCase();
    if (key && !byLabel.has(key)) byLabel.set(key, pair);
  }
  if (!byLabel.has(INTERVIEW_DETAIL_LABEL) && !findTextElement(doc, INTERVIEW_DETAIL_HEADING_RE)) {
    return { ok: false };
  }
  const get = (label) => byLabel.get(label)?.value;

  /** @type {any} */
  const out = {
    ok: true,
    interviewType: get("interview type"),
    locationType: get("location type"),
    status: get("status of interview"),
    bookingPermission: get("booking permission"),
    instructions: clamp(get("special instructions") || undefined, 1500),
    interviewer: get("interviewer"),
    method: get("interview method"),
    webcamId: get("interviewer webcam id"),
    where: get("where"),
    slots: [],
  };

  // "Interviewing For Job": "#488135" then title (a link), employer, division —
  // on separate lines inside the value.
  const jobPair = byLabel.get(INTERVIEW_DETAIL_LABEL);
  if (jobPair) {
    const lines = cleanLines(jobPair.valueEl);
    const idIndex = lines.findIndex((line) => /^#?\d{3,}$/.test(line));
    if (idIndex >= 0) {
      out.jobId = lines[idIndex].replace(/^#/, "");
      if (lines[idIndex + 1]) out.jobTitle = lines[idIndex + 1];
      if (lines[idIndex + 2]) out.employer = lines[idIndex + 2];
      if (lines[idIndex + 3]) out.division = lines[idIndex + 3];
    }
  }

  const when = get("when");
  if (when) {
    const range = parseWwRange(when);
    if (range) {
      out.startAt = range.startAt;
      out.endAt = range.endAt;
    }
  }

  // "This interview booking was confirmed on: <date>" / "You are booked for…"
  const confirmed = findTextElement(doc, /booking was confirmed on/i);
  out.booked = Boolean(confirmed || findTextElement(doc, /you are booked/i));
  if (confirmed) {
    const text = cleanText(confirmed);
    const at = /confirmed on:?/i.exec(text);
    const tail = at ? text.slice(at.index + at[0].length).trim() : "";
    out.confirmedAt = parseWwDate(tail) || undefined;
  }

  // Slot tables under "INTERVIEWER : <NAME>" headings: a single-cell day-header
  // row ("Thursday, October 1, 2026") then rows of [time range + room | state].
  for (const table of doc.querySelectorAll("table")) {
    let day;
    for (const tr of tableRows(table)) {
      const cells = cellElements(tr);
      if (cells.length === 1) {
        const text = cleanText(cells[0]);
        if (parseWwDate(text)) {
          day = text;
          continue;
        }
      }
      if (!day || cells.length < 2) continue;
      const lines = cleanLines(cells[0]);
      const range = lines.length ? parseWwTimeRange(day, lines[0]) : null;
      if (!range) continue;
      out.slots.push({
        startAt: range.startAt,
        endAt: range.endAt,
        room: lines.slice(1).join(" ") || undefined,
        state: cleanText(cells[1]) || undefined,
      });
    }
  }
  return out;
}

export function parseMessageDetail(doc) {
  if (!findTextElement(doc, MESSAGE_DETAIL_HEADING_RE)) return { ok: false };
  // Shortest matching element wins, so a wrapper containing the body can't
  // smuggle body text into the subject.
  const subjEl = findTextElement(doc, /^subject:/i);
  const subject = subjEl
    ? cleanText(subjEl).replace(/^subject:\s*/i, "").trim() || undefined
    : undefined;
  const pairs = collectLabelValues(doc);
  const get = (re) => pairs.find((pair) => re.test(pair.label))?.value;
  const linked = get(/^linked to$/i);
  let linkedJobId;
  let linkedJobTitle;
  if (linked) {
    const match = /\(?(?:#\s*(\d{4,}))\)?\s*-\s*(.+)/.exec(linked);
    if (match) {
      linkedJobId = match[1];
      linkedJobTitle = match[2].trim();
    }
  }
  // Privacy: the message body and To/Created By are never extracted or stored.
  return {
    ok: true,
    subject,
    category: get(/^category$/i),
    subCategory: get(/^sub-?category$/i),
    attachedTo: get(/^attached to$/i),
    createdAt: parseWwDate(get(/^date created$/i) || "") || undefined,
    linkedJobId,
    linkedJobTitle,
  };
}

export function parseRankings(doc) {
  const heading = findTextElement(doc, RANKINGS_HEADING_RE);
  if (!heading) return { ok: false };
  const match = RANKINGS_HEADING_RE.exec(cleanText(heading));
  const closed = findTextElement(doc, RANKINGS_CLOSED_RE);
  // The open-rankings layout isn't known yet; when it is, parse the table here.
  return {
    ok: true,
    term: match?.[1]?.trim(),
    open: !closed,
    note: closed ? cleanText(closed) : undefined,
  };
}

// ---------------------------------------------------------------------------

/**
 * Detect the page then run every parser whose structure is present — one
 * fragment can carry several sections.
 * @param {any} doc
 * @param {{url?: string}} [opts]
 */
export function parseAll(doc, opts = {}) {
  const page = detectPage(doc, opts);
  const complete =
    doc.documentElement &&
    doc.documentElement.getAttribute &&
    doc.documentElement.getAttribute("data-wa1-complete") === "1";
  /** @type {Record<string, unknown>} */
  const out = { page, complete };
  if (tableOfKind(doc, "applications")) out.applications = parseApplications(doc);
  if (tableOfKind(doc, "interviews")) out.interviews = parseInterviews(doc);
  if (tableOfKind(doc, "events")) out.events = parseEventRegistrations(doc);
  if (tableOfKind(doc, "messages")) out.messages = parseMessages(doc);
  if (isInterviewDetail(doc)) out.interviewDetail = parseInterviewDetail(doc);
  if (isMessageDetail(doc)) out.messageDetail = parseMessageDetail(doc);
  if (isPosting(doc)) out.posting = parsePosting(doc);
  if (isRankings(doc)) out.rankings = parseRankings(doc);
  return out;
}
