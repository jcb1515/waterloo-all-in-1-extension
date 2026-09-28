// @ts-check
// waterlooworks/refresh.js: snapshot hygiene, the click allowlist and the
// hidden-iframe round orchestration, all on fake DOMs/timers.
import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

// Import inside each test's fake-world via `import()` — the module's globals
// (window/document/chrome/setTimeout) are read lazily inside its functions,
// so a single static import is safe across tests.
const MOD = "../../extension/src/sources/waterlooworks/refresh.js";
const TOKEN = "_-_-SECRET_ACTION_TOKEN_12345";

const docOf = (html) => parseHTML(html).document;

// ---------------------------------------------------------------------------
// buildSnapshot hygiene

test("buildSnapshot strips on* attrs and javascript: hrefs — no token survives", () => {
  return import(MOD).then(({ buildSnapshot }) => {
    const doc = docOf(`<html><body>
      <table><tbody><tr>
        <td>Booked Interviews</td>
        <td><a href="javascript:void(0);"
               onclick="orbisAppSr.buildForm({'action':'${TOKEN}','numOfDays':'0','selectedFilter':'booked'}).submit();"
               onmouseover="track('${TOKEN}')">View</a></td>
      </tr></tbody></table>
      <h1 onclick="x('${TOKEN}')">Interviews</h1>
      <strong onfocus="y()">Upcoming</strong>
    </body></html>`);
    const body = buildSnapshot(doc, true);
    assert.ok(body);
    assert.match(body, /data-wa1-complete="1"/);
    assert.ok(!body.includes("buildForm"), "buildForm leaked");
    assert.ok(!body.includes(TOKEN), "action token leaked");
    assert.ok(!body.includes("'action'"), "action key leaked");
    assert.ok(!body.includes("javascript:"), "javascript: href leaked");
    assert.ok(!/\son[a-z]+\s*=/i.test(body), "an on* attribute survived");
    // …while the structure itself is kept.
    assert.ok(body.includes("Booked Interviews"));
    assert.ok(body.includes(">View<"));
  });
});

test("buildSnapshot marks incomplete snapshots and enforces nothing else", async () => {
  const { buildSnapshot } = await import(MOD);
  const doc = docOf("<html><body><h2>Jobs</h2></body></html>");
  assert.match(buildSnapshot(doc, false), /data-wa1-complete="0"/);
  assert.equal(buildSnapshot(null), null);
  assert.equal(buildSnapshot({}), null);
});

// ---------------------------------------------------------------------------
// allowedClick

const row = (label, count, onclick, linkText = "View") => {
  const d = docOf(`<table><tbody><tr>
    <td style="width: 60%;">${label}</td>
    <td><span>${count}</span></td>
    <td><a href="javascript:void(0);" role="button"
        onclick="${onclick}">${linkText}</a></td>
  </tr></tbody></table>`);
  return {
    row: d.querySelector("tr"),
    a: d.querySelector("a"),
  };
};

const booked = `orbisAppSr.buildForm({'action':'${TOKEN}','numOfDays':'0','selectedFilter':'booked'}, '/myAccount/co-op/full/interviews.htm', '').submit();`;
const unsched = `orbisAppSr.buildForm({'action':'${TOKEN}','numOfDays':'0','selectedFilter':'unscheduled'}, '/myAccount/co-op/full/interviews.htm', '').submit();`;
const declined = `orbisAppSr.buildForm({'action':'${TOKEN}','numOfDays':'0','selectedFilter':'declined'}, '/x', '').submit();`;
const noFilter = `orbisAppSr.buildForm({'action':'${TOKEN}','numOfDays':'0'}, '/x', '').submit();`;

test("allowedClick accepts the Booked/Unscheduled interview Views", async () => {
  const { allowedClick } = await import(MOD);
  assert.equal(allowedClick(row("Booked Interviews", 3, booked).a, "interviews"), true);
  assert.equal(allowedClick(row("Unscheduled Interviews", 1, unsched).a, "interviews"), true);
  // Live rows can carry a trailing colon.
  assert.equal(allowedClick(row("Booked Interviews:", 2, booked).a, "interviews"), true);
  // Spacing/quote variants around the filter (&quot; keeps the attr parseable).
  const variant = `orbisAppSr.buildForm({'action':'x', selectedFilter : &quot;unscheduled&quot; }, '/x', '').submit();`;
  assert.equal(allowedClick(row("Unscheduled Interviews", 2, variant).a, "interviews"), true);
});

test("allowedClick rejects other interview filters and action words", async () => {
  const { allowedClick } = await import(MOD);
  assert.equal(allowedClick(row("Declined", 1, declined).a, "interviews"), false);
  assert.equal(allowedClick(row("Message-only Interviews", 2, noFilter).a, "interviews"), false);
  for (const word of ["withdraw", "apply", "decline", "delete", "cancel", "rsvp"]) {
    const oc = `orbisAppSr.buildForm({'action':'${word}-${TOKEN}'}, '/x', '').submit();`;
    assert.equal(
      allowedClick(row("Booked Interviews", 1, oc).a, "interviews"),
      false,
      word
    );
  }
  // Filter/label mismatch — a booked View inside the Unscheduled row.
  assert.equal(allowedClick(row("Unscheduled Interviews", 1, booked).a, "interviews"), false);
  // "book" inside a non-allowed filter string stays out too.
  const bookElsewhere = `orbisAppSr.buildForm({'action':'book-${TOKEN}','numOfDays':'0'}, '/x', '').submit();`;
  assert.equal(allowedClick(row("Booked Interviews", 1, bookElsewhere).a, "interviews"), false);
});

test("allowedClick: the applications View only on the Total row, no status key", async () => {
  const { allowedClick } = await import(MOD);
  const totalOc = `orbisAppSr.buildForm({'action':'${TOKEN}','numOfDays':'0'}, '/myAccount/co-op/full/applications.htm', '').submit();`;
  const statusOc = `orbisAppSr.buildForm({'action':'${TOKEN}','status':'applied'}, '/x', '').submit();`;
  // The live row spells the label "Total Submitted:" — trailing colon.
  assert.equal(allowedClick(row("Total Submitted:", 100, totalOc).a, "applications"), true);
  // The bare spelling stays accepted too.
  assert.equal(allowedClick(row("Total Submitted", 100, totalOc).a, "applications"), true);
  assert.equal(allowedClick(row("Applied", 97, statusOc).a, "applications"), false);
  assert.equal(allowedClick(row("Total Submitted:", 100, statusOc).a, "applications"), false, "status key must fail");
  assert.equal(allowedClick(row("Total Submitted:", 100, totalOc, "Open").a, "applications"), false, "non-View text");
  assert.equal(allowedClick(row("Mock Interviews", 2, totalOc).a, "applications"), false);
});

test("allowedClick: numeric pagination links 2-10 only", async () => {
  const { allowedClick } = await import(MOD);
  const mk = (inner, cls = "pagination__link") =>
    docOf(`<ul><li><a href="javascript:void(0);" class="${cls}">${inner}</a></li></ul>`).querySelector("a");
  assert.equal(allowedClick(mk("2"), "pagination"), true);
  assert.equal(allowedClick(mk("10"), "pagination"), true);
  assert.equal(allowedClick(mk("1"), "pagination"), false);
  assert.equal(allowedClick(mk("11"), "pagination"), false);
  assert.equal(allowedClick(mk('<i class="material-icons">chevron_right</i>'), "pagination"), false);
  assert.equal(allowedClick(mk("3", "pagination__item"), "pagination"), false);
  const btn = docOf("<button type='submit'>2</button>").querySelector("button");
  assert.equal(allowedClick(btn, "pagination"), false);
});

// ---------------------------------------------------------------------------
// round orchestration — fake DOM/timers

const WW_URL =
  "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/applications.htm";

/** A minimal document good enough for the ready predicates + isLoggedOut. */
function mkDoc({ title = "", text = "", selectors = {} } = {}) {
  return {
    title,
    body: { textContent: text },
    documentElement: { textContent: text },
    querySelectorAll: (sel) => selectors[sel] || [],
  };
}

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

function installWorld({ url = WW_URL, visible = "visible" } = {}) {
  const frames = [];
  const sent = [];
  const timers = [];
  const session = new Map();
  const realSetTimeout = globalThis.setTimeout;
  const realNow = Date.now;
  let fakeNow = realNow();

  function mkFrame() {
    const frame = {
      attrs: {},
      style: {},
      listeners: {},
      removed: false,
      _src: null,
      /**
       * url -> doc, or url -> {url, doc} for a redirect. Setting `src`
       * queues a 1 ms navigation like a real iframe: the document swaps
       * and `load` fires on the timer queue, so a waitForLoad listener
       * registered first always catches it.
       * @type {Record<string, any>}
       */
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

  const doc = {
    visibilityState: visible,
    title: "WaterlooWorks",
    body: {
      appendChild() {},
      textContent: "",
    },
    documentElement: { textContent: "" },
    createElement: () => {
      const f = mkFrame();
      frames.push(f);
      return f;
    },
    querySelectorAll: () => [],
    readyState: "complete",
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
  globalThis.chrome = { runtime: { sendMessage: (m) => sent.push(m) } };
  globalThis.setTimeout = /** @type {any} */ ((fn, ms) => {
    const t = { fn, due: fakeNow + (ms || 0) };
    timers.push(t);
    return t;
  });
  Date.now = () => fakeNow;

  return {
    frames,
    sent,
    timers,
    advance: (ms) => {
      fakeNow += ms;
    },
    /**
     * Fire timers in earliest-due order, advancing fakeNow by each timer's
     * delay, with microtask ticks between — the same ordering a browser
     * event loop gives the round. Stops when `until` reports the work
     * settled, after a few idle ticks with no timers, or on the guard.
     * @param {(() => boolean)|undefined} until
     */
    drain: async (until) => {
      let idle = 0;
      for (let guard = 0; guard < 2000; guard++) {
        if (until && until()) break;
        if (!timers.length) {
          if (++idle > 8) break;
          await Promise.resolve();
          await Promise.resolve();
          continue;
        }
        timers.sort((a, b) => a.due - b.due);
        const t = /** @type {{fn: Function, due: number}} */ (timers.shift());
        fakeNow = Math.max(fakeNow, t.due);
        idle = 0;
        t.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    restore: () => {
      Date.now = realNow;
      globalThis.setTimeout = realSetTimeout;
      delete globalThis.window;
      delete globalThis.location;
      delete globalThis.document;
      delete globalThis.sessionStorage;
      delete globalThis.chrome;
    },
  };
}

test("maybeRefresh: hidden tab and throttle both stand down", async () => {
  const world = installWorld({ visible: "hidden" });
  try {
    const { maybeRefresh } = await import(MOD);
    const r = await maybeRefresh();
    assert.equal(r, undefined);
    assert.equal(world.frames.length, 0, "no iframe on a hidden tab");
  } finally {
    world.restore();
  }

  const world2 = installWorld();
  try {
    const { maybeRefresh } = await import(MOD);
    // A sessionStorage timestamp inside the 30 min window blocks a round.
    world2.frames; // touch
    globalThis.window.sessionStorage.setItem(
      "wa1:ww-refresh-at",
      String(Date.now())
    );
    const r = await maybeRefresh();
    assert.equal(r, undefined);
    assert.equal(world2.frames.length, 0, "throttled round made no iframe");
  } finally {
    world2.restore();
  }
});

test("the round aborts on a signed-out iframe and removes it", async () => {
  const world = installWorld();
  try {
    const { runRefreshRound } = await import(MOD);
    const d = settle(runRefreshRound());
    const frame = world.frames[0];
    assert.ok(frame);
    // The first navigation redirects onto the signed-out page.
    frame.routes = {
      "/myAccount/dashboard.htm": {
        url: "/notLoggedIn.htm",
        doc: mkDoc({ title: "Sign in" }),
      },
    };
    await world.drain(d.done);
    const { sent } = await d.q;
    assert.equal(sent, 0);
    assert.equal(world.sent.length, 0, "nothing was sent");
    assert.equal(frame.removed, true, "iframe removed");
    // Only one navigation happened — later steps were skipped.
    assert.equal(frame.src, "/myAccount/dashboard.htm");
    assert.ok(
      frame.contentWindow.location.href.endsWith("/notLoggedIn.htm")
    );
  } finally {
    world.restore();
  }
});

test("the iframe is removed when a step throws", async () => {
  const world = installWorld();
  try {
    const { runRefreshRound } = await import(MOD);
    const d = settle(runRefreshRound());
    const frame = world.frames[0];
    assert.ok(frame);
    // A dashboard that satisfies the predicate, then sendMessage throws.
    frame.routes = {
      "/myAccount/dashboard.htm": mkDoc({
        title: "WaterlooWorks Dashboard",
        selectors: { table: [{}] },
      }),
    };
    globalThis.chrome.runtime.sendMessage = () => {
      throw new Error("context invalidated");
    };
    await world.drain(d.done);
    await assert.rejects(d.q);
    assert.equal(frame.removed, true);
  } finally {
    world.restore();
  }
});

test("a full round walks dashboard, interviews and applications; every payload is token-free", async () => {
  const world = installWorld();
  try {
    const { runRefreshRound } = await import(MOD);

    // --- fake WW pages ---------------------------------------------------
    const dashDoc = mkDoc({
      title: "WaterlooWorks Dashboard",
      selectors: { table: [{}] },
    });

    const viewAnchorFor = (label, filter, viewDoc) => {
      const row = {
        cells: [
          { textContent: label },
          { textContent: "1" },
          { textContent: "" },
        ],
        querySelectorAll: (sel) => (sel === "a" ? [anchor] : []),
      };
      const anchor = {
        tagName: "A",
        textContent: "View",
        getAttribute: (name) =>
          name === "onclick"
            ? `orbisAppSr.buildForm({'action':'${TOKEN}','numOfDays':'0','selectedFilter':'${filter}'}, '/x', '').submit();`
            : null,
        closest: (sel) => (sel === "tr" ? trWrap : null),
        click: () => {
          frame.contentDocument = viewDoc;
          frame.fire("load");
        },
      };
      const trWrap = { cells: row.cells, querySelector: () => row.cells[0] };
      row.querySelectorAll = (sel) => (sel === "a" ? [anchor] : []);
      return { row, anchor };
    };

    const interviewViewDoc = mkDoc({
      title: "Interviews",
      selectors: { th: [{ textContent: "Interview Date / Time" }] },
    });
    const bookedRow = viewAnchorFor(
      "Booked Interviews",
      "booked",
      interviewViewDoc
    );
    const landingDoc = mkDoc({
      title: "Interviews",
      selectors: { tr: [bookedRow.row, { cells: [{ textContent: "Mock Interviews" }, { textContent: "2" }] , querySelectorAll: () => [] }] },
    });

    let frame;
    const appsGridDoc = (rowText) =>
      mkDoc({
        title: "Applications",
        selectors: {
          "table tbody tr": [{ textContent: rowText }],
          th: [{ textContent: "App Status" }],
        },
      });

    const page2Link = {
      tagName: "A",
      textContent: "2",
      classList: { contains: (c) => c === "pagination__link" },
      click: () => {},
    };
    const gridDoc1 = mkDoc({
      title: "Applications",
      selectors: {
        "table tbody tr": [{ textContent: "row page 1" }],
        th: [{ textContent: "App Status" }],
        ".pagination__link": [page2Link],
      },
    });
    page2Link.click = () => {
      frame.contentDocument = gridDoc2;
      frame.fire("load");
    };
    const gridDoc2 = mkDoc({
      title: "Applications",
      selectors: {
        "table tbody tr": [{ textContent: "row page 2" }],
        th: [{ textContent: "App Status" }],
        ".pagination__link": [],
      },
    });

    const appsLanding = mkDoc({
      title: "Applications",
      text: "Total Submitted: 100 Applied 97",
    });
    // Live spelling — the first cell ends with a colon.
    const totalRow = {
      cells: [{ textContent: "Total Submitted:" }, { textContent: "100" }],
      querySelectorAll: (sel) => (sel === "a" ? [totalView] : []),
      querySelector: () => ({ textContent: "Total Submitted:" }),
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
        frame.contentDocument = gridDoc1;
        frame.fire("load");
      },
    };
    appsLanding.querySelectorAll = (sel) => (sel === "tr" ? [totalRow] : []);

    const d = settle(runRefreshRound());
    frame = world.frames[0];
    assert.ok(frame, "refresh created one hidden iframe");
    assert.equal(frame.style.visibility, "hidden");
    assert.equal(frame.attrs["aria-hidden"], "true");

    // The iframe navigates itself through the routed fake pages:
    // dashboard → interviews landing (Booked View click swaps in the
    // interview doc, then it re-navigates to the landing) → applications
    // landing → Total View → pagination link 2.
    frame.routes = {
      "/myAccount/dashboard.htm": dashDoc,
      "/myAccount/co-op/full/interviews.htm": landingDoc,
      "/myAccount/co-op/full/applications.htm": appsLanding,
    };
    await world.drain(d.done);

    const { sent } = await d.q;
    assert.ok(frame.removed, "iframe removed after the round");
    assert.equal(world.sent.length, 4, "dashboard + interview view + 2 app pages");
    assert.equal(sent, 4);
    for (const msg of world.sent) {
      assert.equal(msg.type, "wa1:observed");
      assert.equal(msg.payload.source, "waterlooworks");
      assert.equal(msg.payload.kind, "dom");
      assert.match(msg.payload.body, /data-wa1-complete="1"/);
      assert.ok(!msg.payload.body.includes(TOKEN), "token in payload");
      assert.ok(!msg.payload.body.includes("buildForm"), "handler in payload");
    }
    const urls = world.sent.map((m) => m.payload.url);
    assert.equal(
      urls.filter((u) => u.includes("applications.htm")).length,
      2,
      "page 1 and page 2 of applications"
    );
  } finally {
    world.restore();
  }
});
