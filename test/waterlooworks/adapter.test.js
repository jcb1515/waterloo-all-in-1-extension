// @ts-check
// Adapter tests: fake ctx.parseHtml dispatches to the real parsers through
// linkedom, exactly like W1's offscreen registry does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import * as parsers from "../../extension/src/sources/waterlooworks/parsers.js";
import { messageKey } from "../../extension/src/sources/waterlooworks/map.js";
import { applyResult } from "../../extension/src/core/merge.js";
import adapter from "../../extension/src/sources/waterlooworks/index.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "waterlooworks"
);
const WW = "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full";
const NOW = new Date("2026-09-20T12:00:00.000Z");
const AT = NOW.toISOString();

const fixture = (name) => readFileSync(path.join(FIXTURES, name), "utf8");

/** Fake SyncContext whose parseHtml invokes the real parser exports. */
function makeCtx(state = {}, extras = {}) {
  return {
    state,
    now: NOW,
    settings: extras.settings || {},
    fetch: extras.fetch,
    async parseHtml(html, name, opts) {
      const exportName = name.split("/")[1];
      return parsers[exportName](parseHTML(html).document, opts);
    },
    textDates: extractDates,
    log() {},
  };
}

const payload = (name, url, kind = "dom") => ({
  source: "waterlooworks",
  kind,
  url,
  body: fixture(name),
  at: AT,
});
const rawPayload = (body, url, kind = "dom") => ({
  source: "waterlooworks",
  kind,
  url,
  body,
  at: AT,
});

test("urlPatterns cover the settled WW paths", () => {
  const compiled = adapter.observe.urlPatterns.map((p) => new RegExp(p));
  const hit = (url) => compiled.some((re) => re.test(url));
  assert.ok(hit(`${WW}/applications.htm`));
  assert.ok(hit(`${WW}/interviews.htm`));
  assert.ok(hit(`${WW}/jobs.htm`));
  assert.ok(hit("https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm"));
  assert.ok(hit("https://waterlooworks.uwaterloo.ca/myAccount/co-op/rankings.htm"));
  assert.ok(hit("https://waterlooworks.uwaterloo.ca/notLoggedIn.htm"));
});

test("first applications read stores applications and emits no updates", async () => {
  const ctx = makeCtx();
  const result = await adapter.observe.parse(
    payload("applications.html", `${WW}/applications.htm`, "net"),
    ctx
  );
  assert.equal(result.scope, "waterlooworks");
  assert.equal(result.complete, true);
  assert.deepEqual(result.readOk, ["waterlooworks"]);
  assert.deepEqual(result.state.lastReadOk, ["applications"]);
  assert.equal(result.state.applications.length, 3);
  assert.equal(result.state.applications[0].status, "applied");
  assert.equal(result.state.applications[1].status, "not-selected");
  assert.deepEqual(result.updates, []);
  assert.equal(result.state.lastUpdates, undefined);
  assert.equal(result.items.length, 0); // the grid produces no Items
});

test("second read with a status change emits a status update + history", async () => {
  const ctx = makeCtx();
  const first = await adapter.observe.parse(
    payload("applications.html", `${WW}/applications.htm`, "net"),
    ctx
  );
  const changed = fixture("applications.html").replace(
    ">Applied</span>",
    ">Selected for Interview</span>"
  );
  const second = await adapter.observe.parse(
    {
      source: "waterlooworks",
      kind: "net",
      url: `${WW}/applications.htm`,
      body: changed,
      at: "2026-09-22T12:00:00.000Z",
    },
    makeCtx(first.state)
  );
  const updates = second.updates;
  assert.equal(updates.length, 1);
  assert.equal(updates[0].kind, "status");
  assert.equal(updates[0].id, "waterlooworks:488135:selected-for-interview");
  assert.equal(
    updates[0].text,
    "Interview invite: Globex · Analog/Mixed-Signal Engineering Co-op"
  );
  assert.equal(updates[0].refId, "waterlooworks:488135");
  // Updates ride on SyncResult.updates — nothing persisted in state.
  assert.equal(second.state.lastUpdates, undefined);
  const app = second.state.applications[0];
  assert.equal(app.status, "selected-for-interview");
  assert.deepEqual(
    app.history.map((h) => h.status),
    ["applied", "selected-for-interview"]
  );
});

test("unknown status preserves the previous status", async () => {
  const ctx = makeCtx();
  const first = await adapter.observe.parse(
    payload("applications.html", `${WW}/applications.htm`, "net"),
    ctx
  );
  const garbled = fixture("applications.html").replace(
    ">Applied</span>",
    ">@@@</span>"
  );
  const second = await adapter.observe.parse(
    {
      source: "waterlooworks",
      kind: "net",
      url: `${WW}/applications.htm`,
      body: garbled,
      at: "2026-09-22T12:00:00.000Z",
    },
    makeCtx(first.state)
  );
  assert.equal(second.state.applications[0].status, "applied");
  assert.equal(second.updates.length, 0);
});

test("logged-out payload preserves items and marks the session", async () => {
  const ctx = makeCtx();
  const first = await adapter.observe.parse(
    payload("interviews.html", `${WW}/interviews.htm`, "net"),
    ctx
  );
  assert.equal(first.items.length, 3);
  const signedOut = await adapter.observe.parse(
    payload("not-logged-in.html", "https://waterlooworks.uwaterloo.ca/notLoggedIn.htm"),
    makeCtx(first.state)
  );
  assert.equal(signedOut.scope, "waterlooworks");
  assert.equal(signedOut.session, "signed-out");
  assert.equal(signedOut.items.length, 3); // cached items preserved
  assert.equal(signedOut.state.signedOutAt, AT);
  assert.equal(signedOut.complete, false);
});

test("missing grid on a complete DOM payload -> needs-update, cache kept", async () => {
  const ctx = makeCtx();
  const first = await adapter.observe.parse(
    payload("interviews.html", `${WW}/interviews.htm`, "net"),
    ctx
  );
  const missing = await adapter.observe.parse(
    payload("applications-missing.html", `${WW}/applications.htm`),
    makeCtx(first.state)
  );
  assert.equal(missing.error.code, "needs-update");
  assert.equal(missing.state.needsUpdate.applications, true);
  assert.equal(missing.complete, false);
  assert.equal(missing.items.length, 3); // interviews lastGood survives
});

test("incomplete DOM payload does not flag needs-update or drop the cache", async () => {
  const ctx = makeCtx();
  const first = await adapter.observe.parse(
    payload("interviews.html", `${WW}/interviews.htm`, "net"),
    ctx
  );
  // Same missing-grid page but the snapshot lacks data-wa1-complete="1".
  // (Strip it off the <html> tag itself — the string also occurs in the
  // fixture's comment.)
  const partial = fixture("applications-missing.html").replace(
    '<html data-wa1-complete="1">',
    "<html>"
  );
  const result = await adapter.observe.parse(
    {
      source: "waterlooworks",
      kind: "dom",
      url: `${WW}/applications.htm`,
      body: partial,
      at: AT,
    },
    makeCtx(first.state)
  );
  assert.equal(result.error, undefined);
  assert.equal(result.state.needsUpdate?.applications, undefined);
  assert.equal(result.items.length, 3);
  assert.equal(result.complete, false); // nothing read OK
});

test("JSON payloads never throw and return the cached union", async () => {
  const ctx = makeCtx();
  const first = await adapter.observe.parse(
    payload("interviews.html", `${WW}/interviews.htm`, "net"),
    ctx
  );
  const result = await adapter.observe.parse(
    {
      source: "waterlooworks",
      kind: "net",
      url: `${WW}/applications.htm`,
      body: '{"grid":{"rows":[]}}',
      at: AT,
    },
    makeCtx(first.state)
  );
  assert.equal(result.scope, "waterlooworks");
  assert.equal(result.complete, false);
  assert.equal(result.items.length, 3); // cached union, not wiped
  assert.equal(result.state.lastJsonAt, AT);
});

test("a dashboard fragment can fill several scopes at once", async () => {
  const ctx = makeCtx();
  const result = await adapter.observe.parse(
    payload("dashboard.html", "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm", "net"),
    ctx
  );
  assert.equal(result.scope, "waterlooworks");
  assert.deepEqual(result.readOk, ["waterlooworks"]);
  assert.deepEqual(result.state.lastReadOk.sort(), ["events", "messages"]);
  assert.equal(result.complete, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].type, "event");
  assert.deepEqual(result.state.messages, [
    {
      subject: "Cycle 1 applications due on WaterlooWorks",
      receivedAt: "2026-09-25T16:01:00.000Z",
      from: "Casey Advisor",
      priority: "High",
    },
  ]);
});

test("the live dashboard folds schedule + upcoming events + volatile counts", async () => {
  // The page-load HTML is a full document — "net" kind (a DOM fragment
  // without data-wa1-complete correctly bails before folding).
  const result = await adapter.observe.parse(
    payload(
      "dashboard-live.html",
      "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm",
      "net"
    ),
    makeCtx()
  );
  assert.equal(result.scope, "waterlooworks");
  assert.deepEqual(result.state.lastReadOk, ["dashboard"]);
  assert.deepEqual(
    result.items.map((it) => it.type).sort(),
    ["event", "event", "event", "event", "event", "event", "interview"]
  );
  const interview = result.items.find((it) => it.type === "interview");
  assert.equal(interview.id, "waterlooworks:interview:488135");
  assert.equal(interview.startAt, "2026-10-02T20:00:00.000Z");
  assert.equal(interview.endAt, "2026-10-02T20:30:00.000Z");
  const events = result.items.filter((it) =>
    it.id.startsWith("waterlooworks:event:")
  );
  assert.equal(events.length, 5);
  assert.ok(events.every((it) => it.startAt && it.endAt));
  // The rankings notice persists (same shape as the rankings page read);
  // the volatile module counters never do.
  assert.deepEqual(result.state.rankings, {
    term: "2027 - Winter",
    open: false,
    note: "Rankings are not open at this time. Visit the calendar to see when rankings will be open.",
    at: AT,
  });
  const stateJson = JSON.stringify(result.state);
  for (const key of ["newMessages", "webcamAppointments"]) {
    assert.ok(!stateJson.includes(key), `state persisted ${key}`);
  }
  // The flattened content.js snapshot (data-wa1-complete="1") folds the same.
  const snap = await adapter.observe.parse(
    payload(
      "dashboard-snapshot.html",
      "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm",
      "dom"
    ),
    makeCtx(result.state)
  );
  assert.deepEqual(
    snap.items.map((it) => it.id).sort(),
    result.items.map((it) => it.id).sort()
  );
});

test("lastGood merges across scopes and survives later reads", async () => {
  const ctx = makeCtx();
  const first = await adapter.observe.parse(
    payload("interviews.html", `${WW}/interviews.htm`, "net"),
    ctx
  );
  const second = await adapter.observe.parse(
    payload("events.html", "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm", "net"),
    makeCtx(first.state)
  );
  // 3 interviews + 3 events, all served from fresh + lastGood.
  assert.equal(second.items.length, 6);
  assert.equal(second.items.filter((i) => i.type === "interview").length, 3);
  assert.equal(second.items.filter((i) => i.type === "event").length, 3);
  assert.ok(second.state.lastGood.interviews);
  assert.ok(second.state.lastGood.events);
});

test("booked interview detail merges onto the list item by id", async () => {
  const ctx = makeCtx();
  const first = await adapter.observe.parse(
    payload("interviews.html", `${WW}/interviews.htm`, "net"),
    ctx
  );
  const second = await adapter.observe.parse(
    payload("interview-detail-booked.html", `${WW}/interviews.htm`, "net"),
    makeCtx(first.state)
  );
  const item = second.items.find((i) => i.id === "waterlooworks:interview:488135");
  assert.equal(item.location, "Virtual Room 106");
  assert.equal(item.endAt, "2026-10-02T20:30:00.000Z");
  assert.equal(item.meta.prep.interviewer, "Pat Example");
  assert.equal(item.meta.term, "2027 - Winter"); // list field kept
});

test("interview-detail reads accumulate per job", async () => {
  const ctx = makeCtx();
  const first = await adapter.observe.parse(
    payload("interview-detail-unbooked.html", `${WW}/interviews.htm`, "net"),
    ctx
  );
  assert.ok(first.items.find((i) => i.id === "waterlooworks:timeslot:400001"));
  // A detail for a different job leaves 400001's timeslot item alone.
  const second = await adapter.observe.parse(
    payload("interview-detail-booked.html", `${WW}/interviews.htm`, "net"),
    makeCtx(first.state)
  );
  assert.ok(second.items.find((i) => i.id === "waterlooworks:timeslot:400001"));
  assert.ok(second.items.find((i) => i.id === "waterlooworks:interview:488135"));
  // A booked detail for the SAME job drops that job's timeslot item.
  const third = await adapter.observe.parse(
    payload("interview-detail-booked-400001.html", `${WW}/interviews.htm`, "net"),
    makeCtx(second.state)
  );
  assert.ok(!third.items.find((i) => i.id === "waterlooworks:timeslot:400001"));
  assert.ok(third.items.find((i) => i.id === "waterlooworks:interview:400001"));
  assert.ok(third.items.find((i) => i.id === "waterlooworks:interview:488135"));
});

// Mirrors W1's scope-mode fold — extension/src/core/merge.js applyResult
// (mode:"scope"): stored items whose seenIn scope equals result.scope are
// dropped unless re-reported, then all result items are appended. Kept as a
// local copy so the test never imports across worktrees.
const foldScope = (prev, result) => {
  const newIds = new Set(result.items.map((i) => i.id));
  return [
    ...prev.filter(
      (p) => !newIds.has(p.id) && !(p.seenIn || []).some((s) => s.scope === result.scope)
    ),
    ...result.items,
  ];
};

test("the unified scope folds cleanly through W1's scope-mode merge", async () => {
  const ctx = makeCtx();
  let stored = [];
  const r1 = await adapter.observe.parse(
    payload("interview-detail-unbooked.html", `${WW}/interviews.htm`, "net"),
    ctx
  );
  stored = foldScope(stored, r1);
  assert.ok(stored.find((i) => i.id === "waterlooworks:timeslot:400001"));
  const r2 = await adapter.observe.parse(
    payload("interview-detail-booked-400001.html", `${WW}/interviews.htm`, "net"),
    makeCtx(r1.state)
  );
  stored = foldScope(stored, r2);
  assert.ok(!stored.find((i) => i.id === "waterlooworks:timeslot:400001"));
  assert.ok(stored.find((i) => i.id === "waterlooworks:interview:400001"));
});

test("posting reads accumulate per job and expire per job", async () => {
  const ctx = makeCtx(); // now = Sep 20, 2026
  const first = await adapter.observe.parse(
    payload("posting.html", `${WW}/jobs.htm`, "net"),
    ctx
  );
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].id, "waterlooworks:deadline:488135");
  // Viewing posting B adds its deadline without touching A's.
  const second = await adapter.observe.parse(
    payload("posting-divs.html", `${WW}/jobs.htm`, "net"),
    makeCtx(first.state)
  );
  assert.deepEqual(
    second.items.map((i) => i.id).sort(),
    ["waterlooworks:deadline:488135", "waterlooworks:deadline:488200"]
  );
  // Re-viewing A after its deadline passed removes only A's item.
  const third = await adapter.observe.parse(
    payload("posting-past.html", `${WW}/jobs.htm`, "net"),
    makeCtx(second.state)
  );
  assert.deepEqual(
    third.items.map((i) => i.id),
    ["waterlooworks:deadline:488200"]
  );
});

test("posting pages yield deadline items only while the deadline is future", async () => {
  const ctx = makeCtx(); // now = Sep 20, deadline Sep 30
  const result = await adapter.observe.parse(
    payload("posting.html", `${WW}/jobs.htm`, "net"),
    ctx
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "waterlooworks:deadline:488135");
  assert.equal(result.items[0].type, "application-deadline");
});

test("message detail persists privacy-safe metadata only", async () => {
  const ctx = makeCtx();
  const result = await adapter.observe.parse(
    payload("message-detail.html", `${WW}/messages.htm`, "net"),
    ctx
  );
  assert.equal(result.scope, "waterlooworks");
  assert.deepEqual(result.state.lastReadOk, ["message-detail"]);
  const details = result.state.messageDetails;
  assert.equal(details.length, 1);
  assert.equal(details[0].subject, "Cycle 1 applications due on WaterlooWorks");
  assert.equal(details[0].linkedJobId, "488135");
  const serialized = JSON.stringify(details);
  assert.ok(!serialized.includes("confidential"));
  assert.ok(!serialized.includes("A Student"));
});

test("rankings state persists without items", async () => {
  const ctx = makeCtx();
  const result = await adapter.observe.parse(
    payload("rankings-closed.html", "https://waterlooworks.uwaterloo.ca/myAccount/co-op/rankings.htm", "net"),
    ctx
  );
  assert.equal(result.scope, "waterlooworks");
  assert.deepEqual(result.state.rankings, {
    term: "2027 - Winter",
    open: false,
    note: "Rankings are not open at this time.",
    at: AT,
  });
  assert.equal(result.items.length, 0);
});

test("message detail body yields a pending item; the body is never persisted", async () => {
  const ctx = makeCtx();
  const result = await adapter.observe.parse(
    payload("message-detail-dates.html", `${WW}/messages.htm`, "net"),
    ctx
  );
  const derived = result.items.filter((i) => i.meta?.messageKey);
  // The past reference ("mentioned on September 10") is dropped — one item.
  assert.equal(derived.length, 1);
  const item = derived[0];
  assert.equal(item.type, "cycle-date"); // "Cycle 1 …" subject wins first
  assert.equal(item.review, "pending");
  assert.equal(item.status, "open");
  assert.equal(item.confidence, "tentative");
  // Friday, October 2 4:00 PM Toronto (EDT) -> 20:00Z
  assert.equal(item.dueAt, "2026-10-02T20:00:00.000Z");
  assert.ok(item.evidence.snippet.length <= 300);
  assert.match(item.evidence.snippet, /October 2/);
  assert.equal(item.evidence.method, "text");
  // Only the matched sentence is stored — the rest of the body is not.
  const stateJson = JSON.stringify(result.state);
  assert.ok(!stateJson.includes("WatIAM passphrase"));
  assert.ok(!stateJson.includes("spaces are limited"));
  // messageDetails holds metadata only — no bodyText.
  assert.equal(result.state.messageDetails[0].bodyText, undefined);
});

test("message-date item ids are identical on re-parse", async () => {
  const ctx = makeCtx();
  const first = await adapter.observe.parse(
    payload("message-detail-dates.html", `${WW}/messages.htm`, "net"),
    ctx
  );
  const second = await adapter.observe.parse(
    payload("message-detail-dates.html", `${WW}/messages.htm`, "net"),
    makeCtx(first.state)
  );
  const ids = (res) => res.items.filter((i) => i.meta?.messageKey).map((i) => i.id);
  assert.deepEqual(ids(second), ids(first));
});

test("list-row receivedAt and detail createdAt hash to one message key", () => {
  const subject = "Cycle 1 applications due on WaterlooWorks";
  // The inbox row and the detail page report the same instant; a bare
  // calendar day lands on it too.
  const detail = messageKey(subject, "2026-09-25T16:01:00.000Z", NOW);
  assert.equal(detail, messageKey(subject, "2026-09-25", NOW));
  // Late-UTC instants still land on the same Toronto day.
  assert.equal(detail, messageKey(subject, "2026-09-25T23:30:00.000Z", NOW));
});

test("a later inbox read keeps that message's detail-derived items", async () => {
  const ctx = makeCtx();
  const detail = await adapter.observe.parse(
    payload("message-detail-dates.html", `${WW}/messages.htm`, "net"),
    ctx
  );
  assert.equal(detail.items.filter((i) => i.meta?.messageKey).length, 1);
  // The inbox row for the same message (same subject/day -> same key) has no
  // date in its subject: a list read only replaces list-origin items, so the
  // body-derived item survives untouched.
  const list = await adapter.observe.parse(
    payload("messages.html", "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm", "net"),
    makeCtx(detail.state)
  );
  const kept = list.items.filter((i) => i.meta?.messageKey);
  assert.deepEqual(
    kept.map((i) => i.id),
    detail.items.filter((i) => i.meta?.messageKey).map((i) => i.id)
  );
  assert.equal(kept[0].meta.messageOrigin, "detail");
});

// Same message read as a dated inbox row vs. its detail page — a detail read
// replaces ALL items for the key (list items included), a list read never
// reintroduces an id a detail item already owns.
const datedSubject = "Interview moved to October 5";
const datedListHtml = fixture("messages.html").replace(
  "Cycle 1 applications due on WaterlooWorks",
  datedSubject
);
const datedDetailHtml = fixture("message-detail-dates.html").replace(
  "Cycle 1 applications due on WaterlooWorks",
  datedSubject
);
const inboxUrl = "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm";

test("detail read first, then the inbox row: detail items survive, no dup ids", async () => {
  const detail = await adapter.observe.parse(
    rawPayload(datedDetailHtml, `${WW}/messages.htm`, "net"),
    makeCtx()
  );
  const detailMsg = detail.items.filter((i) => i.meta?.messageKey);
  // Subject date (Oct 5) + body deadline (Oct 2): two detail-origin items.
  assert.equal(detailMsg.length, 2);
  assert.ok(detailMsg.every((i) => i.meta.messageOrigin === "detail"));

  const list = await adapter.observe.parse(
    rawPayload(datedListHtml, inboxUrl, "net"),
    makeCtx(detail.state)
  );
  const afterList = list.items.filter((i) => i.meta?.messageKey);
  // The row's subject-only item would collide with the detail's Oct 5 item —
  // detail wins; nothing is added or lost.
  assert.deepEqual(
    afterList.map((i) => i.id).sort(),
    detailMsg.map((i) => i.id).sort()
  );
  assert.equal(new Set(afterList.map((i) => i.id)).size, afterList.length);
});

test("inbox row first, then the detail page: list items are replaced", async () => {
  const list = await adapter.observe.parse(
    rawPayload(datedListHtml, inboxUrl, "net"),
    makeCtx()
  );
  const listMsg = list.items.filter((i) => i.meta?.messageKey);
  assert.equal(listMsg.length, 1); // subject date only
  assert.equal(listMsg[0].meta.messageOrigin, "list");

  const detail = await adapter.observe.parse(
    rawPayload(datedDetailHtml, `${WW}/messages.htm`, "net"),
    makeCtx(list.state)
  );
  const detailMsg = detail.items.filter((i) => i.meta?.messageKey);
  assert.equal(detailMsg.length, 2);
  assert.ok(detailMsg.every((i) => i.meta.messageOrigin === "detail"));
  // The body-derived item (Oct 2 4 PM) appears; the row's stale list item
  // is gone. Subject says "Interview" so both items type as interview.
  assert.ok(detailMsg.some((i) => i.startAt === "2026-10-02T20:00:00.000Z"));
});

test("sync returns the cached picture, no fetch without a fetch impl", async () => {
  const ctx = makeCtx();
  const first = await adapter.observe.parse(
    payload("interviews.html", `${WW}/interviews.htm`, "net"),
    ctx
  );
  const synced = await adapter.sync(makeCtx(first.state));
  assert.equal(synced.complete, false);
  assert.equal(synced.session, "no-tab");
  assert.equal(synced.items.length, 3);
  assert.deepEqual(synced.state, first.state); // contents unchanged
});

test("always records lastSeenAt", async () => {
  const ctx = makeCtx();
  const result = await adapter.observe.parse(
    payload("applications.html", `${WW}/applications.htm`, "net"),
    ctx
  );
  assert.equal(result.state.lastSeenAt, AT);
});

/* --- co-op important-dates daily sync ------------------------------------ */

const COOP_URL = "https://uwaterloo.ca/co-operative-education/important-dates";

/**
 * SyncContext with a counting ctx.fetch; fetchText is the response body,
 * or a non-2xx {status} / "throw" for failure paths.
 */
function syncCtx(state, { fetchText, fetchStatus = 200, settings = {} } = {}) {
  const calls = [];
  const ctx = makeCtx(state, {
    settings,
    fetch: async (url) => {
      calls.push(url);
      if (fetchStatus === "throw") throw new Error("network down");
      return {
        status: fetchStatus,
        url,
        text: fetchText === undefined ? fixture("coop-important-dates.html") : fetchText,
      };
    },
  });
  return { ctx, calls };
}

test("sync fetches the co-op page once per 24 h", async () => {
  const { ctx, calls } = syncCtx({});
  const first = await adapter.sync(ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], COOP_URL);
  assert.equal(first.complete, true); // authoritative read
  assert.equal(first.session, "no-tab");
  const coop = first.items.filter((i) => i.type === "cycle-date");
  assert.ok(coop.length > 0, "expected cycle-date items");
  assert.ok(coop.every((i) => i.org === "Co-op" && i.review === "auto"));
  assert.equal(first.state.lastGood["coop-dates"].items.length, coop.length);

  // Within 24 h the fetch is throttled and the result is not authoritative.
  const second = await adapter.sync(syncCtx(first.state).ctx);
  assert.equal(calls.length, 1, "still one fetch total");
  assert.equal(second.complete, false);
  assert.equal(second.items.length, first.items.length);
});

test("sync refetches after 24 h and honours coopDatesUrl override", async () => {
  const old = { coopDates: { fetchedAt: "2026-09-19T00:00:00.000Z" } };
  const { ctx, calls } = syncCtx(old, {
    settings: { coopDatesUrl: "https://example.test/dates" },
  });
  await adapter.sync(ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "https://example.test/dates");
});

test("settings.coopDates === false disables the fetch", async () => {
  const { ctx, calls } = syncCtx({}, { settings: { coopDates: false } });
  const res = await adapter.sync(ctx);
  assert.equal(calls.length, 0);
  assert.equal(res.complete, false);
});

test("a failed fetch keeps last-good co-op items and does not throw", async () => {
  const seeded = await adapter.sync(syncCtx({}).ctx);
  assert.ok(seeded.state.lastGood["coop-dates"].items.length > 0);
  const expired = {
    ...seeded.state,
    coopDates: { fetchedAt: "2000-01-01T00:00:00.000Z" },
  };
  const { ctx, calls } = syncCtx(expired, { fetchStatus: 503 });
  const res = await adapter.sync(ctx);
  assert.equal(calls.length, 1);
  assert.equal(res.complete, false);
  assert.equal(res.session, "no-tab");
  assert.deepEqual(
    res.items.filter((i) => i.type === "cycle-date").map((i) => i.id),
    seeded.items.filter((i) => i.type === "cycle-date").map((i) => i.id)
  );
});

test("a thrown fetch keeps last good; a 2xx page with no tables flags needsUpdate", async () => {
  const seeded = await adapter.sync(syncCtx({}).ctx);
  const expired = {
    ...seeded.state,
    coopDates: { fetchedAt: "2000-01-01T00:00:00.000Z" },
  };
  const thrown = await adapter.sync(syncCtx(expired, { fetchStatus: "throw" }).ctx);
  assert.equal(thrown.complete, false);
  assert.ok(thrown.items.some((i) => i.type === "cycle-date"));

  // 2xx but the parser finds no calendar tables -> needsUpdate, cache kept.
  const res = await adapter.sync(
    syncCtx(expired, { fetchText: "<html><body>we moved!</body></html>" }).ctx
  );
  assert.equal(res.complete, false);
  assert.equal(res.state.needsUpdate["coop-dates"], true);
  assert.ok(res.items.some((i) => i.type === "cycle-date"), "last good kept");
});

test("sync through real applyResult: success is authoritative, failure keeps cache", async () => {
  const closeId = "waterlooworks:cycle:winter-2027:cycle-1-posting-a:postings-close";
  const r1 = await adapter.sync(syncCtx({}).ctx);
  const raw = applyResult(null, r1, { mode: "sync" });
  assert.ok(raw.items.some((i) => i.id === closeId));

  // The postings-close cell disappears from the page; after 24 h the
  // refetch is complete -> the dropped date disappears from the store.
  const page2 = fixture("coop-important-dates.html").replace(
    "Job postings close 9 a.m. (ET) </p>",
    "Deadline moved</p>"
  );
  const later = {
    ...r1.state,
    coopDates: { fetchedAt: "2000-01-01T00:00:00.000Z" },
  };
  const r2 = await adapter.sync(syncCtx(later, { fetchText: page2 }).ctx);
  assert.equal(r2.complete, true);
  const raw2 = applyResult(raw, r2, { mode: "sync" });
  assert.ok(!raw2.items.some((i) => i.id === closeId), "removed date drops out");
  assert.ok(
    raw2.items.some(
      (i) => i.id === "waterlooworks:cycle:winter-2027:cycle-1:interviews"
    ),
    "other cycle items survive"
  );

  // A failed refetch keeps every cached item.
  const r3 = await adapter.sync(syncCtx(later, { fetchStatus: 0 }).ctx);
  assert.equal(r3.complete, false);
  const raw3 = applyResult(raw, r3, { mode: "sync" });
  assert.ok(raw3.items.some((i) => i.id === closeId), "failure keeps cache");
});
