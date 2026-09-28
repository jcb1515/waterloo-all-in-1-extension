// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { sourceStatus, attentionSource } from "../../extension/src/panel/model/sources.js";

const NOW = new Date("2026-09-27T16:00:00.000Z");
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();

const adapter = (id, intervalMinutes) => ({
  id,
  label: id,
  origins: [],
  intervalMinutes,
  syncOnTabOpen: false,
});

const st = (over = {}) => ({
  lastRunAt: iso(NOW.getTime() - 20 * 60000),
  lastOkAt: iso(NOW.getTime() - 20 * 60000),
  session: "signed-in",
  complete: true,
  ...over,
});

test("passive adapters ignore complete:false — age of lastOkAt decides", () => {
  const discord = adapter("discord", 0);
  const s = sourceStatus(discord, st({ complete: false }), "live", NOW);
  assert.equal(s.key, "connected");

  // Never synced -> stale.
  assert.equal(
    sourceStatus(discord, st({ lastOkAt: null, complete: false }), "live", NOW).key,
    "stale",
  );
  // Older than 24 h -> stale.
  assert.equal(
    sourceStatus(discord, st({ lastOkAt: iso(NOW.getTime() - 25 * HOUR) }), "live", NOW).key,
    "stale",
  );
  // Inside 24 h -> connected.
  assert.equal(
    sourceStatus(discord, st({ lastOkAt: iso(NOW.getTime() - 23 * HOUR) }), "live", NOW).key,
    "connected",
  );
});

test("complete:false is not staleness — recent lastOkAt stays connected", () => {
  // A partial read (e.g. one Learn course missing a tool) must not flip a
  // just-synced adapter to "Stale".
  const outline = adapter("outline", 1440);
  const s = sourceStatus(outline, st({ complete: false }), "live", NOW);
  assert.equal(s.key, "connected");
  assert.equal(
    s.detail,
    "Last read was partial — some sections couldn't be read.",
  );
  assert.equal(sourceStatus(outline, st(), "live", NOW).key, "connected");
  assert.equal(sourceStatus(outline, st(), "live", NOW).detail, undefined);
});

test("complete:false with an old lastOkAt is still stale", () => {
  const learn = adapter("learn", 30);
  const s = sourceStatus(
    learn,
    st({ complete: false, lastOkAt: iso(NOW.getTime() - 13 * HOUR) }),
    "live",
    NOW,
  );
  assert.equal(s.key, "stale");
});

test("storeSyncSummary: a partial read is not 'Needs attention'", async () => {
  const { storeSyncSummary } = await import(
    "../../extension/src/panel/model/sources.js"
  );
  const learn = adapter("learn", 30);
  const r = storeSyncSummary(
    [learn],
    { learn: st({ complete: false }) },
    () => "live",
    NOW,
  );
  assert.equal(r.tone, "ok");
});

test("signed-out and error still win for passive adapters", () => {
  const discord = adapter("discord", 0);
  assert.equal(
    sourceStatus(discord, st({ session: "signed-out" }), "live", NOW).key,
    "signed-out",
  );
  assert.equal(
    sourceStatus(discord, st({ error: { code: "x", message: "boom" } }), "live", NOW).key,
    "error",
  );
});

test("soon stage is muted regardless of state", () => {
  const s = sourceStatus(adapter("email", 0), st(), "soon", NOW);
  assert.equal(s.key, "soon");
  assert.equal(s.detail, undefined);
});

const live = () => /** @type {"live"|"soon"} */ ("live");

test("attentionSource: signed-out session says 'signed out — open the site'", () => {
  const learn = adapter("learn", 30);
  const r = attentionSource(
    [learn],
    { learn: st({ session: "signed-out" }) },
    live,
  );
  assert.equal(r && r.adapter, learn);
  assert.equal(r && r.text, "signed out — open the site");
});

test("attentionSource: signed-out error code reads as signed out", () => {
  const outline = adapter("outline", 1440);
  const r = attentionSource(
    [outline],
    { outline: st({ error: { code: "signed-out", message: "SSO redirect" } }) },
    live,
  );
  assert.equal(r && r.text, "signed out — open the site");
});

test("attentionSource: error with a message shows the message", () => {
  const learn = adapter("learn", 30);
  const r = attentionSource(
    [learn],
    { learn: st({ error: { code: "http-500", message: "Brightspace 500" } }) },
    live,
  );
  assert.equal(r && r.text, "Brightspace 500");
});

test("attentionSource: error without a message falls back to 'sync error'", () => {
  const learn = adapter("learn", 30);
  const r = attentionSource(
    [learn],
    { learn: st({ error: { code: "http-500" } }) },
    live,
  );
  assert.equal(r && r.text, "sync error");
});

test("attentionSource: passive and non-live adapters never nag", () => {
  const discord = adapter("discord", 0); // passive
  const learn = adapter("learn", 30);
  assert.equal(
    attentionSource(
      [discord],
      { discord: st({ session: "signed-out" }) },
      live,
    ),
    null,
  );
  assert.equal(
    attentionSource(
      [learn],
      { learn: st({ session: "signed-out" }) },
      () => "soon",
    ),
    null,
  );
});

test("attentionSource: healthy sources give null; first troubled wins", () => {
  const learn = adapter("learn", 30);
  const outline = adapter("outline", 1440);
  assert.equal(attentionSource([learn, outline], {}, live), null);
  const r = attentionSource(
    [outline, learn],
    {
      outline: st({ error: { message: "first" } }),
      learn: st({ error: { message: "second" } }),
    },
    live,
  );
  assert.equal(r && r.adapter.id, "outline");
  assert.equal(r && r.text, "first");
});

/* --------------- sourceStatus(adapter, st, stage, now, state) --------------- */

const panelState = (over = {}) => ({
  settings: { sources: {} },
  items: {},
  probes: {},
  sourceState: {},
  userState: {},
  ...over,
});

test("state given: a zero-item read still shows Connected (gcal)", () => {
  const gcal = adapter("gcal", 30);
  const state = panelState({
    settings: { sources: { gcal: { enabled: true } } },
    // A successful sync that found nothing: scopeReadAt + lastOkAt both set,
    // scopeOkAt absent. The tile must say Connected, never stale.
    sourceState: {
      gcal: st({ scopeReadAt: { sync: iso(NOW.getTime() - 60000) }, itemCount: 0 }),
    },
  });
  const s = sourceStatus(gcal, state.sourceState.gcal, "live", NOW, state);
  assert.equal(s.key, "connected");
  assert.equal(s.label, "Connected");
  assert.equal(s.tone, "ok");
});

test("state given: stale refreshDays row -> 'Needs a visit' warn", () => {
  const portal = adapter("portal", 0);
  const state = panelState({
    sourceState: {
      portal: { scopeOkAt: { "portal:schedule": iso(NOW.getTime() - 20 * 24 * HOUR) } },
    },
  });
  const s = sourceStatus(portal, state.sourceState.portal, "live", NOW, state);
  assert.equal(s.key, "needs-visit");
  assert.equal(s.label, "Needs a visit");
  assert.equal(s.tone, "warn");
});

test("state given: snoozed stale still needs-visit; fresh lastOkAt wins", () => {
  const portal = adapter("portal", 0);
  const state = panelState({
    sourceState: {
      portal: { scopeOkAt: { "portal:schedule": iso(NOW.getTime() - 20 * 24 * HOUR) } },
    },
    userState: { nudgeSnooze: { "portal:portal-open": iso(NOW.getTime() + 3 * 24 * HOUR) } },
  });
  assert.equal(sourceStatus(portal, state.sourceState.portal, "live", NOW, state).key, "needs-visit");

  const fresh = panelState({
    sourceState: { portal: { lastOkAt: iso(NOW.getTime() - 60000) } },
  });
  assert.equal(sourceStatus(portal, fresh.sourceState.portal, "live", NOW, fresh).key, "connected");
});

test("state given: opened buckets and never", () => {
  const portal = adapter("portal", 0);

  const waiting = panelState({
    sourceState: { portal: st({ lastOkAt: null, lastRunAt: null }) },
    userState: { onboardingOpened: { "portal:portal-open": iso(NOW.getTime() - 10 * 60000) } },
  });
  const w = sourceStatus(portal, waiting.sourceState.portal, "live", NOW, waiting);
  assert.equal(w.key, "opened-waiting");
  assert.equal(w.label, "Opened · waiting for a read");
  assert.equal(w.tone, "muted");

  const nothing = panelState({
    sourceState: { portal: st({ lastOkAt: null, lastRunAt: null }) },
    userState: { onboardingOpened: { "portal:portal-open": iso(NOW.getTime() - 40 * 60000) } },
  });
  const n = sourceStatus(portal, nothing.sourceState.portal, "live", NOW, nothing);
  assert.equal(n.key, "opened-nothing");
  assert.equal(n.label, "Opened, nothing read yet");
  assert.equal(n.tone, "warn");

  const never = panelState({ sourceState: { portal: null } });
  const v = sourceStatus(portal, null, "live", NOW, never);
  assert.equal(v.key, "never");
  assert.equal(v.label, "Not read yet · open the site");
  assert.equal(v.tone, "warn");
});

test("state given: partial read keeps its detail under freshness", () => {
  const learn = adapter("learn", 30);
  const state = panelState({
    sourceState: { learn: st({ complete: false }) },
  });
  const s = sourceStatus(learn, state.sourceState.learn, "live", NOW, state);
  assert.equal(s.key, "connected");
  assert.equal(s.detail, "Last read was partial — some sections couldn't be read.");
});

test("state given: error and signed-out still win over freshness", () => {
  const portal = adapter("portal", 0);
  const state = panelState({
    sourceState: { portal: st({ session: "signed-out" }) },
  });
  assert.equal(sourceStatus(portal, state.sourceState.portal, "live", NOW, state).key, "signed-out");
  const errState = panelState({
    sourceState: { portal: st({ error: { code: "http-500", message: "boom" } }) },
  });
  assert.equal(sourceStatus(portal, errState.sourceState.portal, "live", NOW, errState).key, "error");
});
