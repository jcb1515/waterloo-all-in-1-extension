// @ts-check
// Read-only page probe for the "Check readers" screen — COUNTS ONLY.
// Never returns text, names or ids: counts tell the user whether the
// parser found the structure it expects on the open page. Pure DOM:
// no chrome APIs, no fetch, no Node imports (content-script safe).
// Never throws — an unreadable doc reports {page:"unknown"}.

import {
  detectPage,
  parseApplications,
  parseInterviews,
  parseEventRegistrations,
  parseMessages,
  parsePosting,
  parseInterviewDetail,
  parseMessageDetail,
  parseRankings,
  parseDashboard,
} from "./parsers.js";

/** @typedef {{page: string, counts: Record<string, number>, ok: boolean, hints: string[]}} ProbeResult */

const UNKNOWN = () => ({
  page: "unknown",
  counts: {},
  ok: false,
  hints: ["This doesn't look like a WaterlooWorks page — open one of the checklist pages."],
});

/** Count of defined fields in a parsed record. */
const countFields = (obj, keys) =>
  keys.filter((k) => obj?.[k] !== undefined && obj?.[k] !== "").length;

/** The interview-detail fields a student cares about being readable. */
const DETAIL_FIELD_KEYS = [
  "interviewType", "locationType", "status", "bookingPermission",
  "instructions", "interviewer", "method", "webcamId", "where",
  "jobId", "jobTitle", "employer", "startAt",
];

/**
 * Probe the open WaterlooWorks page: detect what it is and count the
 * structures the parsers depend on.
 * @param {any} doc  a Document (browser DOM or linkedom)
 * @param {string} [href]  the page URL (used for the logged-out path check)
 * @returns {ProbeResult}
 */
export function probe(doc, href) {
  try {
    if (!doc || typeof doc.querySelectorAll !== "function") return UNKNOWN();
    if (!doc.querySelectorAll("*").length) return UNKNOWN();
    const kind = detectPage(doc, { url: href });
    switch (kind) {
      case "logged-out":
        return {
          page: "signed-out",
          counts: {},
          ok: false,
          hints: ["Sign in to WaterlooWorks, then reopen this page."],
        };
      case "applications": {
        const res = parseApplications(doc);
        const counts = {
          tables: doc.querySelectorAll("table").length,
          rows: res.rows.length,
          withStatus: res.rows.filter((r) => r.appStatusText).length,
          withDeadline: res.rows.filter((r) => r.appDeadline).length,
        };
        const ok = counts.rows > 0;
        return {
          page: "applications",
          counts,
          ok,
          hints: ok
            ? counts.withDeadline === 0
              ? ["No application deadlines were readable — check the table columns."]
              : []
            : ["Open the Applications list once the table has loaded."],
        };
      }
      case "interviews": {
        const res = parseInterviews(doc);
        const counts = {
          rows: res.rows.length,
          withDateTime: res.rows.filter((r) => r.startAt).length,
        };
        const ok = counts.rows > 0;
        return {
          page: "interviews",
          counts,
          ok,
          hints: ok
            ? []
            : ["Open the Interviews list once the table has loaded."],
        };
      }
      case "interview-detail": {
        const res = parseInterviewDetail(doc);
        const counts = {
          fields: res.ok ? countFields(res, DETAIL_FIELD_KEYS) : 0,
          slots: res.slots?.length || 0,
          availableSlots:
            res.slots?.filter((s) => /available/i.test(s?.state || ""))
              .length || 0,
        };
        const ok = counts.fields > 0;
        const hints = [];
        if (!ok) {
          hints.push("Open one interview's details so its time slots can be checked.");
        } else if (counts.slots === 0 && !res.booked) {
          hints.push("No time slots visible — open the slot page if booking is still open.");
        }
        return { page: "interview-detail", counts, ok, hints };
      }
      case "posting": {
        const res = parsePosting(doc);
        const counts = {
          fields: res.ok ? Object.keys(res.fields || {}).length : 0,
          deadline: res.deadline ? 1 : 0,
        };
        const ok = counts.fields > 0;
        return {
          page: "posting",
          counts,
          ok,
          hints: ok
            ? counts.deadline === 0
              ? ["No application deadline field found on this posting."]
              : []
            : ["Open a full job posting page."],
        };
      }
      case "events": {
        // The registrations grid — either its own page or an older dashboard
        // layout (both report as the dashboard checklist entry).
        const res = parseEventRegistrations(doc);
        const counts = { eventRows: res.rows.length };
        const ok = counts.eventRows > 0;
        return {
          page: "dashboard",
          counts,
          ok,
          hints: ok ? [] : ["Open the WaterlooWorks dashboard."],
        };
      }
      case "dashboard": {
        const res = parseDashboard(doc);
        const counts = {
          scheduleTables: res.schedule?.tables ?? 0,
          scheduleRows: res.schedule?.rows.length ?? 0,
          eventDays: res.events?.tables ?? 0,
          eventRows: res.events?.rows.length ?? 0,
          newMessages: res.newMessages ?? 0,
          webcamToday: res.webcamAppointments ?? 0,
          rankingsNotice: res.rankings?.note ? 1 : 0,
        };
        const ok = counts.scheduleRows + counts.eventRows > 0;
        return {
          page: "dashboard",
          counts,
          ok,
          hints: ok
            ? []
            : [
                "Nothing dated was readable — reopen the dashboard once its modules have loaded.",
              ],
        };
      }
      case "messages": {
        const res = parseMessages(doc);
        const counts = { rows: res.rows.length };
        const ok = counts.rows > 0;
        return {
          page: "messages",
          counts,
          ok,
          hints: ok ? [] : ["Open the Messages inbox."],
        };
      }
      case "message-detail": {
        const res = parseMessageDetail(doc);
        const counts = {
          subject: res.subject ? 1 : 0,
          body: res.bodyText ? 1 : 0,
        };
        const ok = counts.subject > 0 || counts.body > 0;
        return {
          page: "message-detail",
          counts,
          ok,
          hints: ok ? [] : ["Open one message fully so its subject is readable."],
        };
      }
      case "rankings": {
        const res = parseRankings(doc);
        const counts = { notice: res.note ? 1 : 0 };
        return {
          page: "rankings",
          counts,
          ok: res.ok === true,
          hints:
            counts.notice === 0
              ? ["Rankings may be open — that layout isn't verified yet."]
              : [],
        };
      }
      default:
        return UNKNOWN();
    }
  } catch {
    return UNKNOWN();
  }
}

/**
 * Pages the "Check readers" flow asks the user to open.
 * `url` (when set) is a verified page the row's Open button can go to;
 * `essential` marks the rows onboarding insists on; `refreshDays` is how
 * often the row should see a fresh read.
 * @type {{id: string, label: string, how: string, url?: string,
 *   essential?: boolean, refreshDays?: number,
 *   stat?: {kind: "observe", scope: string}}[]}
 */
export const CHECKLIST = [
  {
    id: "applications",
    label: "Applications list",
    how: "WaterlooWorks → co-op → Applications",
    url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/applications.htm",
    essential: true,
    refreshDays: 7,
    stat: { kind: "observe", scope: "waterlooworks:applications" },
  },
  {
    id: "application-detail",
    label: "An application's detail",
    how: "Open one job from your applications list",
  },
  {
    id: "interviews",
    label: "Interviews list",
    how: "co-op → Interviews",
    url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/interviews.htm",
    essential: true,
    refreshDays: 3,
    stat: { kind: "observe", scope: "waterlooworks:interviews" },
  },
  {
    id: "interview-detail",
    label: "One interview's details",
    how: "Click an interview; if booking is open, open its time-slot page too",
  },
  {
    id: "posting",
    label: "A job posting",
    how: "Open any full job posting",
  },
  {
    id: "dashboard",
    label: "Dashboard",
    how: "WaterlooWorks → Dashboard (the page after you sign in)",
    url: "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm",
    essential: true,
    refreshDays: 3,
    stat: { kind: "observe", scope: "waterlooworks:dashboard" },
  },
  {
    id: "messages",
    label: "Messages inbox",
    how: "co-op → Messages",
  },
  {
    id: "message-detail",
    label: "One opened message",
    how: "Click a message subject in the inbox",
  },
  {
    id: "rankings",
    label: "Rankings",
    how: "co-op → Rankings tab",
  },
];
