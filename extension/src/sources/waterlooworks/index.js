// @ts-check
// WaterlooWorks adapter (Window 3, co-op stream).
//
// WW is Orbis: every data load is a POST carrying a per-session encrypted
// action token, so background fetch (T1) and tab-relay replay (T2) cannot
// reproduce them. This adapter is T3-only: the recorder forwards matching
// page-network responses and content.js sends rendered-DOM snapshots; both
// arrive here as ObservedPayloads and get parsed in the offscreen document.

import {
  EXPECTED_SCOPES,
  OBSERVE_PATTERNS,
  SCOPE,
  COOP_DATES_URL,
} from "./selectors.js";
import {
  toApplications,
  interviewItems,
  interviewDetailItems,
  eventItems,
  postingItems,
  linkItems,
  mergeInterviewScopes,
  messageDateItems,
  messageKey,
  coopDateItems,
} from "./map.js";
import { diffApplications } from "./diff.js";

/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */

const MAX_STORED = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Per-job scopes accumulate; each page describes ONE job. Days before prune. */
const JOB_SCOPES = { "posting": 14, "interview-detail": 30 };
const JOB_SCOPE_CAP = 200;
/** message-dates accumulates per message key; days before prune / item cap. */
const MESSAGE_SCOPE_AGE_DAYS = 60;
const MESSAGE_SCOPE_CAP = 300;
/** The public co-op important-dates page is fetched at most once a day. */
const COOP_FETCH_MS = DAY_MS;

/**
 * Every cached item from state.lastGood, interview list/detail merged by id.
 * @param {Record<string, any>} state
 */
function cachedItems(state) {
  const lastGood = state.lastGood || {};
  return mergeInterviewScopes(
    lastGood.interviews?.items || [],
    lastGood["interview-detail"]?.items || []
  ).concat(
    lastGood.events?.items || [],
    lastGood.posting?.items || [],
    lastGood["message-dates"]?.items || [],
    lastGood["coop-dates"]?.items || []
  );
}

/**
 * The item's anchor instant (its own date), or NaN when none parses.
 * @param {any} item
 */
function anchorMs(item) {
  return Date.parse(item?.endAt || item?.startAt || item?.dueAt || "");
}

/**
 * Keyed accumulate: prev items whose key isn't in this payload survive; items
 * for the key(s) read this time are replaced by the fresh read — or removed
 * when the read produced none (expired posting deadline, a timeslot item after
 * the interview got booked, a re-read message with no dates). Then prune
 * stale items and cap.
 * @param {any[]} prevItems
 * @param {any[]} freshItems
 * @param {any[]} keys       keys present in this payload
 * @param {(item: any) => string|undefined} keyOf
 * @param {number} nowMs
 * @param {number} maxAgeDays
 * @param {number} cap
 */
function accumulateKeyedItems(prevItems, freshItems, keys, keyOf, nowMs, maxAgeDays, cap) {
  const present = new Set((keys || []).filter(Boolean));
  const combined = [
    ...(prevItems || []).filter((item) => !present.has(keyOf(item))),
    ...(freshItems || []),
  ];
  return pruneItems(combined, nowMs, maxAgeDays, cap);
}

/**
 * message-dates accumulate keyed on meta.messageKey. A detail read replaces
 * ALL of that message's items; a list read replaces only the list-origin
 * items and never reintroduces an id a detail item already has — the body
 * read is richer, so detail wins.
 * @param {any[]} prevItems @param {any[]} freshItems @param {any[]} keys
 * @param {"list"|"detail"} origin @param {number} nowMs
 */
function accumulateMessageItems(prevItems, freshItems, keys, origin, nowMs) {
  const present = new Set((keys || []).filter(Boolean));
  const kept = (prevItems || []).filter((item) => {
    if (!present.has(item?.meta?.messageKey)) return true;
    if (origin === "detail") return false;
    return item?.meta?.messageOrigin === "detail";
  });
  const keptIds = new Set(kept.map((item) => item.id));
  const combined = [
    ...kept,
    ...(freshItems || []).filter(
      (item) => origin !== "list" || !keptIds.has(item.id)
    ),
  ];
  return pruneItems(combined, nowMs, MESSAGE_SCOPE_AGE_DAYS, MESSAGE_SCOPE_CAP);
}

/**
 * Drop items whose anchor date is older than maxAgeDays, then cap by dropping
 * the oldest-anchored items first (survivors keep their order).
 * @param {any[]} items @param {number} nowMs @param {number} maxAgeDays @param {number} cap
 */
function pruneItems(items, nowMs, maxAgeDays, cap) {
  const cutoff = nowMs - maxAgeDays * DAY_MS;
  const kept = items.filter((item) => {
    const anchor = anchorMs(item);
    return Number.isNaN(anchor) || anchor >= cutoff;
  });
  if (kept.length <= cap) return kept;
  const ranked = kept
    .map((item, i) => ({ item, i, anchor: anchorMs(item) }))
    .sort((a, b) => a.anchor - b.anchor || a.i - b.i);
  const drop = new Set(ranked.slice(0, kept.length - cap).map((r) => r.i));
  return kept.filter((_, i) => !drop.has(i));
}

/** Per-job accumulate, keyed on meta.jobId. */
function accumulateJobItems(prevItems, freshItems, jobIds, nowMs, maxAgeDays) {
  return accumulateKeyedItems(
    prevItems,
    freshItems,
    jobIds,
    (item) => item?.meta?.jobId,
    nowMs,
    maxAgeDays,
    JOB_SCOPE_CAP
  );
}

/**
 * Run message-date extraction over a batch of messages and fold the items
 * into lastGood["message-dates"], keyed per message. A detail read replaces
 * that message's items outright; a list read only replaces list-origin items
 * (the body read is richer, so detail wins).
 * @param {Record<string, any>} state
 * @param {any[]} msgs
 * @param {"list"|"detail"} origin
 * @param {any} extractDates  ctx.textDates
 * @param {Date} now
 * @param {string} at
 */
function deriveMessageDates(state, msgs, origin, extractDates, now, at) {
  if (typeof extractDates !== "function") return;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const keys = msgs.map((msg) => messageKey(msg.subject, msg.sentAt, now));
  const fresh = msgs.flatMap((msg) =>
    messageDateItems({ ...msg, origin }, extractDates, nowIso)
  );
  state.lastGood["message-dates"] = {
    items: accumulateMessageItems(
      state.lastGood["message-dates"]?.items,
      fresh,
      keys,
      origin,
      nowMs
    ),
    at,
  };
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
  intervalMinutes: 1440, // daily: the co-op important-dates fetch below
  syncOnTabOpen: false,

  /**
   * T1/T2 cannot replay WW requests, so sync returns the cached picture and
   * additionally refreshes the PUBLIC co-op important-dates page (plain GET,
   * no session) at most once per 24 h. session: "no-tab" — the core surfaces
   * "open WaterlooWorks to refresh" for the observed parts.
   * @param {import("../../core/contract.js").SyncContext} ctx
   * @returns {Promise<SyncResult>}
   */
  async sync(ctx) {
    const prev = ctx.state && typeof ctx.state === "object" ? ctx.state : {};
    /** @type {Record<string, any>} */
    const state = {
      ...prev,
      lastGood: { ...prev.lastGood },
      needsUpdate: { ...prev.needsUpdate },
    };
    const now = ctx.now || new Date();
    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const settings = ctx.settings || {};
    let fetchedOk = false;

    if (settings.coopDates !== false && typeof ctx.fetch === "function") {
      const url = settings.coopDatesUrl || COOP_DATES_URL;
      const lastFetch = Date.parse(state.coopDates?.fetchedAt || "");
      if (!Number.isFinite(lastFetch) || nowMs - lastFetch >= COOP_FETCH_MS) {
        state.coopDates = { ...state.coopDates, fetchedAt: nowIso };
        try {
          const res = await ctx.fetch(url);
          if (res && res.status >= 200 && res.status < 300 && res.text) {
            const parsed = await ctx.parseHtml(
              res.text,
              "waterlooworks/parseCoopDates"
            );
            if (parsed && parsed.ok !== false) {
              state.lastGood["coop-dates"] = {
                items: coopDateItems(parsed.entries || [], { url, nowIso }),
                at: nowIso,
              };
              delete state.needsUpdate["coop-dates"];
              fetchedOk = true;
            } else {
              // 2xx but no calendar tables — the page layout changed.
              state.needsUpdate["coop-dates"] = true;
            }
          }
          // Non-2xx / empty body: keep last good, fail soft.
        } catch {
          // Fetch or parser threw: keep last good.
        }
      }
    }

    if (!Object.keys(state.needsUpdate).length) delete state.needsUpdate;
    // complete only on a successful authoritative read: the cached union then
    // replaces the stored picture wholesale (a co-op date that vanished from
    // the page drops out); on failure/throttle the union merge keeps cache.
    return {
      items: cachedItems(state),
      applications: state.applications || [],
      complete: fetchedOk,
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
        const rows = parsed.messages.rows || [];
        state.messages = mergeRecent(
          prev.messages,
          rows.map((row) => ({
            subject: row.subject,
            receivedAt: row.receivedAt,
            from: row.from,
            priority: row.priority,
          })),
          (row) => `${row.subject}|${row.receivedAt}|${row.from}`,
          MAX_STORED
        );
        // Inbox rows have no body — date items come from the subject alone.
        deriveMessageDates(
          state,
          rows.map((row) => ({
            subject: row.subject,
            sentAt: row.receivedAt,
            text: row.subject,
            url: payload.url,
          })),
          "list",
          ctx.textDates,
          now,
          payload.at
        );
        readOk.push("messages");
        delete state.needsUpdate.messages;
      }
      if (parsed["message-detail"]) {
        const detail = parsed["message-detail"];
        state.messageDetails = mergeRecent(
          prev.messageDetails,
          // Metadata only — bodyText is transient and never persisted.
          [
            {
              subject: detail.subject,
              category: detail.category,
              subCategory: detail.subCategory,
              attachedTo: detail.attachedTo,
              createdAt: detail.createdAt,
              linkedJobId: detail.linkedJobId,
              linkedJobTitle: detail.linkedJobTitle,
            },
          ],
          (row) => `${row.subject}|${row.createdAt}`,
          MAX_STORED
        );
        const employer = detail.linkedJobId
          ? (state.applications || []).find(
              (app) => app.jobId === detail.linkedJobId
            )?.employer
          : undefined;
        deriveMessageDates(
          state,
          [
            {
              subject: detail.subject,
              sentAt: detail.createdAt,
              text: `${detail.subject || ""}\n${detail.bodyText || ""}`,
              url: payload.url,
              category: detail.category,
              employer,
            },
          ],
          "detail",
          ctx.textDates,
          now,
          payload.at
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
