// @ts-check
// Adapter tests: fake ctx.parseHtml dispatches to the real parsers through
// linkedom, exactly like W1's offscreen registry does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import * as parsers from "../../extension/src/sources/waterlooworks/parsers.js";
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
function makeCtx(state = {}) {
  return {
    state,
    now: NOW,
    settings: {},
    async parseHtml(html, name, opts) {
      const exportName = name.split("/")[1];
      return parsers[exportName](parseHTML(html).document, opts);
    },
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
  assert.equal(result.scope, "applications");
  assert.equal(result.complete, true);
  assert.deepEqual(result.readOk, ["applications"]);
  assert.equal(result.state.applications.length, 3);
  assert.equal(result.state.applications[0].status, "applied");
  assert.equal(result.state.applications[1].status, "not-selected");
  assert.deepEqual(result.state.lastUpdates, []);
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
  const updates = second.state.lastUpdates;
  assert.equal(updates.length, 1);
  assert.equal(updates[0].kind, "status");
  assert.equal(
    updates[0].text,
    "Interview invite: Globex · Analog/Mixed-Signal Engineering Co-op"
  );
  assert.equal(updates[0].refId, "waterlooworks:488135");
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
  assert.equal(second.state.lastUpdates.length, 0);
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
  assert.equal(signedOut.scope, "session");
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

test("JSON payloads never throw and just record lastJsonAt", async () => {
  const ctx = makeCtx();
  const result = await adapter.observe.parse(
    {
      source: "waterlooworks",
      kind: "net",
      url: `${WW}/applications.htm`,
      body: '{"grid":{"rows":[]}}',
      at: AT,
    },
    ctx
  );
  assert.equal(result.scope, "json");
  assert.equal(result.complete, false);
  assert.equal(result.state.lastJsonAt, AT);
});

test("a dashboard fragment can fill several scopes at once", async () => {
  const ctx = makeCtx();
  const result = await adapter.observe.parse(
    payload("dashboard.html", "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm", "net"),
    ctx
  );
  assert.equal(result.scope, "events");
  assert.deepEqual(result.readOk.sort(), ["events", "messages"]);
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

test("a booked detail drops the previous timeslot item", async () => {
  const ctx = makeCtx();
  const first = await adapter.observe.parse(
    payload("interview-detail-unbooked.html", `${WW}/interviews.htm`, "net"),
    ctx
  );
  assert.ok(first.items.find((i) => i.id === "waterlooworks:timeslot:400001"));
  const second = await adapter.observe.parse(
    payload("interview-detail-booked.html", `${WW}/interviews.htm`, "net"),
    makeCtx(first.state)
  );
  assert.ok(!second.items.find((i) => i.id === "waterlooworks:timeslot:400001"));
  assert.ok(second.items.find((i) => i.id === "waterlooworks:interview:488135"));
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
  assert.equal(result.scope, "message-detail");
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
  assert.equal(result.scope, "rankings");
  assert.deepEqual(result.state.rankings, {
    term: "2027 - Winter",
    open: false,
    note: "Rankings are not open at this time.",
    at: AT,
  });
  assert.equal(result.items.length, 0);
});

test("sync returns the cached picture with complete:false", async () => {
  const ctx = makeCtx();
  const first = await adapter.observe.parse(
    payload("interviews.html", `${WW}/interviews.htm`, "net"),
    ctx
  );
  const synced = await adapter.sync(makeCtx(first.state));
  assert.equal(synced.complete, false);
  assert.equal(synced.session, "no-tab");
  assert.equal(synced.items.length, 3);
  assert.equal(synced.state, first.state); // state unchanged
});

test("always records lastSeenAt", async () => {
  const ctx = makeCtx();
  const result = await adapter.observe.parse(
    payload("applications.html", `${WW}/applications.htm`, "net"),
    ctx
  );
  assert.equal(result.state.lastSeenAt, AT);
});
