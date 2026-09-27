// @ts-check
// WaterlooWorks adapter (Window 3, co-op stream).
//
// WW is Orbis: every data load is a POST carrying a per-session encrypted
// action token, so background fetch (T1) and tab-relay replay (T2) cannot
// reproduce them. This adapter is T3-only: the recorder forwards matching
// page-network responses and content.js sends rendered-DOM snapshots; both
// arrive here as ObservedPayloads and get parsed in the offscreen document.

import { EXPECTED_SCOPES, OBSERVE_PATTERNS } from "./selectors.js";
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

/** Scopes whose output is calendar items (cached under state.lastGood). */
const ITEM_SCOPES = ["interviews", "interviewDetail", "events", "posting"];
/** Primary-scope reporting order when a payload carries several sections. */
const SCOPE_PRIORITY = [
  "applications", "interviews", "events", "posting",
  "interview-detail", "messages", "message-detail", "rankings",
];
const MAX_STORED = 50;

/**
 * Every cached item from state.lastGood, interview list/detail merged by id.
 * @param {Record<string, any>} state
 */
function cachedItems(state) {
  const lastGood = state.lastGood || {};
  return mergeInterviewScopes(
    lastGood.interviews?.items || [],
    lastGood.interviewDetail?.items || []
  ).concat(lastGood.events?.items || [], lastGood.posting?.items || []);
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
      state.lastSeenAt = payload.at;

      const body = String(payload.body || "").trim();
      if (body.startsWith("{") || body.startsWith("[")) {
        // A WW JSON response — its shape isn't known yet. Once a discovery
        // capture exists this is where it maps to items/applications.
        state.lastJsonAt = payload.at;
        return {
          items: [],
          applications: state.applications || [],
          complete: false,
          scope: "json",
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
          scope: "session",
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
          scope: parsed.page === "unknown" ? "unknown" : parsed.page,
          state,
        };
      }

      const now = ctx.now || new Date();
      /** @type {Record<string, import("../../core/contract.js").Item[]>} */
      const freshItems = {};
      const readOk = [];
      const found = new Set(
        Object.keys(parsed).filter((key) => key !== "page" && key !== "complete")
      );

      if (parsed.applications) {
        const next = toApplications(parsed.applications.rows);
        const { applications, updates } = diffApplications(
          prev.applications,
          next,
          now
        );
        state.applications = applications;
        // The core picks Updates up from here until W1 decides otherwise.
        state.lastUpdates = updates;
        readOk.push("applications");
        delete state.needsUpdate.applications;
      }
      if (parsed.interviews) {
        freshItems.interviews = interviewItems(parsed.interviews.rows, now);
        readOk.push("interviews");
        delete state.needsUpdate.interviews;
      }
      if (parsed.interviewDetail) {
        freshItems.interviewDetail = interviewDetailItems(
          parsed.interviewDetail,
          now
        );
        readOk.push("interviewDetail");
        delete state.needsUpdate.interviewDetail;
      }
      if (parsed.events) {
        freshItems.events = eventItems(parsed.events.rows, now);
        readOk.push("events");
        delete state.needsUpdate.events;
      }
      if (parsed.posting) {
        freshItems.posting = postingItems(parsed.posting, now);
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
      if (parsed.messageDetail) {
        state.messageDetails = mergeRecent(
          prev.messageDetails,
          [parsed.messageDetail],
          (row) => `${row.subject}|${row.createdAt}`,
          MAX_STORED
        );
        readOk.push("messageDetail");
        delete state.needsUpdate.messageDetail;
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
      // the layout changed (or the DOM snapshot was taken before the grid
      // rendered). Keep that scope's lastGood and flag it for review — but
      // only on evidence that the page had actually finished loading.
      // Past the bail above, every payload is a net response or a complete
      // DOM snapshot, so a missing expected section really is a layout change.
      const failed = [];
      const file = pathOf(payload.url).split("/").pop() || "";
      const expectedGroups = Object.hasOwn(EXPECTED_SCOPES, file)
        ? [EXPECTED_SCOPES[file]]
        : [];
      for (const expected of expectedGroups) {
        if (expected.some((scope) => found.has(scope))) continue;
        state.needsUpdate[expected[0]] = true;
        failed.push(expected[0]);
      }

      for (const scope of ITEM_SCOPES) {
        if (freshItems[scope]) {
          state.lastGood[scope] = { items: freshItems[scope], at: payload.at };
        }
      }

      const items = mergeInterviewScopes(
        freshItems.interviews || state.lastGood.interviews?.items || [],
        freshItems.interviewDetail || state.lastGood.interviewDetail?.items || []
      ).concat(
        freshItems.events || state.lastGood.events?.items || [],
        freshItems.posting || state.lastGood.posting?.items || []
      );
      if (state.applications) state.applications = linkItems(state.applications, items);
      if (!Object.keys(state.needsUpdate).length) delete state.needsUpdate;

      /** @type {SyncResult & {scope: string}} */
      const result = {
        items,
        applications: state.applications || [],
        complete: readOk.length > 0 && failed.length === 0,
        // Scopes report in detectPage's kebab-case names; `found` holds
        // parseAll's camelCase keys.
        scope:
          SCOPE_PRIORITY.find((scope) =>
            found.has(scope.replace(/-([a-z])/g, (_, c) => c.toUpperCase()))
          ) || "unknown",
        state,
      };
      if (readOk.length) result.readOk = readOk;
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
