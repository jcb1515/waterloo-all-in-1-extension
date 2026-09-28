// @ts-check
// waterlooworks content.js + refresh.js: the check-now protocol —
// {type:"wa1:check-now", source, runId} -> {accepted:…} reply plus a forced
// refresh round that skips the visibility gate and the 30 min throttle but
// not the kill switch, ending in a "wa1:check-done" message. Also the
// double-injection guard the background's re-injection relies on.
import test from "node:test";
import assert from "node:assert/strict";

const CONTENT = "../../extension/src/sources/waterlooworks/content.js";
const WW_URL =
  "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/applications.htm";
const TOKEN = "_-_-SECRET_ACTION_TOKEN_12345";

// --- fake elements -------------------------------------------------------

const td = (t) => ({ textContent: t });
const th = (t) => ({ textContent: t });
const tr = (cells) => ({
  cells: cells.map(td),
  textContent: cells.join(" "),
  querySelectorAll: () => [],
  querySelector: () => ({ textContent: cells[0] }),
});

/** A minimal document good enough for the ready predicates + isLoggedOut. */
function mkDoc({ title = "", text = "", selectors = {} } = {}) {
  return {
    title,
    body: { textContent: text },
    documentElement: { textContent: text },
    querySelectorAll: (sel) => selectors[sel] || [],
  };
}

/** An applications-grid doc: Job ID + App Status headers over id rows. */
const appsGridDoc = (ids, links = []) => {
  const rows = ids.map((id) => tr([id, "Applied"]));
  const table = {
    querySelectorAll: (sel) =>
      sel === "th"
        ? [th("Job ID"), th("App Status")]
        : sel === "tbody tr"
          ? rows
          : [],
  };
  return mkDoc({
    title: "Applications",
    text: "grid",
    selectors: {
      table: [table],
      "table tbody tr": rows,
      th: [th("Job ID"), th("App Status")],
      ".pagination__link": links,
    },
  });
};

/** A dashboard doc carrying `n` event rows via their onclick eventIds. */
const dashDoc = (eventIds) =>
  mkDoc({
    title: "WaterlooWorks Dashboard",
    selectors: {
      table: [{}],
      "[onclick]": eventIds.map((id) => ({
        getAttribute: (name) =>
          name === "onclick"
            ? `orbisApp.buildForm({'action':'${TOKEN}','eventId':'${id}'}, '/x', '').submit();`
            : null,
      })),
    },
  });

/** Wrap a promise so drain() can run until it settles (resolve OR reject). */
const settle = (p) => {
  let done = false;
  const q = p.then(
    (r) => {
      done = true;
      return r;
    },
    (e) => {
      done = true;
      throw e;
    }
  );
  return { q, done: () => done };
};

/**
 * The combined fake page: content.js's document/window/chrome plus the
 * hidden-iframe machinery the refresh round needs.
 */
function installWorld({
  url = WW_URL,
  visible = "hidden",
  readyState = "loading",
} = {}) {
  const frames = [];
  const sent = [];
  const timers = [];
  const listeners = [];
  const observers = [];
  const session = new Map();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realNow = Date.now;
  let fakeNow = realNow();
  /** @type {any} */
  let settingsVal;

  function mkFrame() {
    const frame = {
      attrs: {},
      style: {},
      listeners: {},
      removed: false,
      _src: null,
      routes: {},
      contentDocument: null,
      contentWindow: { location: { href: "about:blank" } },
      setAttribute(k, v) {
        frame.attrs[k] = v;
      },
      addEventListener(type, fn) {
        (frame.listeners[type] = frame.listeners[type] || []).push(fn);
      },
      fire(type) {
        for (const fn of frame.listeners[type] || []) fn();
        frame.listeners[type] = [];
      },
      remove() {
        frame.removed = true;
      },
      click() {},
    };
    Object.defineProperty(frame, "src", {
      get: () => frame._src,
      set: (nav) => {
        frame._src = nav;
        timers.push({
          due: fakeNow + 1,
          fn: () => {
            const r = frame.routes[nav];
            const d = r && typeof r === "object" && "doc" in r ? r.doc : r;
            const landed =
              r && typeof r === "object" && "url" in r ? r.url : nav;
            frame.contentDocument = d || null;
            frame.contentWindow.location.href = String(landed).startsWith(
              "http"
            )
              ? String(landed)
              : "https://waterlooworks.uwaterloo.ca" + landed;
            frame.fire("load");
          },
        });
      },
    });
    return frame;
  }

  // One observed element so buildSnapshot produces a top-page snapshot.
  const topTable = {
    outerHTML: "<table><tr><td>top page row</td></tr></table>",
    matches: () => false,
    parentElement: null,
    contains: () => false,
  };
  const doc = {
    visibilityState: visible,
    readyState,
    title: "Applications",
    body: { appendChild() {}, textContent: "" },
    documentElement: { textContent: "" },
    // OBSERVE_SEL is the only selector answered with the top element —
    // isLoggedOut's TEXTY query and every parser probe get [].
    querySelectorAll: (sel) =>
      String(sel).includes("doc-viewer__card-list") ? [topTable] : [],
    createElement: () => {
      const f = mkFrame();
      frames.push(f);
      return f;
    },
  };
  const win = {
    location: { href: url },
    sessionStorage: {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)),
    },
    addEventListener() {},
  };
  win.top = win;
  globalThis.window = win;
  globalThis.location = { href: url };
  globalThis.document = doc;
  globalThis.sessionStorage = win.sessionStorage;
  /** @type {any} */
  let storageErr = null;
  globalThis.chrome = {
    runtime: {
      id: "wa1-test",
      sendMessage: (m) => sent.push(m),
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    storage: {
      local: {
        get: async () => {
          if (storageErr) throw storageErr;
          return settingsVal === undefined
            ? {}
            : { wa1Settings: settingsVal };
        },
      },
    },
  };
  globalThis.MutationObserver = class {
    constructor(cb) {
      this.cb = cb;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  };
  globalThis.setTimeout = /** @type {any} */ ((fn, ms) => {
    const t = { fn, due: fakeNow + (ms || 0) };
    timers.push(t);
    return t;
  });
  globalThis.clearTimeout = /** @type {any} */ ((t) => {
    const i = timers.indexOf(t);
    if (i >= 0) timers.splice(i, 1);
  });
  Date.now = () => fakeNow;

  return {
    frames,
    sent,
    timers,
    listeners,
    observers,
    session,
    topTable,
    setSettings: (v) => {
      settingsVal = v;
    },
    failStorage: (e) => {
      storageErr = e;
    },
    advance: (ms) => {
      fakeNow += ms;
    },
    drain: async (until) => {
      let idle = 0;
      for (let guard = 0; guard < 2000; guard++) {
        if (until && until()) break;
        if (!timers.length) {
          if (++idle > 8) break;
          // A settled timer can leave a multi-hop promise chain (round
          // return -> stamps -> outcome -> check-done); flush generously.
          for (let i = 0; i < 12; i++) await Promise.resolve();
          continue;
        }
        timers.sort((a, b) => a.due - b.due);
        const t = timers.shift();
        fakeNow = Math.max(fakeNow, t.due);
        idle = 0;
        t.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    /** Flush pending microtasks without touching the timer queue. */
    flush: async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
    checkNow: (runId, source = "waterlooworks") => {
      const replies = [];
      listeners[0]?.(
        { type: "wa1:check-now", source, runId },
        {},
        (v) => replies.push(v)
      );
      return replies[0];
    },
    doneMsgs: () => sent.filter((m) => m.type === "wa1:check-done"),
    restore: () => {
      Date.now = realNow;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      delete globalThis.window;
      delete globalThis.location;
      delete globalThis.document;
      delete globalThis.sessionStorage;
      delete globalThis.chrome;
      delete globalThis.MutationObserver;
      delete /** @type {any} */ (globalThis).__wa1WwContent;
    },
  };
}

/** The standard routed pages: dashboard (2 events) -> interviews (none)
 *  -> applications landing -> grid pages 1-2 with shared + fresh jobIds. */
function routeStandardRound(frame) {
  const grid2 = appsGridDoc(["490003", "490001"]);
  const page2 = {
    tagName: "A",
    textContent: "2",
    classList: { contains: (c) => c === "pagination__link" },
    click: () => {
      frame.contentDocument = grid2;
      frame.fire("load");
    },
  };
  const grid1 = appsGridDoc(["490001", "490002"], [page2]);

  const totalRow = {
    cells: [td("Total Submitted:"), td("3")],
    querySelectorAll: (sel) => (sel === "a" ? [totalView] : []),
    querySelector: () => td("Total Submitted:"),
  };
  const totalView = {
    tagName: "A",
    textContent: "View",
    getAttribute: (name) =>
      name === "onclick"
        ? `orbisAppSr.buildForm({'action':'${TOKEN}','numOfDays':'0'}, '/x', '').submit();`
        : null,
    closest: () => totalRow,
    click: () => {
      frame.contentDocument = grid1;
      frame.fire("load");
    },
  };
  const appsLanding = mkDoc({
    title: "Applications",
    text: "Total Submitted: 3 Applied 3",
    selectors: { tr: [totalRow] },
  });

  frame.routes = {
    "/myAccount/dashboard.htm": dashDoc(["4705", "4706"]),
    "/myAccount/co-op/full/interviews.htm": mkDoc({
      title: "Interviews",
      text: "no counts",
    }),
    "/myAccount/co-op/full/applications.htm": appsLanding,
  };
}

test("check-now on a hidden, freshly-throttled page accepts and runs a forced round", async () => {
  const w = installWorld({ visible: "hidden" });
  try {
    // A fresh throttle marker — the scheduled refresh would stand down.
    globalThis.window.sessionStorage.setItem(
      "wa1:ww-refresh-at",
      String(Date.now())
    );
    const stampBefore = Number(
      globalThis.window.sessionStorage.getItem("wa1:ww-refresh-at")
    );
    await import(`${CONTENT}?t=cn${Date.now()}`);
    assert.equal(w.sent.length, 1, "init snapshot sent");
    assert.equal(w.listeners.length, 1, "check-now listener registered");

    const reply = w.checkNow("r-1");
    assert.deepEqual(reply, { accepted: true });

    // The forced resend of the (unchanged) top-page snapshot lands first.
    await w.flush();
    await w.drain(() => w.frames.length > 0);
    const frame = w.frames[0];
    assert.ok(frame, "a forced round created the hidden iframe");
    routeStandardRound(frame);
    await w.drain(() => w.doneMsgs().length > 0);

    const topSends = w.sent.filter(
      (m) =>
        m.type === "wa1:observed" &&
        String(m.payload?.body || "").includes("top page row")
    );
    assert.equal(
      topSends.length,
      2,
      "init + forced resend despite the unchanged hash"
    );
    const done = w.doneMsgs().find((m) => m.runId === "r-1");
    assert.ok(done, "check-done sent");
    assert.equal(done.source, "waterlooworks");
    assert.equal(done.ok, true);
    // 3 distinct grid jobIds (490001 repeats across pages) + 2 event rows.
    assert.equal(done.checked, 5);
    // The throttle marker was stamped when the forced round finished.
    assert.ok(
      Number(
        globalThis.window.sessionStorage.getItem("wa1:ww-refresh-at")
      ) >= stampBefore
    );
    for (const m of w.sent) {
      if (m.type === "wa1:observed") {
        assert.ok(!m.payload.body.includes(TOKEN), "token in payload");
      }
    }
  } finally {
    w.restore();
  }
});

test("check-now honours the autoRefresh kill switch", async () => {
  const w = installWorld();
  try {
    w.setSettings({
      sources: { waterlooworks: { autoRefresh: false } },
    });
    await import(`${CONTENT}?t=cn${Date.now()}`);
    const reply = w.checkNow("r-kill");
    assert.deepEqual(reply, { accepted: true });
    await w.drain(() => w.doneMsgs().length > 0);
    const done = w.doneMsgs()[0];
    assert.equal(done.runId, "r-kill");
    assert.deepEqual(done.ok, false);
    assert.equal(done.reason, "disabled");
    assert.equal(w.frames.length, 0, "disabled round made no iframe");
  } finally {
    w.restore();
  }
});

test("check-now honours the enabled kill switch", async () => {
  const w = installWorld();
  try {
    w.setSettings({ sources: { waterlooworks: { enabled: false } } });
    await import(`${CONTENT}?t=cn${Date.now()}`);
    assert.deepEqual(w.checkNow("r-off"), { accepted: true });
    await w.drain(() => w.doneMsgs().length > 0);
    assert.equal(w.doneMsgs()[0].reason, "disabled");
    assert.equal(w.frames.length, 0);
  } finally {
    w.restore();
  }
});

test("check-now fails closed when the settings read errors", async () => {
  const w = installWorld();
  try {
    w.failStorage(new Error("denied"));
    await import(`${CONTENT}?t=cn${Date.now()}`);
    assert.deepEqual(w.checkNow("r-err"), { accepted: true });
    await w.drain(() => w.doneMsgs().length > 0);
    assert.equal(w.doneMsgs()[0].reason, "error");
    assert.equal(w.doneMsgs()[0].ok, false);
    assert.equal(w.frames.length, 0);
  } finally {
    w.restore();
  }
});

test("check-now on a signed-out page reports signed-out", async () => {
  const w = installWorld({
    url: "https://waterlooworks.uwaterloo.ca/notLoggedIn.htm",
  });
  try {
    await import(`${CONTENT}?t=cn${Date.now()}`);
    const reply = w.checkNow("r-out");
    assert.deepEqual(reply, { accepted: true });
    await w.drain(() => w.doneMsgs().length > 0);
    const done = w.doneMsgs()[0];
    assert.equal(done.runId, "r-out");
    assert.equal(done.ok, false);
    assert.equal(done.reason, "signed-out");
    assert.equal(w.frames.length, 0, "no round on a signed-out page");
  } finally {
    w.restore();
  }
});

test("check-now on a non-/myAccount/ WW page reports not-on-page", async () => {
  const w = installWorld({
    url: "https://waterlooworks.uwaterloo.ca/about.htm",
  });
  try {
    await import(`${CONTENT}?t=cn${Date.now()}`);
    const reply = w.checkNow("r-page");
    assert.deepEqual(reply, { accepted: false, reason: "not-on-page" });
    await w.drain(() => w.doneMsgs().length > 0);
    assert.equal(w.doneMsgs().length, 0, "no check-done on a rejection");
    assert.equal(w.frames.length, 0);
  } finally {
    w.restore();
  }
});

test("concurrent check-now requests join one in-flight round", async () => {
  const w = installWorld({ visible: "hidden" });
  try {
    await import(`${CONTENT}?t=cn${Date.now()}`);
    const r1 = w.checkNow("r-1");
    const r2 = w.checkNow("r-2");
    assert.deepEqual(r1, { accepted: true });
    assert.deepEqual(r2, { accepted: true });

    await w.drain(() => w.frames.length > 0);
    const frame = w.frames[0];
    routeStandardRound(frame);
    await w.drain(() => w.doneMsgs().length >= 2);

    assert.equal(w.frames.length, 1, "one shared refresh round");
    const dones = w.doneMsgs();
    assert.equal(dones.length, 2);
    assert.deepEqual(
      dones.map((d) => d.runId).sort(),
      ["r-1", "r-2"]
    );
    for (const d of dones) {
      assert.equal(d.ok, true);
      assert.equal(d.checked, 5);
    }
  } finally {
    w.restore();
  }
});

test("a check-now joins a scheduled maybeRefresh round already running", async () => {
  const { maybeRefresh } = await import(
    "../../extension/src/sources/waterlooworks/refresh.js"
  );
  // Visible tab so maybeRefresh passes its own gates.
  const w = installWorld({ visible: "visible" });
  try {
    await import(`${CONTENT}?t=cn${Date.now()}`);
    const round = maybeRefresh();
    assert.ok(round, "scheduled round started");
    const reply = w.checkNow("r-join");
    assert.deepEqual(reply, { accepted: true });

    await w.drain(() => w.frames.length > 0);
    const frame = w.frames[0];
    routeStandardRound(frame);
    const d = settle(round);
    await w.drain(() => d.done() && w.doneMsgs().length >= 1);

    assert.equal(w.frames.length, 1, "check-now joined, no second iframe");
    const done = w.doneMsgs()[0];
    assert.equal(done.runId, "r-join");
    assert.equal(done.ok, true);
    assert.equal(done.checked, 5);
  } finally {
    w.restore();
  }
});

test("check-now reports a mid-round signed-out stop", async () => {
  const w = installWorld({ visible: "hidden" });
  try {
    await import(`${CONTENT}?t=cn${Date.now()}`);
    assert.deepEqual(w.checkNow("r-so"), { accepted: true });
    await w.drain(() => w.frames.length > 0);
    const frame = w.frames[0];
    frame.routes = {
      "/myAccount/dashboard.htm": {
        url: "/notLoggedIn.htm",
        doc: mkDoc({ title: "Sign in" }),
      },
    };
    await w.drain(() => w.doneMsgs().length > 0);
    const done = w.doneMsgs()[0];
    assert.equal(done.runId, "r-so");
    assert.equal(done.ok, false);
    assert.equal(done.reason, "signed-out");
    assert.equal(frame.removed, true, "iframe removed after abort");
  } finally {
    w.restore();
  }
});

test("check-now ignores messages for other sources", async () => {
  const w = installWorld();
  try {
    await import(`${CONTENT}?t=cn${Date.now()}`);
    const reply = w.checkNow("r-x", "discord");
    assert.equal(reply, undefined, "no reply for another source");
    await w.drain(() => w.doneMsgs().length > 0);
    assert.equal(w.doneMsgs().length, 0);
    assert.equal(w.frames.length, 0);
  } finally {
    w.restore();
  }
});

test("double injection registers one listener and one observer while alive", async () => {
  const w = installWorld();
  try {
    await import(`${CONTENT}?t=inj${Date.now()}`);
    assert.equal(w.listeners.length, 1);
    assert.equal(w.observers.length, 1);
    // A second injection while the first is alive returns immediately.
    await import(`${CONTENT}?t=inj${Date.now()}b`);
    assert.equal(w.listeners.length, 1, "no second listener");
    assert.equal(w.observers.length, 1, "no second observer");

    // Orphan the first instance: its context's runtime.id now throws,
    // while the re-injection arrives with a fresh, valid chrome binding.
    const oldChrome = /** @type {any} */ (globalThis.chrome);
    Object.defineProperty(oldChrome.runtime, "id", {
      configurable: true,
      get() {
        throw new Error("Extension context invalidated");
      },
    });
    globalThis.chrome = {
      runtime: {
        id: "wa1-test-2",
        sendMessage: (m) => w.sent.push(m),
        onMessage: { addListener: (fn) => w.listeners.push(fn) },
      },
      storage: oldChrome.storage,
    };
    await import(`${CONTENT}?t=inj${Date.now()}c`);
    assert.equal(w.listeners.length, 2, "orphaned context is replaced");
    assert.equal(w.observers.length, 2, "new observer installed");
    assert.equal(
      w.observers[0].disconnected,
      true,
      "the orphan's observer was disconnected"
    );
  } finally {
    w.restore();
  }
});

test("an orphaned instance stops sending instead of throwing", async () => {
  const w = installWorld();
  try {
    await import(`${CONTENT}?t=orphan${Date.now()}`);
    assert.equal(w.sent.length, 1, "init snapshot sent");
    const inst = /** @type {any} */ (globalThis).__wa1WwContent;
    assert.equal(inst.dead, false);
    // The extension context dies: sends throw, the id is gone.
    globalThis.chrome.runtime.id = undefined;
    globalThis.chrome.runtime.sendMessage = () => {
      throw new Error("Extension context invalidated");
    };
    // A DOM change makes the observer tick's send non-trivial (dedupe is
    // bypassed only by force), so the send hits the dead context and the
    // instance self-stops.
    w.topTable.outerHTML = "<table><tr><td>changed row</td></tr></table>";
    w.observers[0].cb();
    await w.drain(() => inst.dead);
    assert.equal(inst.dead, true, "the failed send stopped the orphan");
    assert.equal(
      w.observers[0].disconnected,
      true,
      "observer disconnected on self-stop"
    );
    assert.equal(inst.timers.size, 0, "pending timers cleared");
    // A check-now delivered to the dead context starts nothing.
    w.checkNow("r-dead");
    await w.drain(() => w.doneMsgs().length > 0);
    assert.equal(w.frames.length, 0, "orphan never starts a round");
  } finally {
    w.restore();
  }
});
