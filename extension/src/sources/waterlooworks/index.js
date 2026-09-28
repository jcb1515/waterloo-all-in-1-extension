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
  scheduleItems,
  dashboardEventItems,
  postingItems,
  linkItems,
  mergeInterviewScopes,
  mergeItemById,
  messageDateItems,
  messageKey,
  coopDateItems,
} from "./map.js";
import { diffApplications } from "./diff.js";

/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */

const MAX_STORED = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Replace-scope caches are bounded so a huge table can't grow state. */
const LAST_GOOD_CAP = 500;
const APPLICATIONS_CAP = 500;
/** Non-array input (garbage state) reads as empty. */
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};
/** Per-job scopes accumulate; each page describes ONE job. Days before prune. */
const JOB_SCOPES = { "posting": 14, "interview-detail": 30 };
const JOB_SCOPE_CAP = 200;
/** message-dates accumulates per message key; days before prune / item cap. */
const MESSAGE_SCOPE_AGE_DAYS = 60;
const MESSAGE_SCOPE_CAP = 300;
/** The public co-op important-dates page is fetched at most once a day. */
const COOP_FETCH_MS = DAY_MS;
/** Bump whenever parseCoopDates/coopDateItems/COOP_CATEGORIES change output. */
export const COOP_DATES_VERSION = 2;
/** The parsed public entry list kept on state (public data, no personal info). */
const COOP_ENTRIES_CAP = 400;

/**
 * Re-map stored public entries when the mapping version moved — no fetch.
 * Upgraded installs whose coopDates record has no `entries` keep the old
 * lastGood until the next fetch; sync bypasses the 24 h throttle then.
 * @param {Record<string, any>} state  mutated in place
 * @param {string} nowIso
 */
export function refreshCoopDates(state, nowIso) {
  const cd = obj(state.coopDates);
  if (cd.version === COOP_DATES_VERSION) return;
  const entries = arr(cd.entries);
  if (!entries.length) return;
  state.coopDates = { ...cd, version: COOP_DATES_VERSION };
  state.lastGood["coop-dates"] = {
    items: coopDateItems(entries, { url: COOP_DATES_URL, nowIso }).slice(
      0,
      LAST_GOOD_CAP
    ),
    at: nowIso,
  };
}

/**
 * Dedupe key for event items: a dashboard "upcoming events" row and an
 * event-registrations row for the same session share title + start time.
 * @param {any} item
 */
const eventDupKey = (item) =>
  item?.type === "event" && item.startAt && item.title
    ? `${item.startAt}|${String(item.title)
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim()}`
    : null;

/**
 * Every cached item from state.lastGood, interview list/detail merged by id.
 * Dashboard buckets come first: schedule interview items reuse
 * `interview:<jobId>` ids, and the id dedupe keeps the LATER (richer) entry,
 * so the sparsest buckets lead. A dashboard event that names the same event
 * at the same start as a registrations-grid row is dropped — the grid read
 * carries the registration status.
 * @param {Record<string, any>} state
 */
function cachedItems(state) {
  const lastGood = obj(state.lastGood);
  const dashEvents = arr(lastGood["dash-events"]?.items);
  const rest = mergeInterviewScopes(
    arr(lastGood.interviews?.items),
    arr(lastGood["interview-detail"]?.items)
  ).concat(
    arr(lastGood.events?.items),
    arr(lastGood.posting?.items),
    arr(lastGood["message-dates"]?.items),
    arr(lastGood["coop-dates"]?.items)
  );
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const item of [
    ...arr(lastGood.schedule?.items),
    ...dashEvents,
    ...rest,
  ]) {
    if (!item || !item.id) continue;
    const earlier = byId.get(item.id);
    // Later item wins per field; the earlier one fills what it lacks —
    // a dashboard schedule's endAt survives the interviews-list row.
    byId.set(item.id, earlier ? mergeItemById(earlier, item) : item);
  }
  // A registrations-grid row duplicates a dashboard event (the grid only
  // lists events the student registered for): keep the dashboard item,
  // upgraded to registered, and drop the grid copy.
  const dashEventKeys = new Set(dashEvents.map(eventDupKey).filter(Boolean));
  const dupEventKeys = new Set(
    rest.map(eventDupKey).filter((k) => k && dashEventKeys.has(k))
  );
  const out = [];
  for (const item of byId.values()) {
    const key = eventDupKey(item);
    if (!key || !dupEventKeys.has(key)) {
      out.push(item);
      continue;
    }
    if (!dashEvents.includes(item)) continue; // rest-side dup — dropped.
    if (item.review === "pending" || item.meta?.registered === false) {
      out.push({
        ...item,
        review: "auto",
        meta: { ...item.meta, registered: true, waitlisted: undefined },
      });
    } else {
      out.push(item);
    }
  }
  return out;
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
  const present = new Set(arr(keys).filter(Boolean));
  const combined = [
    ...arr(prevItems).filter((item) => !present.has(keyOf(item))),
    ...arr(freshItems),
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
  const present = new Set(arr(keys).filter(Boolean));
  const kept = arr(prevItems).filter((item) => {
    if (!present.has(item?.meta?.messageKey)) return true;
    if (origin === "detail") return false;
    return item?.meta?.messageOrigin === "detail";
  });
  const keptIds = new Set(kept.map((item) => item.id));
  const combined = [
    ...kept,
    ...arr(freshItems).filter(
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
  const kept = arr(items).filter((item) => {
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
  for (const row of [...arr(next), ...arr(prev)]) {
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
    refreshCoopDates(state, nowIso);

    if (settings.coopDates !== false && typeof ctx.fetch === "function") {
      const url = settings.coopDatesUrl || COOP_DATES_URL;
      const lastFetch = Date.parse(state.coopDates?.fetchedAt || "");
      // A stale mapping version with no stored entries means this install
      // upgraded before entries existed — fetch now, throttle be damned.
      const staleVersion = state.coopDates?.version !== COOP_DATES_VERSION;
      if (
        !Number.isFinite(lastFetch) ||
        nowMs - lastFetch >= COOP_FETCH_MS ||
        staleVersion
      ) {
        state.coopDates = { ...state.coopDates, fetchedAt: nowIso };
        try {
          const res = await ctx.fetch(url);
          if (res && res.status >= 200 && res.status < 300 && res.text) {
            const parsed = await ctx.parseHtml(
              res.text,
              "waterlooworks/parseCoopDates"
            );
            if (parsed && typeof parsed === "object" && parsed.ok !== false) {
              const entries = arr(parsed.entries).slice(0, COOP_ENTRIES_CAP);
              state.coopDates = {
                fetchedAt: nowIso,
                version: COOP_DATES_VERSION,
                entries,
              };
              state.lastGood["coop-dates"] = {
                items: coopDateItems(entries, {
                  url,
                  nowIso,
                }).slice(0, LAST_GOOD_CAP),
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
      applications: arr(state.applications),
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
      refreshCoopDates(state, payload.at);

      const body = String(payload.body || "").trim();
      if (body.startsWith("{") || body.startsWith("[")) {
        // A WW JSON response — its shape isn't known yet. Once a discovery
        // capture exists this is where it maps to items/applications.
        state.lastJsonAt = payload.at;
        return {
          items: cachedItems(state),
          applications: arr(state.applications),
          complete: false,
          scope: SCOPE,
          state,
        };
      }

      let parsed;
      try {
        parsed = await ctx.parseHtml(body, "waterlooworks/parseAll", {
          url: payload.url,
        });
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== "object") parsed = {};

      if (parsed.page === "logged-out") {
        state.signedOutAt = payload.at;
        return {
          items: cachedItems(state),
          applications: arr(state.applications),
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
          applications: arr(state.applications),
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
        const next = toApplications(obj(parsed.applications).rows);
        const diff = diffApplications(
          arr(prev.applications),
          next,
          now
        );
        state.applications = diff.applications.slice(0, APPLICATIONS_CAP);
        updates = diff.updates;
        readOk.push("applications");
        delete state.needsUpdate.applications;
      }
      if (parsed.interviews) {
        // The list page is a full table: replace the scope.
        state.lastGood.interviews = {
          items: interviewItems(obj(parsed.interviews).rows, now).slice(
            0,
            LAST_GOOD_CAP
          ),
          at: payload.at,
        };
        readOk.push("interviews");
        delete state.needsUpdate.interviews;
      }
      if (parsed["interview-detail"]) {
        // One detail page = one job: keep other jobs' items, replace this
        // job's (a booked detail drops that job's timeslot item).
        const fresh = interviewDetailItems(obj(parsed["interview-detail"]), now);
        state.lastGood["interview-detail"] = {
          items: accumulateJobItems(
            arr(state.lastGood["interview-detail"]?.items),
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
          items: eventItems(obj(parsed.events).rows, now).slice(
            0,
            LAST_GOOD_CAP
          ),
          at: payload.at,
        };
        readOk.push("events");
        delete state.needsUpdate.events;
      }
      if (parsed.posting) {
        // Same per-job accumulate: viewing job B keeps job A's deadline item;
        // a posting with no future deadline removes that job's item.
        const fresh = postingItems(obj(parsed.posting), now);
        state.lastGood.posting = {
          items: accumulateJobItems(
            arr(state.lastGood.posting?.items),
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
        const rows = arr(obj(parsed.messages).rows);
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
      if (parsed.dashboard) {
        // Multi-module page: each module that was present replaces its own
        // lastGood bucket; absent modules keep theirs (AJAX fragments and
        // early snapshots rarely carry the whole page).
        const dash = obj(parsed.dashboard);
        if (dash.schedule) {
          state.lastGood.schedule = {
            items: scheduleItems(
              arr(obj(dash.schedule).rows),
              arr(state.applications),
              now
            ).slice(0, LAST_GOOD_CAP),
            at: payload.at,
          };
        }
        if (dash.events) {
          state.lastGood["dash-events"] = {
            items: dashboardEventItems(arr(obj(dash.events).rows), now, {
              url: payload.url,
            }).slice(0, LAST_GOOD_CAP),
            at: payload.at,
          };
        }
        if (dash.rankings) {
          const rank = obj(dash.rankings);
          state.rankings = {
            term: rank.term,
            open: rank.open !== false,
            note: rank.note,
            at: payload.at,
          };
        }
        readOk.push("dashboard");
        delete state.needsUpdate.dashboard;
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
        applications: arr(state.applications),
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
