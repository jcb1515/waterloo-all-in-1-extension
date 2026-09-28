// @ts-check
// discord/content.js: the check-now protocol — {type:"wa1:check-now",
// source:"discord", runId} -> {accepted:…} reply, then a forced passive
// re-read (bypassing the hash dedupe and seen-messages set — never any
// network, scroll, click or navigation) and a "wa1:check-done" message.
// Plus the double-injection guard for the background's re-injection.
import test from "node:test";
import assert from "node:assert/strict";
import { CustomEvent, parseHTML } from "linkedom";

const CONTENT = "../../extension/src/sources/discord/content.js";
const CH_URL = "https://discord.com/channels/111/222";
const DM_URL = "https://discord.com/channels/@me/333";

const CHANNEL_HTML = `
  <ol data-list-id="chat-messages">
    <li id="chat-messages-222-1001">
      <div id="message-content-1001">review due friday
        <time id="message-timestamp-1001" datetime="2026-09-28T14:00:00.000Z"></time>
      </div>
    </li>
    <li id="chat-messages-222-1002">
      <div id="message-content-1002">second note</div>
    </li>
  </ol>`;

const EVENTS_HTML = `
  <div role="dialog">
    <h2>1 Events</h2>
    <div>Study night<br/>Oct 1 at 7 PM</div>
  </div>`;

function installDiscord({
  url = CH_URL,
  html = CHANNEL_HTML,
  settings,
} = {}) {
  const sent = [];
  const listeners = [];
  const observers = [];
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realPerformance = globalThis.performance;
  const realCustomEvent = globalThis.CustomEvent;
  const parsed = parseHTML(`<html><body>${html}</body></html>`);
  const doc = parsed.document;
  try {
    Object.defineProperty(doc, "readyState", {
      value: "complete",
      configurable: true,
    });
  } catch {
    // linkedom already reports complete — either way is fine
  }
  globalThis.document = doc;
  globalThis.location = { href: url };
  // The injection guard's ping/pong/supersede handshake dispatches real
  // CustomEvents through the linkedom document.
  globalThis.CustomEvent = /** @type {any} */ (CustomEvent);
  // Below the 3 s settle mark: normal ticks read unsettled; a forced
  // check-now read counts as settled via readyState alone.
  globalThis.performance = /** @type {any} */ ({ now: () => 0 });
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
    const t = { fn, ms, dead: false };
    timers.push(t);
    return t;
  });
  globalThis.clearTimeout = /** @type {any} */ ((t) => {
    if (t) t.dead = true;
  });
  globalThis.chrome = {
    runtime: {
      id: "wa1-test",
      sendMessage: (m) => sent.push(m),
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
    storage: {
      local: {
        get: async () =>
          settings === undefined ? {} : { wa1Settings: settings },
      },
    },
  };
  return {
    sent,
    listeners,
    observers,
    /** Extract payloads by their inner "type". */
    extracts: (type) =>
      sent
        .filter((m) => m.type === "wa1:observed")
        .map((m) => JSON.parse(m.payload.body))
        .filter((b) => b.type === type),
    doneMsgs: () => sent.filter((m) => m.type === "wa1:check-done"),
    runTimers: () => {
      for (const t of timers.splice(0)) {
        if (!t.dead) t.fn();
      }
    },
    checkNow: (runId, source = "discord") => {
      const replies = [];
      listeners[0]?.(
        { type: "wa1:check-now", source, runId },
        {},
        (v) => replies.push(v)
      );
      return replies[0];
    },
    /** Flush microtasks (the settings read is the only async hop). */
    flush: async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      globalThis.performance = realPerformance;
      delete globalThis.document;
      delete globalThis.location;
      delete globalThis.MutationObserver;
      delete globalThis.chrome;
      if (realCustomEvent === undefined) delete globalThis.CustomEvent;
      else globalThis.CustomEvent = realCustomEvent;
      delete /** @type {any} */ (globalThis).__wa1DiscordContent;
    },
  };
}

test("channel page: accepted, forced re-send of seen messages, check-done ok", async () => {
  const w = installDiscord();
  try {
    await import(`${CONTENT}?t=dcn${Date.now()}`);
    assert.equal(w.listeners.length, 1, "check-now listener registered");
    assert.equal(w.extracts("messages").length, 1, "init messages sent");
    const firstInv = w.extracts("inventory")[0];
    assert.equal(firstInv.settled, false, "pre-3 s init read is unsettled");

    const reply = w.checkNow("r-1");
    assert.deepEqual(reply, { accepted: true });
    await w.flush();

    const done = w.doneMsgs().find((m) => m.runId === "r-1");
    assert.ok(done, "check-done sent");
    assert.equal(done.source, "discord");
    assert.equal(done.ok, true);
    assert.equal(done.checked, 2, "two visible messages, no event cards");

    // The forced read re-sent the inventory and every visible message,
    // despite both being deduped on a normal tick.
    const msgs = w.extracts("messages");
    assert.equal(msgs.length, 2, "forced read re-sent the messages");
    assert.deepEqual(
      msgs[1].messages.map((m) => m.messageId),
      ["1001", "1002"]
    );
    const forcedInv = w.extracts("inventory")[1];
    assert.equal(
      forcedInv.settled,
      true,
      "forced read is settled on readyState alone"
    );
  } finally {
    w.restore();
  }
});

test("@me with no Events modal is not-on-page", async () => {
  const w = installDiscord({ url: DM_URL, html: "<div></div>" });
  try {
    await import(`${CONTENT}?t=dcn${Date.now()}`);
    const reply = w.checkNow("r-dm");
    assert.deepEqual(reply, { accepted: false, reason: "not-on-page" });
    await w.flush();
    assert.equal(w.doneMsgs().length, 0, "no check-done on a rejection");
  } finally {
    w.restore();
  }
});

test("an open Events modal makes even a DM page acceptable", async () => {
  const w = installDiscord({ url: DM_URL, html: EVENTS_HTML });
  try {
    await import(`${CONTENT}?t=dcn${Date.now()}`);
    const reply = w.checkNow("r-ev");
    assert.deepEqual(reply, { accepted: true });
    await w.flush();
    const done = w.doneMsgs()[0];
    assert.equal(done.ok, true);
    assert.equal(done.checked, 1, "one event card, no channel messages");
    assert.equal(
      w.extracts("events").length,
      2,
      "init + forced re-send of the open modal"
    );
  } finally {
    w.restore();
  }
});

test("a non-/channels/ page with no modal is not-on-page", async () => {
  const w = installDiscord({
    url: "https://discord.com/app",
    html: "<div></div>",
  });
  try {
    await import(`${CONTENT}?t=dcn${Date.now()}`);
    assert.deepEqual(w.checkNow("r-app"), {
      accepted: false,
      reason: "not-on-page",
    });
    await w.flush();
    assert.equal(w.doneMsgs().length, 0);
  } finally {
    w.restore();
  }
});

test("discord.enabled === false accepts but reports disabled", async () => {
  const w = installDiscord({
    settings: { sources: { discord: { enabled: false } } },
  });
  try {
    await import(`${CONTENT}?t=dcn${Date.now()}`);
    const before = w.sent.length;
    const reply = w.checkNow("r-off");
    assert.deepEqual(reply, { accepted: true });
    await w.flush();
    const done = w.doneMsgs()[0];
    assert.equal(done.runId, "r-off");
    assert.equal(done.ok, false);
    assert.equal(done.reason, "disabled");
    assert.equal(
      w.sent.length,
      before + 1,
      "the disabled path sent only check-done — no forced DOM read"
    );
  } finally {
    w.restore();
  }
});

test("check-now ignores messages for other sources", async () => {
  const w = installDiscord();
  try {
    await import(`${CONTENT}?t=dcn${Date.now()}`);
    const before = w.sent.length;
    assert.equal(w.checkNow("r-x", "waterlooworks"), undefined);
    await w.flush();
    assert.equal(w.sent.length, before);
  } finally {
    w.restore();
  }
});

test("double injection registers one listener and one observer while alive", async () => {
  const w = installDiscord();
  try {
    await import(`${CONTENT}?t=dinj${Date.now()}`);
    assert.equal(w.listeners.length, 1);
    assert.equal(w.observers.length, 1);
    const firstListener = w.listeners[0];
    // A second injection while the first is alive gets a pong and bails.
    await import(`${CONTENT}?t=dinj${Date.now()}b`);
    assert.equal(w.listeners.length, 1, "no second listener");
    assert.equal(w.observers.length, 1, "no second observer");
    assert.equal(w.listeners[0], firstListener, "the owner kept its seat");

    // Orphan the first instance: its own context's runtime.id now throws,
    // so its ping listener stays silent while the re-injection arrives
    // with a fresh, valid chrome binding — the new copy supersedes it.
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
        onMessage: {
          addListener: (fn) => w.listeners.push(fn),
          removeListener: (fn) => {
            const i = w.listeners.indexOf(fn);
            if (i >= 0) w.listeners.splice(i, 1);
          },
        },
      },
      storage: oldChrome.storage,
    };
    await import(`${CONTENT}?t=dinj${Date.now()}c`);
    // The orphan removed its listener in teardown, then the new copy
    // registered — still exactly one, and it is not the old one.
    assert.equal(w.listeners.length, 1, "orphaned context is replaced");
    assert.notEqual(w.listeners[0], firstListener);
    assert.equal(w.observers.length, 2, "new observer installed");
    assert.equal(w.observers[0].disconnected, true, "orphan observer off");
  } finally {
    w.restore();
  }
});

test("an orphaned instance self-stops on a failed send", async () => {
  const w = installDiscord();
  try {
    await import(`${CONTENT}?t=dorp${Date.now()}`);
    assert.equal(w.listeners.length, 1);
    // The extension context dies: sends throw, the id is gone.
    globalThis.chrome.runtime.id = undefined;
    globalThis.chrome.runtime.sendMessage = () => {
      throw new Error("Extension context invalidated");
    };
    // A new message arrives — the observer tick now has a fresh message to
    // send, hits the dead context, and the instance self-stops.
    globalThis.document
      .querySelector("ol")
      .insertAdjacentHTML(
        "beforeend",
        '<li id="chat-messages-222-1003"><div id="message-content-1003">third note</div></li>'
      );
    w.observers[0].cb();
    w.runTimers();
    assert.equal(w.observers[0].disconnected, true, "observer off");
    assert.equal(
      w.listeners.length,
      0,
      "check-now listener removed on self-stop"
    );
    // No listener remains — a check-now to the dead context reads nothing.
    const before = w.sent.length;
    assert.equal(w.checkNow("r-dead"), undefined);
    await w.flush();
    assert.equal(
      w.sent.length,
      before,
      "orphan sent nothing for the check-now"
    );
  } finally {
    w.restore();
  }
});
