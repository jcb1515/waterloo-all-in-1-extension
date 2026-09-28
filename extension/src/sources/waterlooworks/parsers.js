// @ts-check
// WaterlooWorks page parsers. Pure (doc, opts) => data — W1's offscreen
// registry imports this module and calls the named export with a Document.
// No chrome APIs, no fetch, no DOM mutation.

import {
  parseWwDate,
  parseWwRange,
  parseWwTimeRange,
  WW_TIME_RANGE_RE,
} from "./dates.js";
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
  DASHBOARD_PATH_RE,
  DASHBOARD_CONTAINER_SELECTOR,
  DASH_ACTIONS_SELECTOR,
  DASH_NOTICE_SELECTOR,
  DASH_RANKINGS_HEADING_RE,
  FOLDER_PILL_SELECTOR,
  FOLDER_PILL_RE,
  JOB_CARD_LIST_SELECTOR,
  JOB_CARD_ID_RE,
  SCHEDULE_INTERVIEW_RE,
  NEW_MESSAGES_LABEL_RE,
  WEBCAM_LABEL_RE,
  COOP_DETAILS_SELECTOR,
  COOP_SUMMARY_SELECTOR,
  COOP_MONTH_HEADING_RE,
  COOP_MONTHS,
  COOP_APP_LIMIT_RE,
  COOP_END_OF_DAY_RE,
  COOP_TIME_RE,
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
 * Tables with duplicate outerHTML removed — DOM snapshots can contain the
 * same table twice (once standalone, once inside a captured .label parent).
 * @param {any} root
 * @returns {any[]}
 */
function uniqueTables(root) {
  const seen = new Set();
  const out = [];
  for (const table of root.querySelectorAll("table")) {
    const html = table.outerHTML;
    if (seen.has(html)) continue;
    seen.add(html);
    out.push(table);
  }
  return out;
}

/**
 * Find the table of a kind via TABLE_RULES (all required labels present).
 * Column order is user-configurable — never positional.
 * @param {any} doc
 * @param {keyof typeof TABLE_RULES} kind
 */
function tableOfKind(doc, kind) {
  const rule = TABLE_RULES[kind];
  for (const table of uniqueTables(doc)) {
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

/** doc.title throws on a document with no documentElement (linkedom). */
const docTitle = (doc) => {
  try {
    return String(doc?.title || "");
  } catch {
    return "";
  }
};

export const isLoggedOut = (doc, url) =>
  LOGGED_OUT_PATH_RE.test(pathOf(url)) ||
  LOGGED_OUT_TEXT_RE.test(docTitle(doc)) ||
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

// --- dashboard detection -----------------------------------------------------

/**
 * The dashboard's "Your Upcoming Schedule" table: Time/Type/Name/Status
 * headers, day carried by a <strong> above the table.
 * @param {any} doc
 */
const hasScheduleTable = (doc) => {
  for (const table of uniqueTables(doc)) {
    const labels = headerLabels(table);
    if (
      labels.length &&
      TABLE_RULES.schedule.every((label) => labels.includes(label))
    ) {
      return true;
    }
  }
  return false;
};

/**
 * A day-grouped upcoming-events table: a lone <th colspan> header cell whose
 * text is a date ("Monday, September 28, 2026"). colspan >= 2 keeps the
 * single-th day headers of interview-detail slot tables out.
 * @param {any} table
 */
function isDashEventTable(table) {
  const header = headerRowOf(table);
  if (!header || header.cells.length !== 1) return false;
  const cell = header.cells[0];
  if (cell.tagName !== "TH") return false;
  const span = parseInt(cell.getAttribute("colspan") || "1", 10);
  if (!Number.isFinite(span) || span < 2) return false;
  return Boolean(parseWwDate(cleanText(cell)));
}

/** @param {any} doc */
const hasDashEventTable = (doc) => uniqueTables(doc).some(isDashEventTable);

/**
 * The Orbis dashboard is a multi-module page (schedule, events, messages,
 * rankings, sequence). Detected by URL — snapshots and recorder fragments
 * always carry the page URL — or, on a full DOM, by its wrapper or modules.
 * @param {any} doc
 * @param {string} [url]
 */
export function isDashboard(doc, url = "") {
  if (DASHBOARD_PATH_RE.test(pathOf(url))) return true;
  try {
    if (doc.querySelector(DASHBOARD_CONTAINER_SELECTOR)) return true;
  } catch {
    // querySelector may be absent on garbage docs — fall through.
  }
  return hasScheduleTable(doc) || hasDashEventTable(doc);
}

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
  if (isJobsFolder(doc)) return "jobs-folder";
  // Last: a recognised single-purpose page keeps its name; the dashboard is
  // the multi-module catch-all (its own tables match nothing above).
  if (isDashboard(doc, url)) return "dashboard";
  return "unknown";
}

// ---------------------------------------------------------------------------
// table parsers

/**
 * Counts-only landings carry no grid — a stat-table row names the tally
 * ("Total Submitted:", "Booked Interviews", "Unscheduled Interviews") — but
 * the page scope was still read. Returns which landing the page is.
 * @param {any} doc
 * @returns {"applications"|"interviews"|undefined}
 */
export function landingKind(doc) {
  /** @type {Set<string>} */
  const labels = new Set();
  for (const tr of doc.querySelectorAll("tr")) {
    const cell = cellElements(tr)[0];
    if (!cell) continue;
    labels.add(
      cleanText(cell).replace(/:\s*$/, "").trim().toLowerCase()
    );
  }
  if (labels.has("total submitted")) return "applications";
  if (
    labels.has("booked interviews") ||
    labels.has("unscheduled interviews")
  ) {
    return "interviews";
  }
  return undefined;
}

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

/**
 * The My Jobs folder names the current view is filtered to — every applied
 * "Folders: <name>" pill in the filter rails. The plain "All Jobs" list and
 * every other filter (New, Deadline, keyword) yield no pill, so a generic
 * job-search page is never a folder view.
 * @param {any} doc
 * @returns {string[]}
 */
export function jobsFolderNames(doc) {
  /** @type {string[]} */
  const names = [];
  try {
    for (const btn of doc.querySelectorAll(FOLDER_PILL_SELECTOR)) {
      const m = FOLDER_PILL_RE.exec(cleanText(btn));
      if (m && m[1] && !names.includes(m[1])) names.push(m[1]);
    }
  } catch {
    // garbage doc — no folders
  }
  return names;
}

/**
 * The page positively identifies as a My Jobs folder view only through an
 * applied "Folders: …" pill — the same card list without the pill (the
 * student's "All Jobs" search results) yields nothing.
 * @param {any} doc
 */
export function isJobsFolder(doc) {
  return jobsFolderNames(doc).length > 0;
}

/**
 * The jobs.htm card list — parsed whether or not a folder pill is present,
 * so callers can count cards on any search view; only the folder view turns
 * rows into apply deadlines.
 * @param {any} doc
 */
export function parseJobCards(doc) {
  /** @type {any[]} */
  const rows = [];
  try {
    for (const li of doc.querySelectorAll(JOB_CARD_LIST_SELECTOR)) {
      const jobId =
        (JOB_CARD_ID_RE.exec(String(li.id || "")) || [])[1] ||
        String(
          li.querySelector?.('input[name="dataViewerSelection"]')?.value || ""
        ) ||
        undefined;
      if (!jobId) continue;
      const labels = [...li.querySelectorAll("p.label")].map(cleanText);
      const deadlineLabel = labels.find((t) =>
        /^application deadline\s*:/i.test(t)
      );
      const fields = labels.filter(
        (t) => !/^application deadline\s*:/i.test(t)
      );
      const qualifies = ![...li.querySelectorAll("button[aria-label]")].some(
        (b) => /do not qualify/i.test(String(b.getAttribute("aria-label") || ""))
      );
      rows.push({
        jobId,
        jobTitle: cleanText(
          li.querySelector?.("h3 a") || li.querySelector?.("h3")
        ),
        employer: fields[0] || "",
        city: fields[1] || undefined,
        appDeadline: deadlineLabel
          ? parseWwDate(
              deadlineLabel.slice(deadlineLabel.indexOf(":") + 1).trim()
            )
          : null,
        qualifies,
      });
    }
  } catch {
    // garbage doc — no cards
  }
  return rows;
}

export function parseJobsFolder(doc) {
  const folders = jobsFolderNames(doc);
  if (!folders.length) return { ok: false, folders: [], rows: [] };
  return { ok: true, folders, rows: parseJobCards(doc) };
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

  // "Interviewing For Job": "#151515" then title (a link), employer, division —
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
  for (const table of uniqueTables(doc)) {
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

/**
 * The message body: text nodes in document order strictly between the SUBJECT
 * heading and the ADMINISTRATION INFORMATION block. Transient — the adapter
 * feeds it to date extraction and never persists it.
 * @param {any} doc
 * @param {any} subjEl
 * @param {any} adminEl
 */
function messageBodyText(doc, subjEl, adminEl) {
  const root = doc.body || doc.documentElement;
  if (!root || !subjEl || !adminEl) return undefined;
  let started = false;
  let out = "";
  /** @returns {boolean} false stops the walk */
  const visit = (node) => {
    if (node === adminEl) return false;
    if (node === subjEl) {
      started = true;
      return true; // skip the subject subtree itself
    }
    if (node.nodeType === 3) {
      if (started) out += ` ${node.nodeValue}`;
      return true;
    }
    if (node.nodeType !== 1) return true;
    if (node.matches && node.matches(ICON_SELECTOR)) return true;
    for (const child of node.childNodes || []) {
      if (!visit(child)) return false;
    }
    if (started && BLOCK_TAGS.has(node.tagName)) out += " ";
    return true;
  };
  visit(root);
  if (!started) return undefined;
  const text = out.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 20000) : undefined;
}

export function parseMessageDetail(doc) {
  const adminEl = findTextElement(doc, MESSAGE_DETAIL_HEADING_RE);
  if (!adminEl) return { ok: false };
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
  // Privacy: To/Created By are never extracted. bodyText is returned for
  // transient date extraction only — the adapter must not persist it.
  return {
    ok: true,
    subject,
    bodyText: messageBodyText(doc, subjEl, adminEl),
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
// Public co-op important-dates page (uwaterloo.ca). Not a WaterlooWorks page:
// fetched once a day by sync() and parsed via "waterlooworks/parseCoopDates".

/**
 * Text of a node list with <br> and block breaks turned into spaces.
 * @param {any[]} nodes
 */
function nodesText(nodes) {
  let out = "";
  const walk = (node) => {
    if (node.nodeType === 3) {
      out += node.nodeValue;
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.matches && node.matches(ICON_SELECTOR)) return;
    if (node.tagName === "BR") {
      out += " ";
      return;
    }
    for (const child of node.childNodes || []) walk(child);
  };
  for (const node of nodes) walk(node);
  return out.replace(/\s+/g, " ").trim();
}

/**
 * A calendar day's cell is a stream of "lines" split on <br> runs and <p>
 * boundaries; the day number itself is the first line, e.g.
 * "17" | strong "Cycle 1 Posting A" | "Job postings close 9 a.m. (ET)".
 * Each line reports its leading <strong> (the cycle label) separately.
 * @param {any} td
 * @returns {{text: string, strong: string|null}[]}
 */
function coopCellLines(td) {
  /** @type {{text: string, strong: string|null}[]} */
  const lines = [];
  /** @param {any[]} nodes */
  const push = (nodes) => {
    const text = nodesText(nodes);
    if (!text) return;
    const strongEl = nodes.find(
      (n) => n.nodeType === 1 && (n.tagName === "STRONG" || n.tagName === "B")
    );
    lines.push({ text, strong: strongEl ? nodesText([strongEl]) : null });
  };
  /** @param {any} nodeList */
  const emit = (nodeList) => {
    /** @type {any[]} */
    let cur = [];
    for (const node of nodeList || []) {
      if (node.nodeType === 1) {
        if (node.tagName === "BR") {
          push(cur);
          cur = [];
          continue;
        }
        // A <p>/<div> boundary always starts a fresh line, then its own
        // contents are line-split on internal <br>s (a <p> can carry the day
        // number, a cycle label and the event text all at once).
        if (node.tagName === "P" || node.tagName === "DIV") {
          push(cur);
          cur = [];
          emit(node.childNodes);
          continue;
        }
      }
      cur.push(node);
    }
    push(cur);
  };
  emit(td.childNodes);
  // A <br> can wrap a phrase mid-sentence ("…request removal<br />from
  // Cycle 2 Match") — a line starting lowercase continues the previous
  // one instead of starting a new event.
  const folded = [];
  for (const line of lines) {
    if (folded.length && !line.strong && /^[a-z]/.test(line.text)) {
      folded[folded.length - 1].text += ` ${line.text}`;
    } else {
      folded.push(line);
    }
  }
  return folded;
}

/** "9 a.m." | "2:30 p.m." | "noon" -> "HH:MM" (24 h). */
function coopTime(text) {
  const m = COOP_TIME_RE.exec(text);
  if (!m) return null;
  if (!m[1]) return /midnight/i.test(m[0]) ? "00:00" : "12:00";
  let h = +m[1] % 12;
  if (m[3]?.toLowerCase() === "p") h += 12;
  return `${String(h).padStart(2, "0")}:${String(m[2] ? +m[2] : 0).padStart(2, "0")}`;
}

/**
 * Month-calendar tables on the co-op important-dates page. Returns one entry
 * per event line: {date: "YYYY-MM-DD", cycle, text, time: "HH:MM"|null,
 * endOfDay}. A strong-only line is the cycle label for the lines that follow.
 * @param {any} doc
 */
export function parseCoopDates(doc) {
  /** @type {any[]} */
  const entries = [];
  let tables = 0;
  for (const details of doc.querySelectorAll(COOP_DETAILS_SELECTOR)) {
    const summary = details.querySelector(COOP_SUMMARY_SELECTOR);
    const heading = summary && COOP_MONTH_HEADING_RE.exec(cleanText(summary));
    if (!heading) continue;
    const month = COOP_MONTHS[/** @type {keyof typeof COOP_MONTHS} */ (heading[1].toLowerCase())];
    const year = +heading[2];
    if (!month || !year) continue;
    const table = details.querySelector("table");
    if (!table) continue;
    tables++;
    for (const td of table.querySelectorAll("td")) {
      const lines = coopCellLines(td);
      if (!lines.length) continue;
      const dayMatch = /^(\d{1,2})\b/.exec(lines[0].text);
      if (!dayMatch) continue;
      const day = +dayMatch[1];
      const rest = lines[0].text.slice(dayMatch[0].length).trim();
      if (rest) lines[0] = { text: rest, strong: lines[0].strong };
      else lines.shift();
      const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      /** @type {string|null} */
      let cycle = null;
      for (const line of lines) {
        let text = line.text;
        if (COOP_APP_LIMIT_RE.test(text)) continue;
        if (line.strong && text === line.strong) {
          cycle = line.strong; // context for the lines that follow
          continue;
        }
        let lineCycle = cycle;
        if (line.strong && text.startsWith(line.strong)) {
          lineCycle = line.strong;
          text = text.slice(line.strong.length).trim();
          if (!text) {
            cycle = lineCycle;
            continue;
          }
        }
        entries.push({
          date,
          cycle: lineCycle,
          text,
          time: coopTime(text),
          endOfDay: COOP_END_OF_DAY_RE.test(text),
        });
      }
    }
  }
  return tables ? { ok: true, entries } : { ok: false, entries };
}

// ---------------------------------------------------------------------------
// Dashboard

/**
 * The dashboard is multi-module: day-grouped "Your Upcoming Schedule" tables
 * (day in a <strong> above each table), day-grouped "Upcoming Events /
 * Workshops" tables (day in a lone colspan'd th), message/webcam count tables
 * and the "Rank and Match" rankings notice.
 *
 * A document-order scan of <strong> + <table> pairs each schedule table with
 * the date-strong above it; this works on the live DOM and on content.js's
 * flattened snapshots alike (elements keep document order there). Sections
 * are emitted only when their structure is present — the adapter treats
 * presence as "that module was read".
 * @param {any} doc
 * @param {{notices?: boolean}} [opts]  notices only collect on the dashboard
 *   itself (.alert exists on many WW pages) — parseAll gates on the detected
 *   page; direct callers on a dashboard doc keep the collecting default.
 * @returns {{ok: boolean, schedule?: {tables: number, rows: any[]},
 *   events?: {tables: number, rows: any[]}, newMessages?: number,
 *   webcamAppointments?: number,
 *   rankings?: {term: string|undefined, open: boolean, note: string|undefined},
 *   notices?: {heading: string, text: string}[]}}
 */
export function parseDashboard(doc, opts = {}) {
  /** @type {{tables: number, rows: any[]}|undefined} */
  let schedule;
  /** @type {{tables: number, rows: any[]}|undefined} */
  let events;
  /** @type {number|undefined} */
  let newMessages;
  /** @type {number|undefined} */
  let webcamAppointments;
  /** @type {{term: string|undefined, open: boolean, note: string|undefined}|undefined} */
  let rankings;

  // Interview-detail slot tables also open with a single-th date row; the
  // colspan guard plus this check keep them out of the events parse.
  const detailPage = isInterviewDetail(doc);
  /** @type {string|undefined} current day for schedule tables */
  let day;
  for (const el of doc.querySelectorAll("strong, table")) {
    if (el.tagName === "STRONG") {
      const text = cleanText(el);
      if (text && parseWwDate(text)) day = text;
      continue;
    }
    // TABLE — a day-grouped events table carries its own date.
    if (!detailPage && isDashEventTable(el)) {
      const header = headerRowOf(el);
      const dayText = header ? cleanText(header.cells[0]) : "";
      if (!events) events = { tables: 0, rows: [] };
      events.tables++;
      for (const tr of tableRows(el)) {
        const cells = cellElements(tr);
        if (cells.length < 2 || cells[0].tagName === "TH") continue;
        // Cell 1: the range ("11:30 AM ET - 01:30 PM ET") sits inside an
        // <a>, live markup splits it across newlines; the rest of the cell
        // is the category. Join the cell's lines, match the range there,
        // and treat whatever text remains as the category.
        const joined = cleanLines(cells[0]).join(" ");
        const rangeMatch = WW_TIME_RANGE_RE.exec(joined);
        const range = rangeMatch ? parseWwTimeRange(dayText, joined) : null;
        const category = (
          rangeMatch
            ? joined.slice(0, rangeMatch.index) +
              " " +
              joined.slice(rangeMatch.index + rangeMatch[0].length)
            : joined
        ).replace(/\s+/g, " ").trim();
        // Cell 2: <b> event name, optional .label registration badge and a
        // <small> location. Snapshots carry the event's digits on the row
        // (data-wa1-event-id); a raw DOM still has them in the View button's
        // buildForm handler.
        const nameEl = cells[1].querySelector("b");
        const small = cells[1].querySelector("small");
        const labelEl = cells[1].querySelector(".label");
        let eventId;
        const evAttr =
          tr.getAttribute && tr.getAttribute("data-wa1-event-id");
        if (evAttr && /^\d+$/.test(evAttr)) eventId = evAttr;
        if (!eventId && typeof tr.querySelectorAll === "function") {
          for (const el of tr.querySelectorAll("[onclick]")) {
            const m = /'eventId'\s*:\s*'(\d+)'/.exec(
              String(el.getAttribute("onclick") || "")
            );
            if (m) {
              eventId = m[1];
              break;
            }
          }
        }
        let link;
        const linkEl = cells[1].querySelector("a[href]");
        const href = linkEl ? String(linkEl.getAttribute("href") || "") : "";
        if (/^https?:/i.test(href)) link = href;
        const name = (nameEl ? cleanText(nameEl) : cleanText(cells[1]))
          .replace(/\s*\|\s*-\s*/g, " — ")
          .replace(/\s+/g, " ")
          .trim();
        events.rows.push({
          dayText,
          date: parseWwDate(dayText) || undefined,
          startAt: range ? range.startAt : undefined,
          endAt: range ? range.endAt : undefined,
          category: category || undefined,
          name,
          eventId,
          link,
          location: small ? cleanText(small) || undefined : undefined,
          registration: labelEl ? cleanText(labelEl) || undefined : undefined,
        });
      }
      continue;
    }
    const labels = headerLabels(el);
    if (
      labels.length &&
      TABLE_RULES.schedule.every((label) => labels.includes(label))
    ) {
      if (!schedule) schedule = { tables: 0, rows: [] };
      schedule.tables++;
      for (const obj of rowsAsObjects(el, "schedule")) {
        const name = obj.nameText || "";
        const match = SCHEDULE_INTERVIEW_RE.exec(name);
        const range = day ? parseWwTimeRange(day, obj.timeText || "") : null;
        schedule.rows.push({
          dayText: day,
          date: day ? parseWwDate(day) || undefined : undefined,
          startAt: range ? range.startAt : undefined,
          endAt: range ? range.endAt : undefined,
          entryType: obj.entryType || undefined,
          name,
          jobId: match ? match[2] : undefined,
          jobTitle: match ? match[1].trim() : undefined,
          status: obj.statusText || undefined,
          conflicts: obj.conflictsText ? obj.conflictsText.trim() : undefined,
        });
      }
      continue;
    }
    // Count tables: a row names the metric, a .value cell holds the number
    // ("New Messages", "Webcam Appointments").
    for (const tr of tableRows(el)) {
      const cells = cellElements(tr);
      if (cells.length < 2) continue;
      const text = cleanText(cells[1]);
      const valueCell = cells.find(
        (cell) => cell.classList && cell.classList.contains("value")
      );
      const count = valueCell ? parseInt(cleanText(valueCell), 10) : NaN;
      if (!Number.isFinite(count)) continue;
      if (NEW_MESSAGES_LABEL_RE.test(text)) newMessages = count;
      else if (WEBCAM_LABEL_RE.test(text)) webcamAppointments = count;
    }
  }

  // "Rank and Match": .orbis-posting-actions holds "RANKING (term)" and the
  // open/closed notice text.
  for (const block of doc.querySelectorAll(DASH_ACTIONS_SELECTOR)) {
    const heading = block.querySelector("strong, b");
    const match = heading
      ? DASH_RANKINGS_HEADING_RE.exec(cleanText(heading))
      : null;
    const note = findTextElement(block, RANKINGS_CLOSED_RE);
    if (match || note) {
      rankings = {
        term: match ? match[1].trim() : undefined,
        open: !note,
        note: note ? cleanText(note) : undefined,
      };
    }
  }

  // Notices/alerts/posts: alert boxes, the posting-actions module and each
  // user-dashboard post item — submit-document deadlines live in their
  // text ("Work-term report due ..."). Only collected when the doc is the
  // dashboard (.alert is common on other WW pages), and notices alone never
  // mark the dashboard read. A block nested inside another kept region (an
  // .alert inside a post item) is deduped on text.
  /** @type {{heading: string, text: string}[]|undefined} */
  let notices;
  if (opts.notices !== false) {
    /** @type {Set<string>} */
    const seenNotice = new Set();
    for (const block of doc.querySelectorAll(DASH_NOTICE_SELECTOR)) {
      const text = cleanText(block);
      if (!text || seenNotice.has(text)) continue;
      seenNotice.add(text);
      const headingEl = block.querySelector("strong, b, h2, h3, h4");
      if (!notices) notices = [];
      notices.push({
        heading: headingEl ? cleanText(headingEl) : "",
        text,
      });
    }
  }

  const ok = Boolean(
    schedule ||
      events ||
      rankings ||
      newMessages !== undefined ||
      webcamAppointments !== undefined
  );
  /** @type {any} */
  const out = { ok };
  if (schedule) out.schedule = schedule;
  if (events) out.events = events;
  if (newMessages !== undefined) out.newMessages = newMessages;
  if (webcamAppointments !== undefined) {
    out.webcamAppointments = webcamAppointments;
  }
  if (rankings) out.rankings = rankings;
  if (notices) out.notices = notices;
  return out;
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
  if (isInterviewDetail(doc)) out["interview-detail"] = parseInterviewDetail(doc);
  if (isMessageDetail(doc)) out["message-detail"] = parseMessageDetail(doc);
  if (isPosting(doc)) out.posting = parsePosting(doc);
  if (isRankings(doc)) out.rankings = parseRankings(doc);
  if (isJobsFolder(doc)) out["jobs-folder"] = parseJobsFolder(doc);
  // The search card-id set, pill or not: a folder pill that renders before
  // the filtered list still shows these ids, so the adapter compares the
  // folder frame against the last unfiltered set (sorted for equality).
  const jobCardIds = parseJobCards(doc)
    .map((row) => row.jobId)
    .sort();
  if (jobCardIds.length) out.jobCards = { jobIds: jobCardIds };
  const landing = landingKind(doc);
  if (landing) out.landing = { kind: landing };
  const dashboard = parseDashboard(doc, { notices: page === "dashboard" });
  if (dashboard.ok) out.dashboard = dashboard;
  return out;
}
