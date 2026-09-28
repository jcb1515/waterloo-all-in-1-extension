// @ts-check
/*
  Portal adapter — passive observe only. portalapi2.uwaterloo.ca needs bearer
  tokens we don't hold, so the recorder relays API responses the student
  generates while browsing portal.uwaterloo.ca. Mappers live in map.js.

  Scope-mode merges replace `courses`/`terms` wholesale, so state keeps them
  as maps and every observe returns the full accumulated list.
*/

import { mapEnrollments, mapEvents, mapExams, mapSchedule, termWeeks } from "./map.js";

/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */
/** @typedef {import("../../core/contract.js").SyncContext} SyncContext */
/** @typedef {import("../../core/contract.js").Item} Item */

const URL_PATTERNS = [
  "^https://portalapi2\\.uwaterloo\\.ca/v2/student/CourseSchedule/?(\\?|$)",
  "^https://portalapi2\\.uwaterloo\\.ca/v2/student/ExamSchedule/?(\\?|$)",
  "^https://portalapi2\\.uwaterloo\\.ca/v2/student/CourseEnrollments/",
  "^https://portalapi2\\.uwaterloo\\.ca/v2/Calendar/DailyEventsV2",
];

/** Merge a course patch into the state map: sections/instructors union, fields overwrite. */
function mergeCourse(map, p) {
  const cur = map[p.code] || { code: p.code };
  if (p.name) cur.name = p.name;
  if (p.term != null) cur.term = p.term;
  if (p.outlineUrl) cur.outlineUrl = p.outlineUrl;
  const sections = [...new Set([...(cur.sections || []), ...(p.sections || [])])];
  if (sections.length) cur.sections = sections;
  if (Array.isArray(p.instructors) && p.instructors.length) {
    const list = cur.instructors || [];
    for (const i of p.instructors) {
      if (!list.some((c) => c.name === i.name && c.section === i.section)) list.push(i);
    }
    cur.instructors = list;
  }
  map[p.code] = cur;
}

/** Merge a term patch field-wise; nested ranges merge sub-field-wise. */
function mergeTerm(map, p) {
  const cur = map[p.termCode] || { termCode: p.termCode };
  for (const k of ["start", "end", "readingWeek", "midtermWeek", "examPeriod", "weeks"]) {
    if (p[k] == null) continue;
    cur[k] =
      typeof p[k] === "object" && !Array.isArray(p[k]) && typeof cur[k] === "object" && cur[k] !== null
        ? { ...cur[k], ...p[k] }
        : p[k];
  }
  map[p.termCode] = cur;
}

const lists = (state) => {
  /** @type {{courses?: any[], terms?: any[]}} */
  const r = {};
  const courses = Object.values(state.courses || {});
  // Week numbers are derived on the way out — never stored in state.
  const terms = Object.values(state.terms || {}).map((t) =>
    t && t.start && t.end ? { ...t, weeks: termWeeks(t.start, t.end) } : t,
  );
  if (courses.length) r.courses = courses;
  if (terms.length) r.terms = terms;
  return r;
};

/** @type {import("../../core/contract.js").Adapter} */
const adapter = {
  id: "portal",
  label: "Portal",
  origins: ["https://portal.uwaterloo.ca"],
  intervalMinutes: 0,
  syncOnTabOpen: false,

  /** Portal's API needs a bearer token — nothing to pull directly. */
  async sync(ctx) {
    const state = ctx.state || {};
    return { items: [], ...lists(state), complete: false, session: "no-tab", state };
  },

  observe: {
    urlPatterns: URL_PATTERNS,
    /**
     * @param {import("../../core/contract.js").ObservedPayload} payload
     * @param {SyncContext} ctx
     * @returns {Promise<SyncResult & {scope: string}>}
     */
    async parse(payload, ctx) {
      const prev = ctx.state && typeof ctx.state === "object" ? ctx.state : {};
      /** @type {{courses: Record<string, any>, terms: Record<string, any>,
       *   instructors: Record<string, {name: string, email?: string}[]>,
       *   examIndex?: Record<string, any[]>, tstIndex?: Record<string, any[]>}} */
      const state = {
        ...prev,
        courses: { ...prev.courses },
        terms: { ...prev.terms },
        instructors: { ...prev.instructors },
      };

      if (payload.status === 401 || payload.status === 403) {
        return { items: [], complete: false, scope: "portal:none", session: "signed-out", state };
      }
      let body;
      try {
        body = JSON.parse(String(payload.body || ""));
      } catch {
        return { items: [], complete: false, scope: "portal:none", state };
      }
      if (!body || body.meta?.type !== "success") {
        return { items: [], complete: false, scope: "portal:none", state };
      }

      let path = "";
      /** @type {URLSearchParams|null} */
      let query = null;
      try {
        const u = new URL(String(payload.url || ""));
        path = u.pathname;
        query = u.searchParams;
      } catch {
        return { items: [], complete: false, scope: "portal:none", state };
      }

      /** @type {Item[]} */
      let items = [];
      let scope = "portal:none";
      const at = payload.at;

      if (/student\/CourseSchedule\/?$/i.test(path)) {
        scope = "portal:schedule";
        const r = mapSchedule(body.data || [], {
          scope,
          at,
          instructors: state.instructors,
          examIndex: state.examIndex,
        });
        items = r.items;
        state.tstIndex = r.tstIndex;
        for (const p of r.patches) mergeCourse(state.courses, p);
      } else if (/student\/ExamSchedule\/?$/i.test(path)) {
        scope = "portal:exams";
        // The term's exam period (from a TermInfo read, else adapter ctx) is
        // what lets an unscheduled final become a tentative exam window.
        const terms = { ...state.terms };
        for (const t of ctx.terms || []) {
          if (t && t.termCode != null && terms[t.termCode] == null) terms[t.termCode] = t;
        }
        const r = mapExams(body.data || [], {
          scope,
          at,
          terms,
          courses: state.courses,
          tstIndex: state.tstIndex,
        });
        items = r.items;
        state.examIndex = r.examIndex;
      } else if (/student\/CourseEnrollments\//i.test(path)) {
        scope = "portal:enrollments";
        const rows = Array.isArray(body.data)
          ? body.data
          : body.data && Array.isArray(body.data.courseEnrollmentData)
            ? body.data.courseEnrollmentData
            : [];
        const r = mapEnrollments(rows, { now: ctx.now || new Date() });
        for (const p of r.patches) mergeCourse(state.courses, p);
        for (const [key, names] of Object.entries(r.instructors)) {
          const cur = [...(state.instructors[key] || [])];
          for (const i of names) if (!cur.some((c) => c.name === i.name)) cur.push(i);
          state.instructors[key] = cur;
        }
      } else if (/Calendar\/DailyEventsV2/i.test(path)) {
        const start = query && query.get("start");
        const end = query && query.get("end");
        scope = start || end ? `portal:events:${start || ""}..${end || ""}` : "portal:events";
        const r = mapEvents(body.data || [], { scope, at });
        items = r.items;
        for (const t of r.terms) mergeTerm(state.terms, t);
      } else {
        return { items: [], complete: false, scope: "portal:none", state };
      }

      return {
        items,
        ...lists(state),
        complete: true,
        readOk: [scope],
        scope,
        // No session on a successful read: the scheduler only refreshes
        // lastOkAt/itemCount/complete when `session` is absent.
        state,
      };
    },
  },
};

export default adapter;
