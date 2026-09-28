// @ts-check
/*
  Calendar feed publisher: builds the v2 payload from the stored merged
  items and POSTs/PUTs it to the self-hosted feed server (server/README.md).

  Fetch and storage are injectable so the whole flow is testable in node.
  Runtime state lives under the `calendarFeed` storage key — the
  updateToken and feed URLs are secrets: never log them, never hand them to
  the discovery recorder.
*/

import { buildFeedPayload, stableHash } from "./payload.js";
import {
  enqueue,
  getSettings,
  setSettings,
  getLocal,
  mutateKey,
  getMergedView,
} from "../core/store.js";

export const FEED_KEY = "calendarFeed";
export const PUBLISH_ALARM = "wa1:publish";
export const DAILY_ALARM = "wa1:publish-daily";

const MINUTE = 60000;
const SEVEN_DAYS = 7 * 86400000;
/** Retry backoff by consecutive failure count: 5, 15, then 60 minutes. */
const RETRY_MINUTES = [5, 15, 60];

/** @param {string} url */
export function validServiceUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol === "https:") return u.origin;
    // http is accepted only for local dev servers (wrangler dev).
    if (u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) {
      return u.origin;
    }
    return null;
  } catch {
    return null;
  }
}

function blankFeed(serviceUrl) {
  return {
    serviceUrl,
    feedId: null,
    updateToken: null,
    feedUrl: null,
    groupFeeds: null,
    expiresAt: null,
    lastPublishedAt: null,
    lastPayloadHash: null,
    eventCount: 0,
    accepted: 0,
    skipped: [],
    status: "idle",
    error: null,
    needsResubscribe: false,
    retryAt: null,
    failures: 0,
    failedHash: null,
  };
}

/**
 * Injected dependencies; the defaults hit chrome.storage and the network.
 * Tests override any of these via `deps`.
 */
function realDeps() {
  return {
    fetch: (/** @type {string} */ url, /** @type {any} */ init) => fetch(url, init),
    getSettings,
    setSettings,
    getLocal,
    mutateKey,
    removeKey: (/** @type {string} */ key) => chrome.storage.local.remove(key),
    getMergedView,
    alarm: (/** @type {string} */ name, /** @type {number} */ minutes) => {
      try {
        chrome.alarms.create(name, { delayInMinutes: minutes });
      } catch {
        /* alarms unavailable */
      }
    },
    now: () => Date.now(),
    log: (/** @type {string} */ msg) => console.warn("[wa1:calendar]", msg),
  };
}

/*
  Serialise publishes: an alarm and a "Publish now" arriving together must not
  both POST a fresh feed. A second call queues behind the first and re-reads
  state (settings, calendarFeed, merged items) once it runs.
*/
/** @type {Promise<any>} */
let publishChain = Promise.resolve();

/**
 * Publish the merged items to the configured feed server.
 * @param {{force?: boolean, deps?: Record<string, any>}} [opts]
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export function publishFeed(opts = {}) {
  const run = publishChain.then(() => publishNow(opts));
  publishChain = run.catch(() => {});
  return run;
}

/** @param {{force?: boolean, deps?: Record<string, any>}} opts */
async function publishNow(opts) {
  const d = { ...realDeps(), ...(opts.deps || {}) };
  const settings = await d.getSettings();
  const cal = (settings && settings.calendar) || {};
  if (cal.enabled !== true) return { ok: false, reason: "disabled" };
  const origin = validServiceUrl(cal.serviceUrl);
  if (!origin) return { ok: false, reason: "no-service-url" };

  /** @type {any} */
  let feed = (await d.getLocal(FEED_KEY)) || blankFeed(origin);
  // Server changed -> the old feed belongs to a different origin; start fresh.
  if (feed.serviceUrl && feed.serviceUrl !== origin) feed = blankFeed(origin);
  feed.serviceUrl = origin;

  const mv = await d.getMergedView();
  // Derived to-dos publish only when the user opted in (todos.includeInCalendar).
  const items =
    settings.todos && settings.todos.includeInCalendar === true
      ? { ...mv.items, ...(mv.todos || {}) }
      : mv.items;
  const { payload, count, collapsed } = buildFeedPayload(items, mv.userState, cal, new Date(d.now()), {
    acceptPending: !!(settings.review && settings.review.showPending),
    projects: mv.projects,
  });
  const hash = stableHash(payload);

  const unchanged = hash === feed.lastPayloadHash;
  const stale =
    !feed.lastPublishedAt || d.now() - Date.parse(feed.lastPublishedAt) > SEVEN_DAYS;
  // Same payload but last PUT is old: republish anyway to refresh expiry.
  if (unchanged && !opts.force && !stale) {
    return { ok: true, reason: "unchanged" };
  }
  // A hard-failed payload (413/400) doesn't retry until it changes — otherwise
  // every recompute would hammer the server with a payload it rejected.
  if (!opts.force && feed.failedHash && hash === feed.failedHash) {
    return { ok: false, reason: feed.error || "previously rejected" };
  }

  const save = (/** @type {any} */ patch) =>
    d.mutateKey(FEED_KEY, (/** @type {any} */ cur) => ({
      ...(cur || blankFeed(origin)),
      ...patch,
    }));

  /** Retrying failure: status error + backoff alarm (5, 15, 60 min). */
  const fail = async (/** @type {string} */ message) => {
    const failures = (feed.failures || 0) + 1;
    const delay = RETRY_MINUTES[Math.min(failures, RETRY_MINUTES.length) - 1];
    d.alarm(PUBLISH_ALARM, delay);
    await save({
      status: "error",
      error: message,
      failures,
      retryAt: new Date(d.now() + delay * MINUTE).toISOString(),
    });
    return { ok: false, reason: message };
  };

  /** Permanent failure until the payload changes — no retry alarm. */
  const hardFail = async (/** @type {string} */ message) => {
    await save({ status: "error", error: message, retryAt: null, failedHash: hash });
    return { ok: false, reason: message };
  };

  const post = () =>
    d.fetch(`${origin}/v1/calendars`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const put = () =>
    d.fetch(`${origin}/v1/calendars/${feed.feedId}.ics`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${feed.updateToken}`,
      },
      body: JSON.stringify(payload),
    });

  /** Record a successful response body ({accepted, skipped, feedId, ...}). */
  const succeed = (/** @type {any} */ body, /** @type {boolean} */ created, /** @type {boolean} */ resub) =>
    save({
      status: "ok",
      error: null,
      failures: 0,
      retryAt: null,
      failedHash: null,
      lastPublishedAt: new Date(d.now()).toISOString(),
      lastPayloadHash: hash,
      eventCount: count,
      collapsed: collapsed || 0,
      accepted: body && typeof body.accepted === "number" ? body.accepted : count,
      skipped: Array.isArray(body && body.skipped) ? body.skipped.slice(0, 20) : [],
      ...(resub ? { needsResubscribe: true } : {}),
      ...(created
        ? {
            feedId: body.feedId,
            updateToken: body.updateToken,
            feedUrl: body.feedUrl,
            groupFeeds: body.groupFeeds || null,
            expiresAt: body.expiresAt || null,
          }
        : { expiresAt: (body && body.expiresAt) || feed.expiresAt }),
    }).then(() => ({ ok: true }));

  try {
    // No feed yet (or the server changed) -> create one.
    if (!feed.feedId || !feed.updateToken) {
      const res = await post();
      if (!res || !res.ok) return handleError(res);
      return succeed(await res.json(), true, false);
    }

    const res = await put();
    if (res && res.ok) return succeed(await res.json(), false, false);
    if (res && (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410)) {
      // The stored feed is gone or the token is dead: create a fresh feed
      // and flag that the old subscription URL won't update anymore.
      const res2 = await post();
      if (!res2 || !res2.ok) return handleError(res2);
      return succeed(await res2.json(), true, true);
    }
    return handleError(res);
  } catch (e) {
    return fail(`Network error: ${String((e && /** @type {any} */ (e).message) || e).slice(0, 120)}`);
  }

  /** @param {any} res */
  async function handleError(res) {
    if (res && res.status === 413) return hardFail("Too many events for the feed");
    if (res && res.status === 400) return hardFail("The feed server rejected the payload");
    return fail(`Feed server error ${res ? res.status : "unreachable"}`);
  }
}

/**
 * Debounced publish kick: after a recompute or calendar settings change,
 * schedule the publish one minute out (when enabled). Re-creating the same
 * alarm name replaces it, so repeated calls collapse naturally.
 * @param {Record<string, any>} [deps]
 */
export async function scheduleFeedPublish(deps = {}) {
  const d = { ...realDeps(), ...deps };
  try {
    const settings = await d.getSettings();
    if (settings && settings.calendar && settings.calendar.enabled === true) {
      d.alarm(PUBLISH_ALARM, 1);
    }
  } catch {
    /* best effort */
  }
}

/**
 * Turn the feed off: DELETE it at the server (errors ignored), drop the
 * calendarFeed key and set calendar.enabled = false.
 * @param {{deps?: Record<string, any>}} [opts]
 */
export async function stopFeed(opts = {}) {
  const d = { ...realDeps(), ...(opts.deps || {}) };
  const feed = (await d.getLocal(FEED_KEY)) || null;
  const origin = feed && validServiceUrl(feed.serviceUrl);
  if (origin && feed.feedId && feed.updateToken) {
    try {
      await d.fetch(`${origin}/v1/calendars/${feed.feedId}.ics`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${feed.updateToken}` },
      });
    } catch {
      /* delete is best-effort */
    }
  }
  // Serialise the delete against the store queue — removeKey is a raw
  // chrome.storage.local.remove dep, so it needs the same enqueue every
  // other writer goes through (stopFeed never runs inside enqueue itself).
  await enqueue(() => d.removeKey(FEED_KEY));
  await d.setSettings((/** @type {any} */ s) => {
    if (!s.calendar) s.calendar = {};
    s.calendar.enabled = false;
    return s;
  });
  return { ok: true };
}
