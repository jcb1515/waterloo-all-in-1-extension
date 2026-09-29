// @ts-check
/*
  Learn API reader. Talks to the Brightspace JSON API either directly from the
  worker (transport) or through an open Learn tab (relay), one request at a
  time. Session detection falls back to the tab when the worker is signed out;
  once the tab answers, every later request goes through it.

  The adapter (index.js) injects both transports and consumes:
    checkSession, listCourses, listDeadlines, keepTermless, readTopicPosts,
    readQuizAttempts, readNews, readGrades, readToc, readGroups,
    plus the versions/userId/readOk fields.
*/

import { termCodeFor, zonedIso } from "../../lib/textdates/index.js";

export const LEARN_ORIGIN = "https://learn.uwaterloo.ca";

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_GAP_MS = 150;
const RELAY_TIMEOUT_MS = 22000;
const MAX_PAGES = 25;

/** A hostname-locked settings override for local API mocks. */
export function learnOrigin(settings) {
  const raw = settings && settings.liveBaseOverride;
  if (raw) {
    try {
      const u = new URL(String(raw));
      if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return u.origin;
    } catch {
      /* ignore malformed overrides */
    }
  }
  return LEARN_ORIGIN;
}

const SUFFIX_WORDS =
  "due date|due|availability ends|availability starts|available|end date|ends|start date|starts|unlock ends|unlock starts|unlocks|unlock";
const SUFFIX_RE = new RegExp(`\\s*[-:–—]\\s*(?:${SUFFIX_WORDS})\\s*$`, "i");
const SUFFIX_MATCH_RE = new RegExp(`\\s*[-:–—]\\s*(${SUFFIX_WORDS})\\s*$`, "i");

/**
 * Drop a trailing Brightspace status suffix (" - Due", ": Availability Ends").
 * @param {unknown} title
 */
export function stripLearnSuffix(title) {
  return String(title || "").replace(SUFFIX_RE, "").trim();
}

const TERM_CODE_RE = /(?<!\d)1\d{2}[159](?!\d)/;
const TERM_SEASON_RE = /\b(winter|spring|summer|fall|autumn)[\s_]*?(20\d{2})\b/i;
const SEASON_DIGIT = { winter: 1, spring: 5, summer: 5, fall: 9, autumn: 9 };

/**
 * A UW term code hidden in a course code or name, e.g. "ECE203_x_1269" -> 1269
 * or "Fall 2026" -> 1269. The 4-digit code wins over a season+year phrase.
 * @param {unknown} text @returns {number | null}
 */
export function termFromText(text) {
  const s = String(text || "");
  const code = s.match(TERM_CODE_RE);
  if (code) return Number(code[0]);
  const season = s.match(TERM_SEASON_RE);
  if (season) {
    const digit = SEASON_DIGIT[/** @type {keyof typeof SEASON_DIGIT} */ (season[1].toLowerCase())];
    if (digit) return (Number(season[2]) - 1900) * 10 + digit;
  }
  return null;
}

/* ------------------------- course code/name parsing ------------------------ */

const SUBJ = "[A-Za-z]{2,8}";
const NUM = "\\d{3}[A-Za-z]{0,2}";
const SEP = "[-:–—]";
const NAME_HEAD_RE = new RegExp(
  `^(${SUBJ})[ _]?(${NUM})\\b(?:\\s*/\\s*${SUBJ}\\s*${NUM}\\b)*\\s*${SEP}?\\s*(.*)$`,
  "is",
);
const CODE_HEAD_RE = new RegExp(`^(${SUBJ})[ _-]?(${NUM})(?!\\d)`, "i");
const LEADING_SECTION_RE = /^\s*(?:LEC|TUT|LAB|SEM)[\s_]*\d{3}\s*/i;
const TRAILING_TERM_RE = new RegExp(
  `\\s*${SEP}?\\s*[([\\[]?\\s*(?:winter|spring|summer|fall|autumn)[\\s_]*20\\d{2}\\s*[)\\]]?\\s*$`,
  "i",
);
const TRAILING_SECTION_RE = new RegExp(
  `\\s*${SEP}?\\s*[([\\[]?\\s*(?:(?:LEC|TUT|LAB|SEM)[\\s_]*)?\\d{3}\\s*[)\\]]?\\s*$`,
  "i",
);
const EDGE_SEP_RE = /^[\s\-:–—]+|[\s\-:–—]+$/g;

/** Longest run of whole words that fits in `max` chars; long first word is cut. */
function firstWords(text, max) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  if (!out && words.length) out = words[0].slice(0, max);
  return out.replace(EDGE_SEP_RE, "");
}

/**
 * Split a course's display name/code into a short code ("ECE 105") and a
 * clean name (section numbers and term phrases dropped).
 * @param {unknown} rawName @param {unknown} rawCode
 */
function courseNameAndCode(rawName, rawCode) {
  const name = String(rawName || "");
  const code = String(rawCode || "");
  const head = name.match(NAME_HEAD_RE);
  if (head) {
    let rest = head[3].replace(LEADING_SECTION_RE, "");
    for (let i = 0; i < 3; i++) {
      const before = rest;
      rest = rest.replace(TRAILING_TERM_RE, "").replace(TRAILING_SECTION_RE, "");
      if (rest === before) break;
    }
    rest = rest.replace(EDGE_SEP_RE, "").trim();
    return { code: `${head[1]} ${head[2]}`.toUpperCase(), name: rest };
  }
  const codeHead = code.match(CODE_HEAD_RE);
  if (codeHead) return { code: `${codeHead[1]} ${codeHead[2]}`.toUpperCase(), name };
  const label = name || code.replace(/_/g, " ") || "Course";
  return { code: firstWords(label, 18), name: label };
}

/* --------------------------------- helpers -------------------------------- */

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A thrown read failure the adapter can inspect. @param {string} code */
function fail(code, status = 0, detail = "") {
  return Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, status });
}

/** @param {unknown} e */
const isSignedOut = (e) => /** @type {{code?: string} | null} */ (e)?.code === "signed-out";

/** ISO-normalise a date string, or null. @param {unknown} s */
function isoOf(s) {
  const ms = Date.parse(String(s || ""));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Case/space-insensitive title key for merging. @param {unknown} s */
const normTitle = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

/** Pull list rows out of the common Brightspace paged shapes. @param {any} json */
function listRows(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    if (Array.isArray(json.Objects)) return json.Objects;
    if (Array.isArray(json.Items)) return json.Items;
  }
  return [];
}

/* ------------------------------ calendar words ---------------------------- */

const DEADLINE_WORD_RE =
  /\b(due|deadline|submi\w*|assignments?|assgn|labs?|reports?|quiz(?:zes)?|tests?|midterms?|exams?|finals?|projects?|problem\s+sets?|homework|hw\d*|psets?|deliverables?|presentations?|proposals?|essays?|reflections?|milestones?|checkpoints?|a\d{1,2})\b/i;

/** A deadline-ish category guessed from a plain calendar event title. */
function calendarCategory(title) {
  const t = String(title || "");
  if (/\blabs?\b/i.test(t)) return "lab";
  if (/\b(quiz(?:zes)?|tests?|midterms?|exams?)\b/i.test(t)) return "quiz";
  if (
    /\b(assignments?|homework|reports?|projects?|deliverables?|proposals?|essays?|problem\s+sets?|psets?|hw\d*|a\d{1,2})\b/i.test(
      t,
    )
  ) {
    return "assignment";
  }
  return "content";
}

const ENTITY_KINDS = {
  Dropbox: "dropbox",
  Quiz: "quiz",
  DiscussionTopic: "discussion",
  TopicCO: "content",
};
const ENTITY_NONE = new Set(["ModuleCO", "DiscussionForum", "GradeObject"]);

const SIGNEDOUTISH = new Set(["signed-out", "forbidden", "not-json", "odd-whoami"]);

/* --------------------------------- reader --------------------------------- */

export class LearnReader {
  /**
   * @param {Record<string, any>} settings
   * @param {{transport: (path: string) => Promise<any>, relay?: (origin: string, path: string) => Promise<any>, now?: Date}} io
   */
  constructor(settings, { transport, relay, now }) {
    this.settings = settings || {};
    this.origin = learnOrigin(this.settings);
    this.transport = transport;
    this.relay = typeof relay === "function" ? relay : null;
    this.now = now instanceof Date ? now : new Date();
    /** @type {{lp?: string, le?: string} | null} */
    this.versions = null;
    /** @type {string | null} */
    this.userId = null;
    /** @type {Map<string, Set<string>>} course id -> scopes that read cleanly */
    this.readOk = new Map();
    this.route = "worker";
    /** @type {Promise<any>} serialises requests through the gap timer */
    this._chain = Promise.resolve();
    this._nextAt = 0;
    this._attemptsForbidden = false;
    /** @type {any[]} kept courses from listCourses, in csv order */
    this._courses = [];
    this._currentIds = new Set();
    this._feed = /** @type {any} */ (null);
    this._calendar = /** @type {any} */ (null);
  }

  /* ------------------------------- transport ------------------------------- */

  /** One request at a time, >= REQUEST_GAP_MS between starts. @returns {Promise<any>} */
  _raw(path, route = this.route) {
    const run = async () => {
      const wait = this._nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      this._nextAt = Date.now() + REQUEST_GAP_MS;
      if (route === "tab") {
        if (!this.relay) return { status: 0, noTab: true };
        return Promise.race([
          Promise.resolve()
            .then(() => /** @type {any} */ (this.relay)(this.origin, path))
            .catch((e) => ({ status: 0, error: String(e instanceof Error ? e.message : e) })),
          sleep(RELAY_TIMEOUT_MS).then(() => ({ status: 0, error: "timeout" })),
        ]);
      }
      try {
        return await this.transport(path);
      } catch (e) {
        return { status: 0, error: String(e instanceof Error ? e.message : e) };
      }
    };
    const p = this._chain.then(run, run);
    this._chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /** GET json or throw a coded error. @returns {Promise<any>} */
  async _get(path, route) {
    const r = await this._raw(path, route);
    if (r && r.noTab) throw fail("no-tab");
    if (r && (r.loginRedirect || r.status === 401)) throw fail("signed-out", r.status || 0);
    const status = Number((r && r.status) || 0);
    if (!status) throw fail("network", 0, (r && r.error) || "");
    if (status === 403) throw fail("forbidden", status);
    if (status === 404) throw fail("not-found", status);
    if (status < 200 || status >= 300) throw fail("http", status);
    if (r.json === undefined) throw fail("not-json", status);
    return r.json;
  }

  /**
   * Paged GET: follows PagingInfo bookmarks (always off the original path) and
   * Next links (pathname+search against the origin), up to MAX_PAGES.
   * @returns {Promise<any[]>}
   */
  async _list(path, route) {
    const rows = [];
    let pagePath = path;
    for (let page = 0; page < MAX_PAGES; page++) {
      const json = await this._get(pagePath, route);
      rows.push(...listRows(json));
      const pi = json && typeof json === "object" ? json.PagingInfo : null;
      if (pi && pi.HasMoreItems && pi.Bookmark) {
        const join = path.includes("?") ? "&" : "?";
        pagePath = `${path}${join}bookmark=${encodeURIComponent(String(pi.Bookmark))}`;
        continue;
      }
      const next = json && typeof json === "object" ? json.Next : null;
      if (typeof next === "string" && next) {
        try {
          const u = new URL(next, this.origin);
          pagePath = u.pathname + u.search;
          continue;
        } catch {
          /* bad Next link: stop */
        }
      }
      break;
    }
    return rows;
  }

  /* --------------------------- versions + session --------------------------- */

  /** Effective lp/le versions: preset, fetched+cached, or defaults (uncached). */
  async _versions(route) {
    if (this.versions) return this.versions;
    const fallback = { lp: "1.30", le: "1.60" };
    try {
      const json = await this._get("/d2l/api/versions/", route);
      const v = { ...fallback };
      for (const e of Array.isArray(json) ? json : []) {
        const code = String((e && e.ProductCode) || "").toLowerCase();
        if ((code === "lp" || code === "le") && typeof e.LatestVersion === "string" && e.LatestVersion) {
          v[code] = e.LatestVersion;
        }
      }
      this.versions = v;
      return v;
    } catch {
      return fallback;
    }
  }

  /** whoami over one route. @returns {Promise<{signedIn: boolean, reason?: string}>} */
  async _whoami(route) {
    try {
      const { lp } = await this._versions(route);
      const json = await this._get(`/d2l/api/lp/${lp}/users/whoami`, route);
      if (json && typeof json === "object" && (json.Identifier || json.UniqueName || json.FirstName)) {
        this.userId = json.Identifier != null ? String(json.Identifier) : null;
        return { signedIn: true };
      }
      return { signedIn: false, reason: "odd-whoami" };
    } catch (e) {
      return { signedIn: false, reason: /** @type {{code?: string} | null} */ (e)?.code || "error" };
    }
  }

  /** Worker first, tab as the fallback; a working tab takes over the route. */
  async checkSession() {
    const worker = await this._whoami("worker");
    if (worker.signedIn) return { signedIn: true, via: "worker" };
    const tab = this.relay ? await this._whoami("tab") : { signedIn: false, reason: "no-tab" };
    if (tab.signedIn) {
      this.route = "tab";
      return { signedIn: true, via: "tab" };
    }
    const tabWhy = tab.reason || "error";
    const workerWhy = worker.reason || "error";
    const reason = SIGNEDOUTISH.has(tabWhy)
      ? "signed-out"
      : tabWhy !== "no-tab"
        ? "unreachable"
        : SIGNEDOUTISH.has(workerWhy)
          ? "no-tab"
          : "unreachable";
    return { signedIn: false, reason };
  }

  /* --------------------------------- courses -------------------------------- */

  /** Enrolled course org units, filtered to the current term (+ termless). */
  async listCourses() {
    const { lp } = await this._versions();
    const rows = await this._list(`/d2l/api/lp/${lp}/enrollments/myenrollments/?orgUnitTypeId=3&isActive=true`);
    const nowMs = this.now.getTime();
    const current = termCodeFor(this.now);
    /** @type {any[]} */
    const candidates = [];
    for (const row of rows) {
      const ou = row && row.OrgUnit;
      if (!ou || ou.Id == null) continue;
      const access = row.Access || {};
      if (access.CanAccess === false || access.IsActive === false) continue;
      if (ou.Type && ou.Type.Id != null && Number(ou.Type.Id) !== 3) continue;
      const term = termFromText(ou.Code) ?? termFromText(ou.Name);
      const start = Date.parse(String(access.StartDate || ""));
      const end = Date.parse(String(access.EndDate || ""));
      /** @type {boolean | null} */
      let inDates = null;
      if (!Number.isNaN(start) || !Number.isNaN(end)) {
        inDates =
          (Number.isNaN(start) || start - 14 * DAY_MS <= nowMs) &&
          (Number.isNaN(end) || end + 14 * DAY_MS >= nowMs);
      }
      const { code, name } = courseNameAndCode(ou.Name, ou.Code);
      candidates.push({
        id: `ou${ou.Id}`,
        code,
        name,
        orgUnitId: Number(ou.Id),
        term: term ?? null,
        inDates,
      });
    }
    const matched = candidates.filter((c) => c.term === current);
    const termless = candidates.filter((c) => c.term == null && c.inDates !== false);
    let kept;
    let fallback = false;
    if (matched.length) {
      kept = [...matched, ...termless];
    } else if (termless.length) {
      kept = termless;
      fallback = true;
    } else {
      kept = candidates;
      fallback = true;
    }
    const courses = kept.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      orgUnitId: c.orgUnitId,
      term: c.term,
      current: fallback ? true : c.term === current,
    }));
    courses.sort((a, b) => a.code.localeCompare(b.code) || a.orgUnitId - b.orgUnitId);
    this._courses = courses;
    this._currentIds = new Set(courses.filter((c) => c.current).map((c) => c.orgUnitId));
    return courses;
  }

  /* ------------------------------ shared reads ------------------------------ */

  /** Read window for the feed and calendar: term +- padding around now. */
  _window() {
    const code = termCodeFor(this.now);
    const startMonth = { 1: 0, 5: 4, 9: 8 }[code % 10] ?? 8;
    const year = Math.floor(code / 10) + 1900;
    const termStart = new Date(year, startMonth, 1).getTime();
    const termEnd = new Date(year, startMonth + 4, 1).getTime();
    return {
      from: new Date(Math.min(termStart, this.now.getTime() - 30 * DAY_MS) - 14 * DAY_MS).toISOString(),
      to: new Date(termEnd + 21 * DAY_MS).toISOString(),
    };
  }

  /** Course ids for cross-course reads: current first, then the rest. */
  _csvOrder() {
    const cur = this._courses.filter((c) => c.current).map((c) => c.orgUnitId);
    const rest = this._courses.filter((c) => !c.current).map((c) => c.orgUnitId);
    return [...cur, ...rest];
  }

  /**
   * A cross-course paged GET chunked by orgUnitIdsCSV (<=100 per chunk). On a
   * 400 over a mixed chunk, retry once with only the current courses.
   * @returns {Promise<{ok: boolean, missed: Set<number>, rows: any[]}>}
   */
  async _crossRead(route, params) {
    const ids = this._csvOrder();
    const missed = new Set();
    /** @type {any[]} */
    const rows = [];
    let ok = false;
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const path = `${route}?orgUnitIdsCSV=${chunk.join(",")}&${params}`;
      try {
        rows.push(...(await this._list(path)));
        ok = true;
        continue;
      } catch (e) {
        if (isSignedOut(e)) throw e;
        const cur = chunk.filter((id) => this._currentIds.has(id));
        if (/** @type {{status?: number} | null} */ (e)?.status === 400 && cur.length > 0 && cur.length < chunk.length) {
          try {
            rows.push(...(await this._list(`${route}?orgUnitIdsCSV=${cur.join(",")}&${params}`)));
            ok = true;
            for (const id of chunk) if (!cur.includes(id)) missed.add(id);
            continue;
          } catch (e2) {
            if (isSignedOut(e2)) throw e2;
          }
        }
        for (const id of chunk) missed.add(id);
      }
    }
    return { ok, missed, rows };
  }

  /** The shared myItems feed + completions, read once per sync. */
  async _ensureFeed() {
    if (this._feed) return this._feed;
    const { le } = await this._versions();
    const w = this._window();
    const base = `/d2l/api/le/${le}/content/`;
    const itemParams = `startDateTime=${encodeURIComponent(w.from)}&endDateTime=${encodeURIComponent(w.to)}`;
    const compParams = `completedFromDateTime=${encodeURIComponent(w.from)}&completedToDateTime=${encodeURIComponent(
      new Date(this.now.getTime() + DAY_MS).toISOString(),
    )}`;
    const due = await this._crossRead(`${base}myItems/due/`, itemParams);
    const all = await this._crossRead(`${base}myItems/`, itemParams);
    const compDue = await this._crossRead(`${base}myItems/completions/due/`, compParams);
    const compAll = await this._crossRead(`${base}myItems/completions/`, compParams);
    const missed = new Set();
    for (const r of [due, all, compDue, compAll]) for (const id of r.missed) missed.add(id);
    /** @type {Map<string, string>} */
    const completed = new Map();
    const nowIso = this.now.toISOString();
    for (const row of [...compDue.rows, ...compAll.rows]) {
      if (!row || row.OrgUnitId == null || row.ItemId == null) continue;
      completed.set(
        `${row.OrgUnitId}:${row.ItemId}`,
        isoOf(row.DateCompleted || row.CompletionDate || row.CompletedDate) || nowIso,
      );
    }
    const items = [...due.rows, ...all.rows].filter((r) => r && r.OrgUnitId != null && r.ItemId != null);
    this._feed = { ok: [due, all, compDue, compAll].filter((r) => r.ok).length, missed, completed, items };
    return this._feed;
  }

  /** The shared cross-course calendar read, once per sync. */
  async _ensureCalendar() {
    if (this._calendar) return this._calendar;
    const { le } = await this._versions();
    const w = this._window();
    const res = await this._crossRead(
      `/d2l/api/le/${le}/calendar/events/myEvents/`,
      `startDateTime=${encodeURIComponent(w.from)}&endDateTime=${encodeURIComponent(w.to)}`,
    );
    this._calendar = res.ok ? { events: res.rows, missed: res.missed } : { events: null, missed: res.missed };
    return this._calendar;
  }

  /** @param {unknown} href */
  _abs(href) {
    if (!href) return null;
    try {
      const u = new URL(String(href), this.origin);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.href;
    } catch {
      return null;
    }
  }

  /** The cross-course (or per-course) calendar events folded into rows. */
  async _courseCalendar(course) {
    const cal = await this._ensureCalendar();
    const ou = course.orgUnitId;
    let ok = true;
    /** @type {any[]} */
    let events;
    if (cal.events && !cal.missed.has(ou)) {
      events = cal.events.filter((e) => Number(e && e.OrgUnitId) === ou);
    } else {
      const { le } = await this._versions();
      const w = this._window();
      try {
        events = await this._list(
          `/d2l/api/le/${le}/${ou}/calendar/events/myEvents/?startDateTime=${encodeURIComponent(
            w.from,
          )}&endDateTime=${encodeURIComponent(w.to)}`,
        );
      } catch (e) {
        if (isSignedOut(e)) throw e;
        events = [];
        ok = false;
      }
    }
    /** @type {Map<string, string>} kind:sourceId -> earliest open date */
    const opens = new Map();
    /** @type {Map<string, {rank: number, row: any}>} */
    const byKey = new Map();
    /** @type {any[]} */
    const rows = [];
    for (const ev of events) {
      if (!ev || ev.CalendarEventId == null) continue;
      const rawTitle = String(ev.Title || "");
      let type = "event";
      const et = ev.EventType;
      if (et === 1) type = "reminder";
      else if (et === 2 || et === 4) type = "opens";
      else if (et === 3 || et === 5) type = "ends";
      else if (et === 6) type = "due";
      else {
        const sm = rawTitle.match(SUFFIX_MATCH_RE);
        const suffix = sm ? sm[1].toLowerCase() : null;
        type = suffix == null ? "event" : suffix.includes("due") ? "due" : /ends|end date/.test(suffix) ? "ends" : "opens";
      }
      const ent = ev.AssociatedEntity && typeof ev.AssociatedEntity === "object" ? ev.AssociatedEntity : null;
      const associated = ev.IsAssociatedWithEntity !== false && ent != null && ent.AssociatedEntityId != null;
      let entKind = "unknown";
      if (associated) {
        const seg = String(ent.AssociatedEntityType || "").split(".").pop() || "";
        entKind = ENTITY_NONE.has(seg) ? "none" : ENTITY_KINDS[seg] || "unknown";
      }
      const allDay = !!ev.IsAllDayEvent;
      const dayM = String(ev.EndDay || ev.StartDay || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
      /** @type {string | null} */
      let date = null;
      if (allDay && dayM) date = zonedIso(Number(dayM[1]), Number(dayM[2]), Number(dayM[3]), 23, 59);
      else if (ent && ev.IsAssociatedWithEntity !== false) date = isoOf(ev.EndDateTime || ev.StartDateTime);
      else date = isoOf(ev.StartDateTime || ev.EndDateTime);
      const title = stripLearnSuffix(rawTitle);
      if (!date || !title) continue;
      const url = this._abs((ent && ent.Link) || ev.CalendarEventViewUrl);
      if (type === "reminder") continue;
      if (type === "opens") {
        if (associated && entKind !== "none" && entKind !== "unknown") {
          const k = `${entKind}:${ent.AssociatedEntityId}`;
          if (!opens.has(k) || Date.parse(date) < Date.parse(/** @type {string} */ (opens.get(k)))) opens.set(k, date);
        }
        continue;
      }
      if (associated) {
        if (entKind === "none") continue;
        if (entKind === "unknown" && type !== "due" && type !== "ends") continue;
        const known = entKind !== "unknown";
        const kind = known ? entKind : "content";
        const sourceId = known ? String(ent.AssociatedEntityId) : `cal${ev.CalendarEventId}`;
        const rank = type === "due" ? 3 : type === "ends" ? 2 : 1;
        const key = `${kind}:${sourceId}`;
        const prev = byKey.get(key);
        if (!prev || rank > prev.rank || (rank === prev.rank && Date.parse(date) > Date.parse(prev.row.dueAt))) {
          byKey.set(key, {
            rank,
            row: {
              kind,
              sourceId,
              title,
              dueAt: date,
              dueField: type === "due" ? "due" : type === "ends" ? "end" : "event",
              url,
              completedAt: null,
            },
          });
        }
        continue;
      }
      if (ev.IsRecurring === true) continue;
      if (!DEADLINE_WORD_RE.test(title)) continue;
      const startAt = isoOf(ev.StartDateTime);
      const endAt = isoOf(ev.EndDateTime);
      rows.push({
        kind: "content",
        sourceId: `cal${ev.CalendarEventId}`,
        title,
        dueAt: date,
        dueField: "event",
        url,
        completedAt: null,
        category: calendarCategory(title),
        startAt,
        endAt: endAt && startAt && Date.parse(endAt) > Date.parse(startAt) ? endAt : null,
        allDay,
      });
    }
    const out = [...byKey.values()].map((x) => x.row).concat(rows);
    for (const r of out) {
      const o = opens.get(`${r.kind}:${r.sourceId}`);
      if (o && Date.parse(o) < Date.parse(r.dueAt)) r.opensAt = o;
    }
    return { rows: out, opens, ok };
  }

  /* ------------------------------ tool reads ------------------------------- */

  /** Dropbox folders + categories + my submissions. @returns {Promise<any[]>} */
  async _dropbox(course) {
    const { le } = await this._versions();
    const base = `/d2l/api/le/${le}/${course.orgUnitId}/`;
    const folders = listRows(await this._get(`${base}dropbox/folders/`));
    /** @type {Map<string, string>} */
    const catNames = new Map();
    if (folders.some((f) => f && f.CategoryId != null)) {
      try {
        for (const c of listRows(await this._get(`${base}dropbox/categories/`))) {
          if (c && c.Id != null) catNames.set(String(c.Id), String(c.Name || ""));
        }
      } catch (e) {
        if (isSignedOut(e)) throw e;
        /* category names are cosmetic */
      }
    }
    /** @type {any[]} */
    const rows = [];
    for (const f of folders) {
      if (!f || f.Id == null || f.IsHidden === true) continue;
      const dueAt = isoOf(f.DueDate || (f.Availability && f.Availability.EndDate));
      if (!dueAt) continue;
      const groupFolder = f.GroupTypeId != null;
      /** @type {string | null} */
      let completedAt = null;
      /** @type {any} */
      let groupId = null;
      try {
        const entries = listRows(await this._get(`${base}dropbox/folders/${f.Id}/submissions/mysubmissions/`));
        for (const entry of entries) {
          const subs =
            entry && Array.isArray(entry.Submissions) ? entry.Submissions : entry && typeof entry === "object" ? [entry] : [];
          for (const s of subs) {
            const at = isoOf(s && s.SubmissionDate) || this.now.toISOString();
            if (!completedAt || Date.parse(at) > Date.parse(completedAt)) completedAt = at;
          }
          if (groupFolder && entry && entry.Entity && entry.Entity.EntityId != null && !Number.isNaN(Number(entry.Entity.EntityId))) {
            groupId = entry.Entity.EntityId;
          }
        }
      } catch (e) {
        if (isSignedOut(e)) throw e;
        /* submissions are best-effort */
      }
      /** @type {any} */
      const row = {
        kind: "dropbox",
        sourceId: String(f.Id),
        title: String(f.Name || "Dropbox folder"),
        dueAt,
        dueField: isoOf(f.DueDate) ? "due" : "end",
        categoryName: catNames.get(String(f.CategoryId)) || null,
        completedAt,
      };
      const start = isoOf(f.Availability && f.Availability.StartDate);
      if (start && Date.parse(start) < Date.parse(dueAt)) row.opensAt = start;
      if (groupFolder) {
        row.groupFolder = true;
        if (groupId != null) row.groupId = groupId;
        else row.exactId = false;
      }
      rows.push(row);
    }
    return rows;
  }

  /** Quiz list. @returns {Promise<any[]>} */
  async _quizzes(course) {
    const { le } = await this._versions();
    const quizzes = await this._list(`/d2l/api/le/${le}/${course.orgUnitId}/quizzes/`);
    /** @type {any[]} */
    const rows = [];
    for (const q of quizzes) {
      const id = q && (q.QuizId ?? q.Id);
      if (!q || id == null || q.IsActive === false) continue;
      const dueAt = isoOf(q.DueDate || q.EndDate);
      if (!dueAt) continue;
      /** @type {any} */
      const row = {
        kind: "quiz",
        sourceId: String(id),
        title: String(q.Name || "Quiz"),
        dueAt,
        dueField: isoOf(q.DueDate) ? "due" : "end",
        completedAt: null,
      };
      const start = isoOf(q.StartDate);
      if (start && Date.parse(start) < Date.parse(dueAt)) row.opensAt = start;
      rows.push(row);
    }
    return rows;
  }

  /** Forums -> topics. @returns {Promise<{rows: any[], partial: boolean}>} */
  async _discussions(course) {
    const { le } = await this._versions();
    const base = `/d2l/api/le/${le}/${course.orgUnitId}/`;
    const forums = listRows(await this._get(`${base}discussions/forums/`));
    /** @type {any[]} */
    const rows = [];
    let forumCount = 0;
    let failed = 0;
    for (const f of forums) {
      if (!f || f.ForumId == null || f.IsHidden === true) continue;
      forumCount++;
      /** @type {any[]} */
      let topics;
      try {
        topics = listRows(await this._get(`${base}discussions/forums/${f.ForumId}/topics/`));
      } catch (e) {
        if (isSignedOut(e)) throw e;
        failed++;
        continue;
      }
      for (const t of topics) {
        if (!t || t.TopicId == null || t.IsHidden === true) continue;
        const dueAt = isoOf(t.DueDate || t.UnlockEndDate || t.EndDate || t.PostEndDate);
        if (!dueAt) continue;
        /** @type {any} */
        const row = {
          kind: "discussion",
          sourceId: String(t.TopicId),
          title: String(t.Name || "Discussion"),
          dueAt,
          dueField: isoOf(t.DueDate) ? "due" : "end",
          forumId: String(f.ForumId),
          completedAt: null,
        };
        const start = isoOf(t.UnlockStartDate || t.StartDate);
        if (start && Date.parse(start) < Date.parse(dueAt)) row.opensAt = start;
        rows.push(row);
      }
    }
    if (failed > 0 && rows.length === 0 && failed === forumCount) {
      throw fail("discussions-failed");
    }
    return { rows, partial: failed > 0 };
  }

  /* ------------------------------ feed rows -------------------------------- */

  /** Tool id embedded in a feed ItemUrl for this row's kind. */
  _toolIdFromUrl(kind, url) {
    const patterns =
      kind === "dropbox"
        ? [/[?&]db=(\d+)/, /\/folders?\/(\d+)/]
        : kind === "quiz"
          ? [/[?&]qi=(\d+)/, /\/quizzes?\/(\d+)/]
          : kind === "discussion"
            ? [/[?&]topicId=(\d+)/, /\/topics\/(\d+)/]
            : [];
    for (const re of patterns) {
      const m = url.match(re);
      if (m) return m[1];
    }
    return null;
  }

  /** myItems rows belonging to one course. @returns {any[]} */
  _feedRows(course) {
    const feed = this._feed;
    const ou = course.orgUnitId;
    /** @type {any[]} */
    const rows = [];
    for (const it of feed.items) {
      if (Number(it.OrgUnitId) !== ou || it.IsExempt === true) continue;
      const dueAt = isoOf(it.DueDate || it.EndDate);
      if (!dueAt) continue;
      const at = it.ActivityType;
      /** @type {string} */
      let kind;
      if (at === 3) kind = "dropbox";
      else if (at === 4) kind = "quiz";
      else if (at === 5 || at === 6) kind = "discussion";
      else {
        const hay = `${typeof at === "string" ? at : ""} ${String(it.ItemUrl || "")}`.toLowerCase();
        kind = /dropbox|assignment/.test(hay)
          ? "dropbox"
          : /quiz/.test(hay)
            ? "quiz"
            : /discussion/.test(hay)
              ? "discussion"
              : "content";
      }
      const url = this._abs(it.ItemUrl);
      const toolId = url ? this._toolIdFromUrl(kind, url) : null;
      /** @type {any} */
      const row = {
        kind,
        sourceId: toolId || String(it.ItemId),
        title: String(it.ItemName || "Learn item"),
        dueAt,
        dueField: isoOf(it.DueDate) ? "due" : "end",
        url,
        completedAt: feed.completed.get(`${it.OrgUnitId}:${it.ItemId}`) || null,
        exactId: kind === "content" || toolId != null,
      };
      const start = isoOf(it.StartDate);
      if (start && Date.parse(start) < Date.parse(dueAt)) row.opensAt = start;
      rows.push(row);
    }
    return rows;
  }

  /* ------------------------------- merge ----------------------------------- */

  /** Deep link for a numeric tool id, or null when it can't be built. */
  _deepLink(kind, ou, sourceId, groupId) {
    if (!/^\d+$/.test(String(sourceId))) return null;
    const o = this.origin;
    if (kind === "dropbox") {
      return groupId != null
        ? `${o}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${sourceId}&grpid=${groupId}&isprv=0&bp=0&ou=${ou}`
        : `${o}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${sourceId}&ou=${ou}`;
    }
    if (kind === "quiz") return `${o}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${sourceId}&ou=${ou}`;
    if (kind === "discussion") return `${o}/d2l/le/${ou}/discussions/topics/${sourceId}/View`;
    if (kind === "content") return `${o}/d2l/le/content/${ou}/viewContent/${sourceId}/View`;
    return null;
  }

  /** The tool's listing page (always available as a fallback link). */
  _listPage(kind, ou) {
    const o = this.origin;
    if (kind === "dropbox") return `${o}/d2l/lms/dropbox/user/folders_list.d2l?ou=${ou}`;
    if (kind === "quiz") return `${o}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${ou}`;
    if (kind === "discussion") return `${o}/d2l/le/${ou}/discussions/List`;
    return `${o}/d2l/le/content/${ou}/Home`;
  }

  /** Category a tool row implies when it doesn't carry one of its own. */
  _toolCategory(row) {
    if (row.kind === "dropbox") {
      if (/\blab\w*/i.test(row.categoryName || "") || /^lab\b/i.test(row.title)) return "lab";
      return "assignment";
    }
    if (row.kind === "quiz") return "quiz";
    if (row.kind === "discussion") return "discussion";
    return "content";
  }

  /**
   * All deadline-ish rows for one course: dropbox, quizzes, discussions, then
   * the shared feed rows, then calendar events — merged by key and title.
   * @param {any} course
   */
  async listDeadlines(course) {
    const ou = course.orgUnitId;
    const feed = await this._ensureFeed();
    const cal = await this._ensureCalendar();

    /** @type {Map<string, any>} */
    const items = new Map();
    /** @type {Map<string, any>} */
    const byTitle = new Map();
    /** @type {any[]} */
    const order = [];
    const okScopes = new Set();

    const pushRow = (row, origin, seen) => {
      row.origin = origin;
      row.seen = seen;
      const key = `${ou}:${row.kind}:${row.sourceId}`;
      const titleKey = `${row.kind}:${normTitle(row.title)}`;
      let item = items.get(key) || null;
      if (!item) {
        const alt = byTitle.get(titleKey);
        if (alt && !alt.origins.has(origin)) item = alt;
      }
      if (!item) {
        item = {
          id: key,
          courseId: course.id,
          kind: row.kind,
          sourceId: row.sourceId,
          category: row.category || this._toolCategory(row),
          title: row.title,
          dueAt: row.dueAt,
          dueField: row.dueField,
          url:
            row.url ||
            (row.exactId === false
              ? this._listPage(row.kind, ou)
              : this._deepLink(row.kind, ou, row.sourceId, row.groupId) || this._listPage(row.kind, ou)),
          listUrl: this._listPage(row.kind, ou),
          groupFolder: !!row.groupFolder,
          status: row.completedAt ? "submitted" : "open",
          completedAt: row.completedAt || null,
          feedLink: origin === "feed" && !!row.url,
          origins: new Set([origin]),
          seenLabels: new Set([seen]),
        };
        if (row.opensAt) item.opensAt = row.opensAt;
        if (row.startAt) {
          item.startAt = row.startAt;
          item.endAt = row.endAt || null;
          item.allDay = !!row.allDay;
        }
        if (row.forumId) item.forumId = row.forumId;
        items.set(key, item);
        if (!byTitle.has(titleKey)) byTitle.set(titleKey, item);
        order.push(item);
        return;
      }
      if (origin === "tool" && !item.origins.has("tool")) {
        item.dueAt = row.dueAt;
        item.dueField = row.dueField;
        item.category = row.category || this._toolCategory(row);
        item.title = row.title;
        if (row.groupFolder) {
          item.groupFolder = true;
          item.url =
            row.groupId != null
              ? this._deepLink(row.kind, ou, row.sourceId, row.groupId)
              : this._listPage(row.kind, ou);
        } else if (!item.feedLink) {
          item.url = this._deepLink(row.kind, ou, row.sourceId, row.groupId) || item.url;
        }
      }
      if (origin === "feed" && row.url && !item.groupFolder) {
        item.url = row.url;
        item.feedLink = true;
      }
      if (row.opensAt && (!item.opensAt || origin === "tool")) item.opensAt = row.opensAt;
      if (row.completedAt && item.status !== "submitted") {
        item.status = "submitted";
        item.completedAt = row.completedAt;
      }
      item.origins.add(origin);
      item.seenLabels.add(seen);
    };

    /** @type {[string, () => Promise<any>][]} */
    const toolRuns = [
      ["dropbox", async () => await this._dropbox(course)],
      ["quizzes", async () => await this._quizzes(course)],
      ["discussions", async () => await this._discussions(course)],
    ];
    let toolsOk = 0;
    for (const [label, run] of toolRuns) {
      try {
        const res = await run();
        toolsOk++;
        const rows = Array.isArray(res) ? res : res.rows;
        const partial = !Array.isArray(res) && !!res.partial;
        if (!partial) okScopes.add(label);
        for (const r of rows) pushRow(r, "tool", label);
      } catch (e) {
        if (isSignedOut(e)) throw e;
        /* a failed tool shows up as a missing readOk scope */
      }
    }

    const feedRows = this._feedRows(course);
    for (const r of feedRows) pushRow(r, "feed", "feed");

    const courseCal = await this._courseCalendar(course);
    for (const r of courseCal.rows) pushRow(r, "calendar", "calendar");

    if (toolsOk === 0 && feed.ok === 0 && !courseCal.ok) throw fail("course-failed");
    if (feed.ok > 0 && !feed.missed.has(ou)) okScopes.add("feed");
    if (courseCal.ok) okScopes.add("calendar");

    // Calendar "opens" events that never matched a row still apply to items.
    for (const item of order) {
      if (item.opensAt) continue;
      const o = courseCal.opens.get(`${item.kind}:${item.sourceId}`);
      if (o && Date.parse(o) < Date.parse(item.dueAt)) item.opensAt = o;
    }

    // Echo fold: near-duplicates across origins collapse into the first keeper.
    const score = (it) =>
      (it.origins.has("tool") ? 4 : 0) + (it.kind !== "content" ? 2 : 0) + (it.origins.has("feed") ? 1 : 0);
    const sorted = order.slice().sort((a, b) => score(b) - score(a));
    /** @type {Map<string, any>} */
    const keptByEcho = new Map();
    /** @type {any[]} */
    const kept = [];
    for (const it of sorted) {
      const echoKey = `${normTitle(stripLearnSuffix(it.title))}:${Math.round(Date.parse(it.dueAt) / 60000)}`;
      const prev = keptByEcho.get(echoKey);
      if (prev && !(prev.origins.has("tool") && it.origins.has("tool"))) {
        if (it.status === "submitted" && prev.status !== "submitted") {
          prev.status = "submitted";
          prev.completedAt = it.completedAt;
        }
        if (it.opensAt && !prev.opensAt) prev.opensAt = it.opensAt;
        for (const s of it.seenLabels) prev.seenLabels.add(s);
        continue;
      }
      keptByEcho.set(echoKey, it);
      kept.push(it);
    }
    // Emit after folding so merged seenIn/status fields are reflected.
    const out = kept.map((it) => ({
      id: it.id,
      courseId: it.courseId,
      kind: it.kind,
      category: it.category,
      title: it.title,
      dueAt: it.dueAt,
      dueField: it.dueField,
      url: it.url,
      listUrl: it.listUrl,
      groupFolder: it.groupFolder,
      status: it.status,
      completedAt: it.completedAt,
      opensAt: it.opensAt,
      startAt: it.startAt,
      endAt: it.endAt,
      allDay: it.allDay,
      forumId: it.forumId,
      seenIn: [...it.seenLabels],
    }));
    this.readOk.set(course.id, okScopes);
    return out;
  }

  /**
   * Should a termless course stay? Only when it still has something upcoming;
   * kept rows are trimmed to the last two weeks.
   * @param {any} course @param {any[]} rows
   */
  keepTermless(course, rows) {
    const nowMs = this.now.getTime();
    const upcoming = (rows || []).filter(
      (r) => r && r.status === "open" && !Number.isNaN(Date.parse(r.dueAt || "")) && Date.parse(r.dueAt) >= nowMs,
    );
    if (!upcoming.length) return null;
    return rows.filter((r) => r && !Number.isNaN(Date.parse(r.dueAt || "")) && Date.parse(r.dueAt) >= nowMs - 14 * DAY_MS);
  }

  /* ------------------------------ small reads ------------------------------- */

  /** True when the student already posted in this discussion topic. */
  async readTopicPosts(course, forumId, topicId, userId) {
    const { le } = await this._versions();
    const posts = await this._list(
      `/d2l/api/le/${le}/${course.orgUnitId}/discussions/forums/${forumId}/topics/${topicId}/posts/`,
    );
    return posts.some((p) => p && String(p.PostingUserId) === String(userId));
  }

  /** Latest finished quiz attempt, or null. A 403 stops asking for the sync. */
  async readQuizAttempts(course, quizId) {
    if (this._attemptsForbidden) return null;
    const { le } = await this._versions();
    try {
      const attempts = listRows(
        await this._get(`/d2l/api/le/${le}/${course.orgUnitId}/quizzes/${quizId}/attempts/`),
      );
      /** @type {string | null} */
      let best = null;
      for (const a of attempts) {
        const at = isoOf(a && (a.CompletionDate || a.CompletedDate || a.DateCompleted));
        if (at && (!best || Date.parse(at) > Date.parse(best))) best = at;
      }
      return best;
    } catch (e) {
      if (/** @type {{code?: string} | null} */ (e)?.code === "forbidden") {
        this._attemptsForbidden = true;
        return null;
      }
      if (isSignedOut(e)) throw e;
      return null;
    }
  }

  /** Published, visible announcements as plain text. @returns {Promise<any[]>} */
  async readNews(course) {
    const { le } = await this._versions();
    const news = listRows(await this._get(`/d2l/api/le/${le}/${course.orgUnitId}/news/`));
    /** @type {any[]} */
    const out = [];
    for (const n of news) {
      if (!n || n.Id == null || n.IsPublished === false || n.IsHidden === true) continue;
      const body = n.Body && typeof n.Body === "object" ? n.Body : {};
      const plain = String(body.Text || "").trim();
      const text = plain || htmlToText(body.Html);
      out.push({
        id: String(n.Id),
        title: String(n.Title || "").slice(0, 200),
        text,
        at: isoOf(n.StartDate),
      });
    }
    return out;
  }

  /** Grade objects, categories and the student's values (each fail-soft). */
  async readGrades(course) {
    const { le } = await this._versions();
    const base = `/d2l/api/le/${le}/${course.orgUnitId}/`;
    /** @param {string} p @returns {Promise<any[] | null>} */
    const tryList = async (p) => {
      try {
        return listRows(await this._get(base + p));
      } catch (e) {
        if (isSignedOut(e)) throw e;
        return null;
      }
    };
    const objects = await tryList("grades/");
    const categories = await tryList("grades/categories/");
    const values = await tryList("grades/values/myGradeValues/");
    return {
      objects: objects || [],
      categories: categories || [],
      values: values || [],
      ok: objects !== null && categories !== null && values !== null,
    };
  }

  /** Content TOC: outline links + syllabus PDFs, walked recursively. */
  async readToc(course) {
    const { le } = await this._versions();
    const toc = await this._get(`/d2l/api/le/${le}/${course.orgUnitId}/content/toc`);
    const outlineUrls = /** @type {string[]} */ ([]);
    const syllabusUrls = /** @type {{title: string, url: string}[]} */ ([]);
    /** @param {any[]} mods */
    const walk = (mods) => {
      for (const m of Array.isArray(mods) ? mods : []) {
        if (!m) continue;
        for (const t of Array.isArray(m.Topics) ? m.Topics : []) {
          const url = this._abs(t && t.Url);
          if (!url) continue;
          let u;
          try {
            u = new URL(url);
          } catch {
            continue;
          }
          if (u.hostname === "outline.uwaterloo.ca") outlineUrls.push(url);
          const title = String((t && t.Title) || "");
          if (/syllabus|course outline/i.test(title) && /\.pdf$/i.test(u.pathname)) {
            syllabusUrls.push({ title, url });
          }
        }
        walk(m.Modules);
      }
    };
    walk(toc && toc.Modules);
    return { outlineUrls, syllabusUrls };
  }

  /** The student's "Group N" memberships (lp API). Errors propagate. */
  async readGroups(course) {
    const { lp } = await this._versions();
    const base = `/d2l/api/lp/${lp}/${course.orgUnitId}/groupcategories/`;
    const cats = listRows(await this._get(base));
    const uid = Number(this.userId);
    const nums = new Set();
    for (const c of cats) {
      const cid = c && (c.GroupCategoryId ?? c.Id);
      if (cid == null) continue;
      for (const g of listRows(await this._get(`${base}${cid}/groups/`))) {
        const en = Array.isArray(g && g.Enrollments) ? g.Enrollments : [];
        if (!en.some((x) => Number(x) === uid)) continue;
        const m = String((g && g.Name) || "").match(/group\s*0*(\d+)/i);
        if (m) nums.add(Number(m[1]));
      }
    }
    return [...nums].sort((a, b) => a - b);
  }
}

/* -------------------------------- html->text ------------------------------- */

/** Strip markup to plain text (scripts/styles out, entities decoded). */
function htmlToText(html) {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
