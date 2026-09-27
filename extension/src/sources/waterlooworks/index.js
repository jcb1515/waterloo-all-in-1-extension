// @ts-check
// WaterlooWorks adapter (Window 3, co-op stream).
//
// WW is Orbis: every data load is a POST carrying a per-session encrypted
// action token, so background fetch (T1) and tab-relay replay (T2) cannot
// reproduce them. This adapter is T3-only: the recorder forwards matching
// page-network responses and content.js sends rendered-DOM snapshots; both
// arrive here as ObservedPayloads and get parsed in the offscreen document.

import { EXPECTED_SCOPES, OBSERVE_PATTERNS, SCOPE } from "./selectors.js";
import {
  toApplications,
  interviewItems,
  interviewDetailItems,
  eventItems,
  postingItems,
  linkItems,
  mergeInterviewScopes,
} from "./map.js";
import { diffApplications } from "./diff.js";

/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */

const MAX_STORED = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Per-job scopes accumulate; each page describes ONE job. Days before prune. */
const JOB_SCOPES = { "posting": 14, "interview-detail": 30 };
const JOB_SCOPE_CAP = 200;

/**
 * Every cached item from state.lastGood, interview list/detail merged by id.
 * @param {Record<string, any>} state
 */
function cachedItems(state) {
  const lastGood = state.lastGood || {};
  return mergeInterviewScopes(
    lastGood.interviews?.items || [],
    lastGood["interview-detail"]?.items || []
  ).concat(lastGood.events?.items || [], lastGood.posting?.items || []);
}

/**
 * The item's anchor instant (its own date), or NaN when none parses.
 * @param {any} item
 */
function anchorMs(item) {
  return Date.parse(item?.endAt || item?.startAt || item?.dueAt || "");
}

/**
 * Per-job accumulate: prev items from other jobs survive; items for the
 * job(s) in this payload are replaced by the fresh read — or removed when the
 * read produced none (expired posting deadline, a timeslot item after the
 * interview got booked). Then prune stale items and cap.
 * @param {any[]} prevItems
 * @param {any[]} freshItems
 * @param {any[]} jobIds   jobIds present in this payload
 * @param {number} nowMs
 * @param {number} maxAgeDays
 */
function accumulateJobItems(prevItems, freshItems, jobIds, nowMs, maxAgeDays) {
  const jobs = new Set((jobIds || []).filter(Boolean));
  const cutoff = nowMs - maxAgeDays * DAY_MS;
  const combined = [
    ...(prevItems || []).filter((item) => !jobs.has(item?.meta?.jobId)),
    ...(freshItems || []),
  ];
  const kept = combined.filter((item) => {
    const anchor = anchorMs(item);
    return Number.isNaN(anchor) || anchor >= cutoff;
  });
  if (kept.length <= JOB_SCOPE_CAP) return kept;
  // Drop the oldest by anchor date, preserving the order of survivors.
  const ranked = kept
    .map((item, i) => ({ item, i, anchor: anchorMs(item) }))
    .sort((a, b) => a.anchor - b.anchor || a.i - b.i);
  const drop = new Set(ranked.slice(0, kept.length - JOB_SCOPE_CAP).map((r) => r.i));
  return kept.filter((_, i) => !drop.has(i));
}

const pathOf = (url) => {
  try {
    return new URL(url, "https://waterlooworks.uwaterloo.ca").pathname;
  } catch {
    return "";
  }
};

/**
 * Keep the newest `limit` entries, deduped by a key function.
 * @param {any[]} prev
 * @param {any[]} next
 * @param {(row: any) => string} keyOf
 * @param {number} limit
 */
function mergeRecent(prev, next, keyOf, limit) {
  const seen = new Set();
  const merged = [];
  for (const row of [...(next || []), ...(prev || [])]) {
    const key = keyOf(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  merged.sort(
    (a, b) =>
      (Date.parse(b.receivedAt || b.createdAt || b.at || "") || 0) -
      (Date.parse(a.receivedAt || a.createdAt || a.at || "") || 0)
  );
  return merged.slice(0, limit);
}

/** @type {import("../../core/contract.js").Adapter} */
export default {
  id: "waterlooworks",
  label: "WaterlooWorks",
  origins: ["https://waterlooworks.uwaterloo.ca"],
  intervalMinutes: 0,
  syncOnTabOpen: false,

  /**
   * T1/T2 cannot replay WW requests, so sync just returns the cached picture;
   * the core surfaces "open WaterlooWorks to refresh" via session: "no-tab".
   * @param {import("../../core/contract.js").SyncContext} ctx
   * @returns {Promise<SyncResult>}
   */
  async sync(ctx) {
    const state = ctx.state && typeof ctx.state === "object" ? ctx.state : {};
    return {
      items: cachedItems(state),
      applications: state.applications || [],
      complete: false,
      session: "no-tab",
      state,
    };
  },

  observe: {
    urlPatterns: [...OBSERVE_PATTERNS],
    /**
     * @param {import("../../core/contract.js").ObservedPayload} payload
     * @param {import("../../core/contract.js").SyncContext} ctx
     * @returns {Promise<SyncResult & {scope: string}>}
     */
    async parse(payload, ctx) {
      const prev = ctx.state && typeof ctx.state === "object" ? ctx.state : {};
      /** @type {Record<string, any>} */
      const state = { ...prev, lastGood: { ...prev.lastGood }, needsUpdate: { ...prev.needsUpdate } };
      // Updates now ride on SyncResult.updates; drop any persisted copy.
      delete state.lastUpdates;
      state.lastSeenAt = payload.at;

      const body = String(payload.body || "").trim();
      if (body.startsWith("{") || body.startsWith("[")) {
        // A WW JSON response — its shape isn't known yet. Once a discovery
        // capture exists this is where it maps to items/applications.
        state.lastJsonAt = payload.at;
        return {
          items: cachedItems(state),
          applications: state.applications || [],
          complete: false,
          scope: SCOPE,
          state,
        };
      }

      const parsed = await ctx.parseHtml(body, "waterlooworks/parseAll", {
        url: payload.url,
      });

      if (parsed.page === "logged-out") {
        state.signedOutAt = payload.at;
        return {
          items: cachedItems(state),
          applications: state.applications || [],
          complete: false,
          scope: SCOPE,
          session: "signed-out",
          state,
        };
      }

      // A DOM snapshot without the complete marker may be mid-render — its
      // grids can be truncated. Parse it for the record but persist nothing:
      // it must not replace a good cache or flag needs-update.
      const domComplete = parsed.complete === true;
      if (payload.kind === "dom" && !domComplete) {
        return {
          items: cachedItems(state),
          applications: state.applications || [],
          complete: false,
          scope: SCOPE,
          state,
        };
      }

      const now = ctx.now || new Date();
      const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
      const readOk = [];
      /** @type {import("../../core/contract.js").Update[]|undefined} */
      let updates;
      const found = new Set(
        Object.keys(parsed).filter((key) => key !== "page" && key !== "complete")
      );

      if (parsed.applications) {
        const next = toApplications(parsed.applications.rows);
        const diff = diffApplications(
          prev.applications,
          next,
          now
        );
        state.applications = diff.applications;
        updates = diff.updates;
        readOk.push("applications");
        delete state.needsUpdate.applications;
      }
      if (parsed.interviews) {
        // The list page is a full table: replace the scope.
        state.lastGood.interviews = {
          items: interviewItems(parsed.interviews.rows, now),
          at: payload.at,
        };
        readOk.push("interviews");
        delete state.needsUpdate.interviews;
      }
      if (parsed["interview-detail"]) {
        // One detail page = one job: keep other jobs' items, replace this
        // job's (a booked detail drops that job's timeslot item).
        const fresh = interviewDetailItems(parsed["interview-detail"], now);
        state.lastGood["interview-detail"] = {
          items: accumulateJobItems(
            state.lastGood["interview-detail"]?.items,
            fresh,
            [parsed["interview-detail"].jobId],
            nowMs,
            JOB_SCOPES["interview-detail"]
          ),
          at: payload.at,
        };
        readOk.push("interview-detail");
        delete state.needsUpdate["interview-detail"];
      }
      if (parsed.events) {
        state.lastGood.events = {
          items: eventItems(parsed.events.rows, now),
          at: payload.at,
        };
        readOk.push("events");
        delete state.needsUpdate.events;
      }
      if (parsed.posting) {
        // Same per-job accumulate: viewing job B keeps job A's deadline item;
        // a posting with no future deadline removes that job's item.
        const fresh = postingItems(parsed.posting, now);
        state.lastGood.posting = {
          items: accumulateJobItems(
            state.lastGood.posting?.items,
            fresh,
            [parsed.posting.jobId],
            nowMs,
            JOB_SCOPES.posting
          ),
          at: payload.at,
        };
        readOk.push("posting");
        delete state.needsUpdate.posting;
      }
      if (parsed.messages) {
        state.messages = mergeRecent(
          prev.messages,
          parsed.messages.rows.map((row) => ({
            subject: row.subject,
            receivedAt: row.receivedAt,
            from: row.from,
            priority: row.priority,
          })),
          (row) => `${row.subject}|${row.receivedAt}|${row.from}`,
          MAX_STORED
        );
        readOk.push("messages");
        delete state.needsUpdate.messages;
      }
      if (parsed["message-detail"]) {
        state.messageDetails = mergeRecent(
          prev.messageDetails,
          [parsed["message-detail"]],
          (row) => `${row.subject}|${row.createdAt}`,
          MAX_STORED
        );
        readOk.push("message-detail");
        delete state.needsUpdate["message-detail"];
      }
      if (parsed.rankings) {
        state.rankings = {
          term: parsed.rankings.term,
          open: parsed.rankings.open,
          note: parsed.rankings.note,
          at: payload.at,
        };
        readOk.push("rankings");
        delete state.needsUpdate.rankings;
      }

      // Fail-soft: a URL that should have yielded a section but didn't means
      // the layout changed. Past the bail above, every payload is a net
      // response or a complete DOM snapshot, so a missing expected section
      // really is a layout change.
      const failed = [];
      const file = pathOf(payload.url).split("/").pop() || "";
      // Only full-page DOM snapshots count: WW's POST responses to the same
      // URLs are often partial fragments (posting modals, slot tables).
      const expectedGroups = payload.kind === "dom" && Object.hasOwn(EXPECTED_SCOPES, file)
        ? [EXPECTED_SCOPES[file]]
        : [];
      for (const expected of expectedGroups) {
        if (expected.some((scope) => found.has(scope))) continue;
        state.needsUpdate[expected[0]] = true;
        failed.push(expected[0]);
      }

      const items = cachedItems(state);
      if (state.applications) state.applications = linkItems(state.applications, items);
      if (!Object.keys(state.needsUpdate).length) delete state.needsUpdate;
      if (readOk.length) state.lastReadOk = readOk;

      // scope is always "waterlooworks": W1's scope-mode fold replaces stored
      // items whose seenIn scope matches, and every WW item reports that
      // scope — so the lastGood union above is authoritative for the source.
      /** @type {SyncResult & {scope: string}} */
      const result = {
        items,
        applications: state.applications || [],
        complete: readOk.length > 0 && failed.length === 0,
        scope: SCOPE,
        state,
      };
      if (readOk.length) result.readOk = [SCOPE];
      if (updates) result.updates = updates;
      if (failed.length) {
        result.error = {
          code: "needs-update",
          message: `WaterlooWorks page changed or unfinished: no ${failed.join("/")} data at ${pathOf(payload.url)}.`,
        };
      }
      return result;
    },
  },
};
