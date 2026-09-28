// @ts-check
// capture/recorder.content.js: the reader probe runs at load, but SPA pages
// (WaterlooWorks) finish rendering afterwards. One settled re-probe shortly
// after the 3 s completeness mark must land a corrected probe; it fires
// exactly once, and throttled mutation probes still work.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "waterlooworks"
);
const URL = "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm";
const realSetTimeout = globalThis.setTimeout;

/**
 * Isolated-world fakes: a linkedom document (real DOM for the WW probe),
 * captured DOMContentLoaded/load handlers, a MutationObserver that records
 * its callback, a queued setTimeout, fake Date.now and a chrome that records
 * sent messages.
 * @param {string} readyState
 */
function installPage(readyState = "loading") {
  const dom = parseHTML("<html><body></body></html>");
  const doc = dom.window.document;
  let state = readyState;
  Object.defineProperty(doc, "readyState", { get: () => state, configurable: true });

  const dclHandlers = [];
  const loadHandlers = [];
  /** @type {(() => void)[]} */
  const mutationCbs = [];
  const sent = [];
  const timers = [];
  const realNow = Date.now;
  let fakeNow = realNow();

  doc.addEventListener = (type, fn) => {
    if (type === "DOMContentLoaded") dclHandlers.push(fn);
  };
  globalThis.location = {
    hostname: "waterlooworks.uwaterloo.ca",
    origin: "https://waterlooworks.uwaterloo.ca",
    pathname: "/myAccount/dashboard.htm",
    href: URL,
  };
  globalThis.document = doc;
  globalThis.window = {
    addEventListener: (type, fn) => {
      if (type === "load") loadHandlers.push(fn);
    },
  };
  globalThis.MutationObserver = class {
    constructor(cb) {
      mutationCbs.push(cb);
    }
    observe() {}
    disconnect() {}
  };
  globalThis.chrome = {
    runtime: {
      sendMessage: (m) => {
        sent.push(m);
        return Promise.resolve({});
      },
      onMessage: { addListener() {} },
    },
    storage: {
      local: { get: async () => ({}) },
      onChanged: { addListener() {} },
    },
  };
  globalThis.setTimeout = /** @type {any} */ ((fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  });
  Date.now = () => fakeNow;

  const probes = () => sent.filter((m) => m.type === "wa1:probe" || m.type === "wa1:reader-probe");
  return {
    doc,
    sent,
    timers,
    probes,
    advance: (ms) => {
      fakeNow += ms;
    },
    runTimers: () => {
      while (timers.length) timers.shift().fn();
    },
    fireDcl: () => {
      state = "interactive";
      for (const fn of dclHandlers) fn();
    },
    fireLoad: () => {
      state = "complete";
      for (const fn of loadHandlers) fn();
    },
    fireMutation: () => {
      for (const cb of mutationCbs) cb();
    },
    restore: () => {
      Date.now = realNow;
      globalThis.setTimeout = realSetTimeout;
      delete globalThis.location;
      delete globalThis.document;
      delete globalThis.window;
      delete globalThis.MutationObserver;
      delete globalThis.chrome;
    },
  };
}

const importRecorder = () =>
  import(`../../extension/src/capture/recorder.content.js?t=${Date.now()}${Math.random()}`);

const PROBE_MSG = "wa1:probe";

test("probe ok after settling lands via the one-shot re-probe, exactly once", async () => {
  const page = installPage("loading");
  try {
    await importRecorder();
    page.fireDcl();
    // Load-time probe: empty shell — WW not rendered yet.
    assert.equal(page.probes().length, 1);
    assert.equal(page.probes()[0].ok, false);
    // One more send may be the TAB_READY — probes stay at 1.
    page.advance(500);
    page.fireLoad();
    // Settled re-probe is queued ~3.1 s after injection, not sent yet.
    const queued = page.timers.length;
    assert.ok(queued >= 1, "settled re-probe timer scheduled");
    // WW finishes rendering between load and the settle mark.
    page.doc.documentElement.innerHTML = readFileSync(
      path.join(FIXTURES, "dashboard.html"),
      "utf8"
    );
    page.advance(4000);
    page.runTimers();
    const probeMsgs = page.sent.filter((m) => m.type === PROBE_MSG);
    assert.equal(probeMsgs.length, 2, "DCL probe + exactly one settled probe");
    assert.equal(probeMsgs[1].ok, true);
    assert.equal(probeMsgs[1].page, "dashboard");
    assert.ok((probeMsgs[1].counts.eventRows || 0) > 0);
    // Firing again must not produce a third settled probe.
    page.runTimers();
    assert.equal(page.sent.filter((m) => m.type === PROBE_MSG).length, 2);
    // A later mutation still probes: change the doc so the result differs
    // (identical results dedupe) and pass the 5 s min-interval.
    page.doc.documentElement.innerHTML = readFileSync(
      path.join(FIXTURES, "applications.html"),
      "utf8"
    );
    page.fireMutation();
    page.advance(6000);
    page.runTimers();
    const afterMutation = page.sent.filter((m) => m.type === PROBE_MSG);
    assert.equal(afterMutation.length, 3, "mutation probe still fires");
    assert.equal(afterMutation[2].page, "applications");
  } finally {
    page.restore();
  }
});

test("already-complete page schedules the settled re-probe at injection", async () => {
  const page = installPage("complete");
  try {
    await importRecorder();
    // Immediate probe on the empty shell.
    assert.equal(page.sent.filter((m) => m.type === PROBE_MSG).length, 1);
    assert.ok(page.timers.length >= 1, "settled re-probe scheduled");
    page.doc.documentElement.innerHTML = readFileSync(
      path.join(FIXTURES, "dashboard.html"),
      "utf8"
    );
    page.advance(4000);
    page.runTimers();
    const probeMsgs = page.sent.filter((m) => m.type === PROBE_MSG);
    assert.equal(probeMsgs.length, 2);
    assert.equal(probeMsgs[1].ok, true);
  } finally {
    page.restore();
  }
});
