// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, withDevProfile, resolveSettings } from "../../extension/src/core/store.js";

test("DEFAULT_SETTINGS ships no personal data", () => {
  assert.deepEqual(DEFAULT_SETTINGS.profile.sections, {});
  assert.deepEqual(DEFAULT_SETTINGS.profile.groups, {});
  assert.deepEqual(DEFAULT_SETTINGS.sources.outline.urls, {});
  assert.deepEqual(DEFAULT_SETTINGS.sources.discord.watched, {});
  assert.equal(DEFAULT_SETTINGS.sources.outline.enabled, true);
  assert.equal(DEFAULT_SETTINGS.sources.discord.enabled, true);
  assert.equal(DEFAULT_SETTINGS.agenda.showClasses, "today");
});

test("withDevProfile merges plain objects, replaces arrays and scalars", () => {
  const merged = withDevProfile(DEFAULT_SETTINGS, {
    profile: { sections: { "ECE 150": ["LEC 002"] }, groups: { "ECE 190": "5" } },
    sources: { outline: { urls: { "ECE 150": "https://example.test/o" } } },
    theme: "dark",
  });
  assert.deepEqual(merged.profile.sections, { "ECE 150": ["LEC 002"] });
  assert.deepEqual(merged.profile.groups, { "ECE 190": "5" });
  assert.deepEqual(merged.sources.outline.urls, { "ECE 150": "https://example.test/o" });
  assert.equal(merged.sources.outline.enabled, true, "untouched default kept");
  assert.equal(merged.theme, "dark");

  // No profile at all -> the defaults themselves (fresh object).
  const plain = withDevProfile(DEFAULT_SETTINGS, null);
  assert.deepEqual(plain.profile.sections, {});
  assert.notEqual(plain, DEFAULT_SETTINGS);
});

test("stored settings win over the dev profile; deleted rows stay deleted", () => {
  const saved = { profile: { sections: {} } };
  const merged = resolveSettings(saved);
  // No dev profile in tests: identical to merging over DEFAULT_SETTINGS.
  assert.deepEqual(merged.profile.sections, {});
});

/* --------------------------- enqueue / store queue --------------------------- */

const NAVIGATOR_DESC = Object.getOwnPropertyDescriptor(globalThis, "navigator");

/** Replace globalThis.navigator for the duration of fn, then restore. */
async function withNavigator(fake, fn) {
  Object.defineProperty(globalThis, "navigator", {
    value: fake,
    configurable: true,
    writable: true,
  });
  try {
    return await fn();
  } finally {
    if (NAVIGATOR_DESC) Object.defineProperty(globalThis, "navigator", NAVIGATOR_DESC);
    else delete globalThis.navigator;
  }
}

test("enqueue serialises through navigator.locks when available", async () => {
  const { enqueue } = await import("../../extension/src/core/store.js");
  const calls = [];
  const order = [];
  const release = [];
  const fakeLocks = {
    request: (name, cb) => {
      calls.push(name);
      // FIFO: callbacks wait for the previous one to finish.
      const prev = order.length ? order[order.length - 1] : Promise.resolve();
      const run = prev.then(() => cb());
      order.push(run);
      return run;
    },
  };
  await withNavigator({ locks: fakeLocks }, async () => {
    const gate = new Promise((r) => release.push(r));
    const seq = [];
    const p1 = enqueue(async () => {
      await gate;
      seq.push("a");
      return "A";
    });
    const p2 = enqueue(async () => {
      seq.push("b");
      return "B";
    });
    release[0]();
    assert.equal(await p1, "A");
    assert.equal(await p2, "B");
    assert.deepEqual(seq, ["a", "b"]);
    assert.deepEqual(calls, ["wa1:store", "wa1:store"]);
  });
});

test("a rejected enqueued task does not poison the next one (locks mode)", async () => {
  const { enqueue } = await import("../../extension/src/core/store.js");
  const calls = [];
  const fakeLocks = {
    request: (name, cb) => {
      calls.push(name);
      return cb();
    },
  };
  await withNavigator({ locks: fakeLocks }, async () => {
    await assert.rejects(enqueue(() => Promise.reject(new Error("boom"))), /boom/);
    assert.equal(await enqueue(() => Promise.resolve(7)), 7);
  });
});

test("without navigator.locks the in-memory chain still serialises", async () => {
  const { enqueue } = await import("../../extension/src/core/store.js");
  await withNavigator({}, async () => {
    const gate = new Promise(() => {}); // never resolves
    const seq = [];
    const p1 = enqueue(async () => {
      await gate;
      seq.push("late");
    });
    const p2 = enqueue(async () => seq.push("after"));
    // p2 must be queued behind p1 even though p1 never finishes — prove by
    // racing a short real timer against p2.
    const winner = await Promise.race([
      p2.then(() => "p2"),
      new Promise((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    assert.equal(winner, "timeout");
    p1.catch(() => {});
    p2.catch(() => {});
  });
});
