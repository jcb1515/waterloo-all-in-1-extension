// @ts-check
// background/checknow.js with fully fake deps — a virtual clock drives
// deps.now()/deps.sleep() so retry windows and the 90 s deadline run in
// microseconds.
import test from "node:test";
import assert from "node:assert/strict";
import {
  startCheck,
  handleCheckDone,
  sweepCheckRuns,
  CHECK_TIMEOUT_MS,
} from "../../extension/src/background/checknow.js";

const T0 = 1_700_000_000_000;

/** A fake chrome.* + store + clock for one test. */
function fakeDeps(over = {}) {
  let t = T0;
  const data = {
    checkRuns: {},
    sourceState: {},
    "raw:learn": { items: [] },
    "raw:outlook": { items: [] },
  };
  const calls = { create: [], remove: [], send: [], reinject: [], stamp: [] };
  const deps = {
    now: () => t,
    sleep: async (/** @type {number} */ ms) => {
      t += ms;
    },
    advance: (/** @type {number} */ ms) => {
      t += ms;
    },
    tabs: {
      query: async () => [],
      get: async (/** @type {number} */ id) => ({ id, status: "complete" }),
      create: async (/** @type {any} */ opts) => {
        calls.create.push(opts);
        return { id: 900 + calls.create.length, status: "complete" };
      },
      remove: async (/** @type {number} */ id) => {
        calls.remove.push(id);
      },
      sendMessage: async (/** @type {number} */ tabId, /** @type {any} */ msg) => {
        calls.send.push({ tabId, msg });
        throw new Error("no receiver");
      },
    },
    runSync: async () => ({ ok: true }),
    reinjectTab: async (/** @type {number} */ tabId, /** @type {string} */ src) => {
      calls.reinject.push({ tabId, src });
      return 1;
    },
    stampScopes: async (/** @type {string} */ src, /** @type {string[]} */ scopes) => {
      calls.stamp.push({ src, scopes });
    },
    store: {
      getLocal: async (/** @type {string} */ k) => data[k],
      mutateKey: async (/** @type {string} */ k, /** @type {Function} */ fn) => {
        data[k] = fn(data[k]);
      },
    },
    data,
    calls,
    ...over,
  };
  return deps;
}

/** Wait until checkRuns[source] reaches a terminal state. */
async function settle(deps, source, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const r = (deps.data.checkRuns || {})[source];
    if (r && r.status !== "running") return r;
    await new Promise((r2) => setImmediate(r2));
  }
  return (deps.data.checkRuns || {})[source];
}

/** sendMessage that accepts, then finishes the run with wa1:check-done. */
function acceptingSend(calls, done = {}) {
  return async (/** @type {number} */ tabId, /** @type {any} */ msg) => {
    calls.send.push({ tabId, msg });
    queueMicrotask(() =>
      handleCheckDone({ source: msg.source, runId: msg.runId, ok: true, ...done }),
    );
    return { accepted: true };
  };
}

const portalTab = (id = 7, over = {}) => ({
  id,
  url: "https://portal.uwaterloo.ca/",
  discarded: false,
  status: "complete",
  lastAccessed: 5,
  ...over,
});

/* ---------------------------- sync route ---------------------------- */

test("sync source: runSync runs, run ends ok, scopeReadAt stamped", async () => {
  const deps = fakeDeps({
    runSync: async (/** @type {string} */ id, /** @type {string} */ why) => {
      assert.equal(id, "learn");
      assert.equal(why, "manual");
      return { ok: true };
    },
  });
  const res = startCheck("learn", deps);
  assert.equal(res.accepted, true);
  const run = await settle(deps, "learn");
  assert.equal(run.status, "ok");
  assert.equal(run.newItems, 0);
  assert.equal(deps.calls.stamp.length, 1);
  assert.equal(deps.calls.stamp[0].src, "learn");
  assert.ok(deps.calls.stamp[0].scopes.includes("sync"));
});

test("sync route vs tab route: learn never touches chrome.tabs", async () => {
  const deps = fakeDeps();
  startCheck("learn", deps);
  await settle(deps, "learn");
  assert.equal(deps.calls.send.length, 0);
  assert.equal(deps.calls.create.length, 0);
});

test("sync signed-out session -> failed signed-out, no scope stamp", async () => {
  const deps = fakeDeps({
    runSync: async () => {
      deps.data.sourceState.learn = {
        lastRunAt: new Date(deps.now()).toISOString(),
        session: "signed-out",
      };
      return { ok: true };
    },
  });
  startCheck("learn", deps);
  const run = await settle(deps, "learn");
  assert.equal(run.status, "failed");
  assert.equal(run.reason, "signed-out");
  assert.equal(deps.calls.stamp.length, 0);
});

test("sync no-tab session -> failed not-on-page", async () => {
  const deps = fakeDeps({
    runSync: async () => {
      deps.data.sourceState.learn = {
        lastRunAt: new Date(deps.now()).toISOString(),
        session: "no-tab",
      };
      return { ok: true };
    },
  });
  startCheck("learn", deps);
  const run = await settle(deps, "learn");
  assert.equal(run.status, "failed");
  assert.equal(run.reason, "not-on-page");
});

test("sync disabled -> failed disabled", async () => {
  const deps = fakeDeps({ runSync: async () => ({ ok: false, reason: "disabled" }) });
  startCheck("learn", deps);
  const run = await settle(deps, "learn");
  assert.equal(run.status, "failed");
  assert.equal(run.reason, "disabled");
});

test("already-running sync: waits for the concurrent run's stamp", async () => {
  const deps = fakeDeps({
    runSync: async () => ({ ok: false, reason: "already-running" }),
  });
  const origGet = deps.store.getLocal;
  deps.store.getLocal = async (/** @type {string} */ k) => {
    // the in-flight sync lands ~5 virtual seconds after our check started
    if (k === "sourceState" && deps.now() >= T0 + 5000 && !deps.data.sourceState.learn) {
      deps.data.sourceState.learn = {
        lastRunAt: new Date(deps.now()).toISOString(),
        session: "signed-in",
      };
    }
    return origGet(k);
  };
  startCheck("learn", deps);
  const run = await settle(deps, "learn");
  assert.equal(run.status, "ok");
  assert.equal(deps.calls.stamp.length, 1);
});

test("already-running sync landing signed-out -> failed signed-out", async () => {
  const deps = fakeDeps({
    runSync: async () => ({ ok: false, reason: "already-running" }),
  });
  const origGet = deps.store.getLocal;
  deps.store.getLocal = async (/** @type {string} */ k) => {
    if (k === "sourceState" && deps.now() >= T0 + 2000 && !deps.data.sourceState.learn) {
      deps.data.sourceState.learn = {
        lastRunAt: new Date(deps.now()).toISOString(),
        session: "signed-out",
      };
    }
    return origGet(k);
  };
  startCheck("learn", deps);
  const run = await settle(deps, "learn");
  assert.equal(run.status, "failed");
  assert.equal(run.reason, "signed-out");
  assert.equal(deps.calls.stamp.length, 0);
});

test("already-running sync that never stamps -> failed error at the deadline", async () => {
  const deps = fakeDeps({
    runSync: async () => ({ ok: false, reason: "already-running" }),
  });
  startCheck("learn", deps);
  const run = await settle(deps, "learn");
  assert.equal(run.status, "failed");
  assert.equal(run.reason, "error");
});

test("newItems counts only this source's new ids in the raw record", async () => {
  const deps = fakeDeps({
    runSync: async () => {
      deps.data["raw:learn"] = {
        items: [
          { id: "learn:a", source: "learn" },
          { id: "other:b", source: "outline" }, // wrong source — not counted
        ],
      };
      return { ok: true };
    },
  });
  startCheck("learn", deps);
  const run = await settle(deps, "learn");
  assert.equal(run.status, "ok");
  assert.equal(run.newItems, 1);
});

/* ---------------------------- tab route ---------------------------- */

test("existing tab is reused and never closed", async () => {
  const deps = fakeDeps();
  deps.tabs.query = async () => [portalTab(7)];
  deps.tabs.sendMessage = acceptingSend(deps.calls, { checked: 4 });
  startCheck("portal", deps);
  const run = await settle(deps, "portal");
  assert.equal(run.status, "ok");
  assert.equal(run.checked, 4);
  assert.equal(deps.calls.create.length, 0, "no new tab");
  assert.equal(deps.calls.remove.length, 0, "user tab stays open");
  assert.equal(deps.calls.send[0].msg.type, "wa1:check-now");
  assert.equal(deps.calls.send[0].tabId, 7);
});

test("no tab: opens inactive siteUrlFor tab, closes it afterwards", async () => {
  const deps = fakeDeps();
  deps.tabs.sendMessage = acceptingSend(deps.calls);
  startCheck("portal", deps);
  const run = await settle(deps, "portal");
  assert.equal(run.status, "ok");
  assert.equal(deps.calls.create.length, 1);
  assert.equal(deps.calls.create[0].active, false);
  assert.equal(deps.calls.create[0].url, "https://portal.uwaterloo.ca/");
  assert.deepEqual(deps.calls.remove, [901]);
});

test("discord with no tab: failed not-on-page, no tab ever created", async () => {
  const deps = fakeDeps();
  startCheck("discord", deps);
  const run = await settle(deps, "discord");
  assert.equal(run.status, "failed");
  assert.equal(run.reason, "not-on-page");
  assert.equal(deps.calls.create.length, 0);
});

test("accepted:false not-on-page -> fresh tab opened and retried once", async () => {
  const deps = fakeDeps();
  deps.tabs.query = async () => [portalTab(7)];
  let sent = 0;
  deps.tabs.sendMessage = async (/** @type {number} */ tabId, /** @type {any} */ msg) => {
    deps.calls.send.push({ tabId, msg });
    sent++;
    if (tabId === 7) return { accepted: false, reason: "not-on-page" };
    queueMicrotask(() =>
      handleCheckDone({ source: msg.source, runId: msg.runId, ok: true }),
    );
    return { accepted: true };
  };
  startCheck("portal", deps);
  const run = await settle(deps, "portal");
  assert.equal(run.status, "ok");
  assert.equal(deps.calls.create.length, 1, "fresh tab opened");
  assert.equal(deps.calls.remove.length, 1, "only the fresh tab closes");
  assert.deepEqual(deps.calls.remove, [901]);
  assert.ok(sent >= 2);
});

test("accepted:false with another reason fails with that reason", async () => {
  const deps = fakeDeps();
  deps.tabs.query = async () => [portalTab(7)];
  deps.tabs.sendMessage = async () => ({ accepted: false, reason: "signed-out" });
  startCheck("portal", deps);
  const run = await settle(deps, "portal");
  assert.equal(run.status, "failed");
  assert.equal(run.reason, "signed-out");
  assert.equal(deps.calls.create.length, 0);
});

test("unanswered pre-existing tab: re-inject once, then fresh tab fallback", async () => {
  const deps = fakeDeps();
  deps.tabs.query = async () => [portalTab(7)];
  // Only the freshly created tab (id 901) answers.
  deps.tabs.sendMessage = async (/** @type {number} */ tabId, /** @type {any} */ msg) => {
    deps.calls.send.push({ tabId, msg });
    if (tabId !== 901) throw new Error("no receiver");
    queueMicrotask(() =>
      handleCheckDone({ source: msg.source, runId: msg.runId, ok: true }),
    );
    return { accepted: true };
  };
  startCheck("portal", deps);
  const run = await settle(deps, "portal");
  assert.equal(run.status, "ok");
  assert.deepEqual(deps.calls.reinject, [{ tabId: 7, src: "portal" }]);
  assert.equal(deps.calls.create.length, 1);
  assert.deepEqual(deps.calls.remove, [901]);
  assert.ok(deps.calls.send.every((s) => s.tabId === 7 || s.tabId === 901));
  assert.ok(deps.calls.send.filter((s) => s.tabId === 7).length > 1, "retried tab 7");
});

test("check-done never arrives -> timeout", async () => {
  const deps = fakeDeps();
  deps.tabs.query = async () => [portalTab(7)];
  deps.tabs.sendMessage = async () => ({ accepted: true });
  startCheck("portal", deps);
  const run = await settle(deps, "portal");
  assert.equal(run.status, "failed");
  assert.equal(run.reason, "timeout");
});

test("check-done with the wrong runId is ignored", async () => {
  const deps = fakeDeps();
  deps.tabs.query = async () => [portalTab(7)];
  const res = startCheck("portal", deps);
  deps.tabs.sendMessage = async (/** @type {number} */ _t, /** @type {any} */ msg) => {
    deps.calls.send.push({ tabId: _t, msg });
    handleCheckDone({ source: msg.source, runId: "check:bogus:1", ok: true });
    queueMicrotask(() =>
      handleCheckDone({ source: msg.source, runId: msg.runId, ok: true }),
    );
    return { accepted: true };
  };
  const run = await settle(deps, "portal");
  assert.equal(run.status, "ok");
  assert.equal(run.runId, res.runId);
});

/* ---------------------------- protocol ---------------------------- */

test("unsupported source -> accepted:false unsupported", () => {
  const deps = fakeDeps();
  assert.deepEqual(startCheck("manual", deps), {
    accepted: false,
    reason: "unsupported",
  });
  assert.deepEqual(startCheck("bogus", deps), {
    accepted: false,
    reason: "unsupported",
  });
});

test("a second check while one is running is rejected", async () => {
  const deps = fakeDeps();
  deps.tabs.query = async () => [portalTab(7)];
  deps.tabs.sendMessage = async () => ({ accepted: true }); // never finishes
  const first = startCheck("portal", deps);
  assert.equal(first.accepted, true);
  const second = startCheck("portal", deps);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "already-running");
  await settle(deps, "portal"); // drains the run
});

test("sweepCheckRuns finalizes stale running entries only", async () => {
  const deps = fakeDeps();
  const stale = new Date(deps.now() - CHECK_TIMEOUT_MS - 1000).toISOString();
  const fresh = new Date(deps.now()).toISOString();
  deps.data.checkRuns = {
    portal: { runId: "a", status: "running", startedAt: stale },
    gmail: { runId: "b", status: "running", startedAt: fresh },
    learn: { runId: "c", status: "ok", startedAt: stale },
  };
  await sweepCheckRuns(deps.store, deps.now());
  assert.equal(deps.data.checkRuns.portal.status, "failed");
  assert.equal(deps.data.checkRuns.portal.reason, "timeout");
  assert.ok(deps.data.checkRuns.portal.endedAt);
  assert.equal(deps.data.checkRuns.gmail.status, "running", "fresh run untouched");
  assert.equal(deps.data.checkRuns.learn.status, "ok", "done run untouched");
});
