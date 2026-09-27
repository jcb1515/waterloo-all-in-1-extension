// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { publishFeed, stopFeed, FEED_KEY, PUBLISH_ALARM } from "../../extension/src/calendar/publish.js";

const NOW = Date.parse("2026-10-01T16:00:00.000Z");
const ORIGIN = "https://wa1-feed.test.workers.dev";

const SETTINGS = () => ({
  calendar: {
    enabled: true,
    serviceUrl: ORIGIN,
    split: false,
    include: { classes: true, tentative: true, completed: true, termDates: true },
    alarms: false,
  },
});

const ITEMS = {
  "learn:a": {
    id: "learn:a",
    source: "learn",
    type: "deadline",
    title: "Quiz #3",
    status: "open",
    confidence: "exact",
    review: "auto",
    dueAt: "2026-10-14T20:00:00Z",
    calendar: { uid: "learn-a@waterloo-all-in-1", seq: 0 },
  },
};

/** Response-ish object the fake fetch returns. */
const resp = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const CREATED = {
  feedId: "feed-9x",
  updateToken: "SECRET-TOKEN-123",
  feedUrl: `${ORIGIN}/v1/calendars/feed-9x.ics`,
  groupFeeds: { classes: `${ORIGIN}/v1/calendars/g-cl.ics` },
  expiresAt: "2027-10-01T00:00:00Z",
  accepted: 1,
  skipped: [],
};

/**
 * Fake chrome.storage + fetch. `fetches` is a queue of responses (or
 * {throw}) to hand back; anything past the queue returns 500.
 */
function makeDeps({ settings = SETTINGS(), items = ITEMS, fetches = [] } = {}) {
  const store = /** @type {Record<string, any>} */ ({});
  const calls = /** @type {{url: string, init: any}[]} */ ([]);
  const alarms = /** @type {{name: string, minutes: number}[]} */ ([]);
  const logs = /** @type {string[]} */ ([]);
  let nowMs = NOW;
  const deps = {
    fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
      calls.push({ url, init });
      const next = fetches.length ? fetches.shift() : resp(500);
      if (next && next.throw) throw next.throw;
      return next;
    },
    getSettings: async () => settings,
    setSettings: async (fn) => {
      const next = fn(structuredClone(settings)) || settings;
      Object.assign(settings, next);
      return settings;
    },
    getLocal: async (/** @type {string} */ k) => store[k],
    setLocal: async (/** @type {string} */ k, /** @type {any} */ v) => {
      store[k] = v;
    },
    mutateKey: async (/** @type {string} */ k, /** @type {(c: any) => any} */ fn) => {
      const next = await fn(store[k]);
      if (next !== undefined) store[k] = next;
      return next;
    },
    removeKey: async (/** @type {string} */ k) => {
      delete store[k];
    },
    getMergedView: async () => ({ items, userState: {} }),
    alarm: (/** @type {string} */ name, /** @type {number} */ minutes) => alarms.push({ name, minutes }),
    now: () => nowMs,
    log: (/** @type {string} */ m) => logs.push(m),
  };
  return { deps, store, calls, alarms, logs, settings, setNow: (ms) => (nowMs = ms) };
}

test("disabled or missing URL skips without fetching", async () => {
  const { deps, calls } = makeDeps({ settings: { calendar: { enabled: false } } });
  const r = await publishFeed({ deps });
  assert.equal(r.reason, "disabled");
  assert.equal(calls.length, 0);

  const d2 = makeDeps({ settings: { calendar: { enabled: true, serviceUrl: "http://nope" } } });
  const r2 = await publishFeed({ deps: d2.deps });
  assert.equal(r2.reason, "no-service-url");
  assert.equal(d2.calls.length, 0);
});

test("first publish POSTs, stores feed secrets, then PUTs", async () => {
  const fetches = [resp(201, CREATED), resp(200, { accepted: 1, skipped: [], expiresAt: "2027-11-01" })];
  const { deps, store, calls } = makeDeps({ fetches });

  const r1 = await publishFeed({ deps });
  assert.equal(r1.ok, true);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].url, `${ORIGIN}/v1/calendars`);
  const feed = store[FEED_KEY];
  assert.equal(feed.feedId, "feed-9x");
  assert.equal(feed.updateToken, "SECRET-TOKEN-123");
  assert.equal(feed.status, "ok");
  assert.equal(feed.eventCount, 1);
  assert.equal(feed.needsResubscribe, false);

  // Same payload, unchanged -> skipped entirely.
  const r2 = await publishFeed({ deps });
  assert.equal(r2.reason, "unchanged");
  assert.equal(calls.length, 1);

  // Forced -> PUT with the bearer token.
  const r3 = await publishFeed({ deps, force: true });
  assert.equal(r3.ok, true);
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[1].url, `${ORIGIN}/v1/calendars/feed-9x.ics`);
  assert.equal(calls[1].init.headers.authorization, "Bearer SECRET-TOKEN-123");
});

test("an unchanged payload older than 7 days still PUTs (expiry refresh)", async () => {
  const { deps, store, calls } = makeDeps({ fetches: [resp(201, CREATED), resp(200, { accepted: 1, skipped: [] })] });
  await publishFeed({ deps });
  // Age the last publish beyond 7 days and republish with no changes.
  store[FEED_KEY].lastPublishedAt = new Date(NOW - 8 * 86400000).toISOString();
  const r = await publishFeed({ deps });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, "PUT");
});

test("PUT 410 -> POST fresh feed + needsResubscribe", async () => {
  const { deps, store, calls } = makeDeps({
    fetches: [resp(410, {}), resp(201, { ...CREATED, feedId: "feed-new", feedUrl: `${ORIGIN}/v1/calendars/feed-new.ics` })],
  });
  store[FEED_KEY] = {
    serviceUrl: ORIGIN,
    feedId: "feed-9x",
    updateToken: "SECRET-TOKEN-123",
    lastPayloadHash: "old-hash",
    lastPublishedAt: new Date(NOW).toISOString(),
    status: "ok",
    failures: 0,
  };
  const r = await publishFeed({ deps });
  assert.equal(r.ok, true);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(store[FEED_KEY].feedId, "feed-new");
  assert.equal(store[FEED_KEY].needsResubscribe, true);
});

test("413 -> error status, no retry alarm", async () => {
  const { deps, store, alarms } = makeDeps({ fetches: [resp(413, {})] });
  const r = await publishFeed({ deps });
  assert.equal(r.ok, false);
  assert.equal(store[FEED_KEY].status, "error");
  assert.equal(store[FEED_KEY].error, "Too many events for the feed");
  assert.equal(alarms.length, 0);
});

test("network error -> error status, failures++, 5-minute retry alarm", async () => {
  const { deps, store, alarms } = makeDeps({ fetches: [{ throw: new Error("socket hang up") }] });
  const r = await publishFeed({ deps });
  assert.equal(r.ok, false);
  const feed = store[FEED_KEY];
  assert.equal(feed.status, "error");
  assert.equal(feed.failures, 1);
  assert.deepEqual(alarms, [{ name: PUBLISH_ALARM, minutes: 5 }]);
  // Second failure backs off to 15 minutes.
  store[FEED_KEY].failures = 1;
  await publishFeed({ deps });
  assert.deepEqual(alarms[1], { name: PUBLISH_ALARM, minutes: 15 });
});

test("stopFeed DELETEs with the token, clears state, disables sync", async () => {
  const { deps, store, calls, settings } = makeDeps({ fetches: [resp(204)] });
  store[FEED_KEY] = {
    serviceUrl: ORIGIN,
    feedId: "feed-9x",
    updateToken: "SECRET-TOKEN-123",
    status: "ok",
  };
  const r = await stopFeed({ deps });
  assert.equal(r.ok, true);
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].init.headers.authorization, "Bearer SECRET-TOKEN-123");
  assert.equal(store[FEED_KEY], undefined);
  assert.equal(settings.calendar.enabled, false);
});

test("two parallel publishes produce one POST", async () => {
  const { deps, calls } = makeDeps({ fetches: [resp(201, CREATED)] });
  const [r1, r2] = await Promise.all([publishFeed({ deps }), publishFeed({ deps })]);
  assert.equal(r1.ok, true);
  // The second call waited for the first, then saw the unchanged hash.
  assert.equal(r2.reason, "unchanged");
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 1);
});

test("a hard-failed payload is not retried until it changes", async () => {
  const { deps, store, calls } = makeDeps({ fetches: [resp(413, {})] });
  await publishFeed({ deps });
  assert.ok(store[FEED_KEY].failedHash, "the rejected payload's hash is recorded");

  // Next recompute kicks a publish with the same payload -> no fetch.
  const r = await publishFeed({ deps });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);

  // A payload change clears the path (here: a new item lands).
  const d2 = makeDeps({
    fetches: [resp(200, { accepted: 2, skipped: [] })],
    items: {
      ...ITEMS,
      "learn:b": { ...ITEMS["learn:a"], id: "learn:b", title: "Quiz #4" },
    },
  });
  d2.store[FEED_KEY] = { ...store[FEED_KEY], feedId: "feed-9x", updateToken: "t" };
  const r2 = await publishFeed({ deps: d2.deps });
  assert.equal(r2.ok, true);
  assert.equal(d2.calls.length, 1);
  assert.equal(d2.store[FEED_KEY].failedHash, null);
});

test("the update token never reaches logs", async () => {
  const { deps, logs } = makeDeps({
    fetches: [resp(201, CREATED), { throw: new Error("boom") }, { throw: new Error("boom") }],
  });
  await publishFeed({ deps });
  await publishFeed({ deps, force: true });
  await publishFeed({ deps, force: true });
  const all = logs.join("\n");
  assert.ok(!all.includes("SECRET-TOKEN-123"));
  assert.ok(!all.includes(CREATED.feedUrl));
});
