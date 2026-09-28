// @ts-check
// waterlooworks/content.js: a page that settles before the 3 s completeness
// mark and never mutates again must still emit a complete=1 snapshot — the
// load-event timed resend covers it (regression: static pages only ever sent
// complete=0, so observe.parse dropped them).
import test from "node:test";
import assert from "node:assert/strict";

const URL = "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/applications.htm";
const realSetTimeout = globalThis.setTimeout;

/**
 * Minimal isolated-world fakes: a document with one observed element, a
 * window with captured load listeners, a silent MutationObserver, a queue-
 * based setTimeout and a chrome.runtime that records sends.
 */
function installPage(readyState = "loading") {
  const el = {
    outerHTML: "<table><tr><td>row</td></tr></table>",
    matches: () => false,
    parentElement: null,
    contains: () => false,
  };
  const doc = {
    readyState,
    title: "Applications",
    documentElement: el,
    querySelectorAll: () => [el],
  };
  const loadHandlers = [];
  const sent = [];
  const timers = [];
  const realNow = Date.now;
  let fakeNow = realNow();
  globalThis.location = { href: URL };
  globalThis.document = doc;
  globalThis.window = {
    addEventListener: (type, fn) => {
      if (type === "load") loadHandlers.push(fn);
    },
  };
  globalThis.MutationObserver = class {
    constructor() {}
    observe() {}
    disconnect() {}
  };
  globalThis.chrome = { runtime: { sendMessage: (m) => sent.push(m) } };
  globalThis.setTimeout = /** @type {any} */ ((fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  });
  Date.now = () => fakeNow;
  return {
    sent,
    timers,
    advance: (ms) => {
      fakeNow += ms;
    },
    runTimers: () => {
      while (timers.length) timers.shift().fn();
    },
    fireLoad: () => {
      doc.readyState = "complete";
      for (const fn of loadHandlers) fn();
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

test("static page emits a complete=1 snapshot via the load-event resend", async () => {
  const page = installPage();
  try {
    await import(`../../extension/src/sources/waterlooworks/content.js?t=a${realNow()}`);
    // document_start send: readyState 'loading' -> complete=0.
    assert.equal(page.sent.length, 1);
    assert.match(page.sent[0].payload.body, /data-wa1-complete="0"/);
    // The page settles 500 ms later, then never mutates again.
    page.advance(500);
    page.fireLoad();
    // The load send is deduped (still complete=0, same hash); the timed
    // resend is queued for ~loadedAt + 3.1 s.
    assert.equal(page.sent.length, 1);
    assert.equal(page.timers.length, 1);
    page.advance(4000);
    page.runTimers();
    assert.equal(page.sent.length, 2);
    const complete = page.sent[1];
    assert.equal(complete.type, "wa1:observed");
    assert.match(complete.payload.body, /data-wa1-complete="1"/);
    assert.equal(complete.payload.source, "waterlooworks");
    assert.equal(complete.payload.url, URL);
  } finally {
    page.restore();
  }
});

test("already-complete page schedules the resend at import time", async () => {
  const page = installPage("complete");
  try {
    await import(`../../extension/src/sources/waterlooworks/content.js?t=b${realNow()}`);
    assert.equal(page.sent.length, 1); // still complete=0 — under the 3 s mark
    assert.equal(page.timers.length, 1);
    page.advance(4000);
    page.runTimers();
    assert.equal(page.sent.length, 2);
    assert.match(page.sent[1].payload.body, /data-wa1-complete="1"/);
  } finally {
    page.restore();
  }
});

function realNow() {
  return Date.now();
}
