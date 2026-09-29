// @ts-check
// background/reinject.js — re-running manifest + registered content
// scripts in open tabs after install/update/startup, and per-tab
// re-injection for check-now.
import test from "node:test";
import assert from "node:assert/strict";
import { reinjectAll, reinjectTab } from "../../extension/src/background/reinject.js";

const MANIFEST = {
  content_scripts: [
    {
      matches: ["https://portal.uwaterloo.ca/*"],
      js: ["src/capture/recorder.js"],
      all_frames: false,
    },
    {
      matches: ["https://*.uwaterloo.ca/*"],
      js: ["src/capture/observer.js"],
      all_frames: true,
      world: "MAIN",
    },
  ],
};

function fakeDeps(over = {}) {
  const calls = { exec: [] };
  const deps = {
    manifest: MANIFEST,
    calls,
    tabsByQuery: /** @type {Record<string, any[]>} */ ({}),
    tabs: {
      query: async (/** @type {any} */ q) => deps.tabsByQuery[JSON.stringify(q.url)] || [],
      get: async (/** @type {number} */ id) => deps.tabsById[id] || null,
    },
    tabsById: /** @type {Record<number, any>} */ ({}),
    scripting: {
      executeScript: async (/** @type {any} */ spec) => {
        calls.exec.push(spec);
      },
      getRegisteredContentScripts: async () => [],
    },
    ...over,
  };
  return deps;
}

test("reinjectAll runs manifest + registered entries in matching tabs", async () => {
  const deps = fakeDeps();
  deps.scripting.getRegisteredContentScripts = async () => [
    {
      id: "opt",
      matches: ["https://mail.google.com/*"],
      js: ["src/sources/email/content.js"],
      allFrames: true,
    },
  ];
  deps.tabsByQuery[JSON.stringify(["https://portal.uwaterloo.ca/*"])] = [
    { id: 1, url: "https://portal.uwaterloo.ca/", status: "complete" },
  ];
  deps.tabsByQuery[JSON.stringify(["https://*.uwaterloo.ca/*"])] = [
    { id: 1, url: "https://portal.uwaterloo.ca/", status: "complete" },
    { id: 2, url: "https://learn.uwaterloo.ca/d2l/home", status: "loading" },
  ];
  deps.tabsByQuery[JSON.stringify(["https://mail.google.com/*"])] = [
    { id: 3, url: "https://mail.google.com/mail/u/0/", status: "complete" },
  ];
  const done = await reinjectAll(deps);
  assert.deepEqual(done.sort(), [1, 2, 3]);
  const iso = deps.calls.exec.find((s) => s.files[0] === "src/capture/recorder.js");
  assert.deepEqual(iso.target, { tabId: 1, allFrames: false });
  assert.equal(iso.world, "ISOLATED");
  const main = deps.calls.exec.find((s) => s.target.tabId === 2);
  assert.equal(main.world, "MAIN");
  assert.equal(main.target.allFrames, true);
  const reg = deps.calls.exec.find((s) => s.target.tabId === 3);
  assert.equal(reg.files[0], "src/sources/email/content.js");
  assert.equal(reg.target.allFrames, true);
});

test("discarded and unloaded tabs are skipped", async () => {
  const deps = fakeDeps();
  deps.tabsByQuery[JSON.stringify(["https://portal.uwaterloo.ca/*"])] = [
    { id: 1, status: "complete", discarded: true },
    { id: 2, status: "unloaded" },
    { id: 3, status: "complete" },
  ];
  const done = await reinjectAll(deps);
  assert.deepEqual(done, [3]);
  const forPortal = deps.calls.exec.filter((s) => s.files[0] === "src/capture/recorder.js");
  assert.equal(forPortal.length, 1);
  assert.equal(forPortal[0].target.tabId, 3);
});

test("a throwing tab doesn't stop the rest", async () => {
  const deps = fakeDeps();
  deps.tabsByQuery[JSON.stringify(["https://portal.uwaterloo.ca/*"])] = [
    { id: 1, status: "complete" },
    { id: 2, status: "complete" },
  ];
  deps.scripting.executeScript = async (spec) => {
    deps.calls.exec.push(spec);
    if (spec.target.tabId === 1) throw new Error("cannot access");
  };
  const done = await reinjectAll(deps);
  assert.deepEqual(done, [2]);
});

test("reinjectTab injects only entries whose match hosts belong to the source", async () => {
  const deps = fakeDeps();
  deps.tabsById[9] = { id: 9, url: "https://portal.uwaterloo.ca/", status: "complete" };
  const n = await reinjectTab(9, "portal", deps);
  // Both manifest entries match portal (exact + *.uwaterloo.ca wildcard).
  assert.equal(n, 2);
  assert.ok(deps.calls.exec.every((s) => s.target.tabId === 9));
});

test("reinjectTab skips discarded/missing tabs and wrong-source entries", async () => {
  const deps = fakeDeps();
  deps.tabsById[1] = { id: 1, url: "https://portal.uwaterloo.ca/", discarded: true };
  assert.equal(await reinjectTab(1, "portal", deps), 0);
  assert.equal(await reinjectTab(404, "portal", deps), 0);
  deps.tabsById[2] = { id: 2, url: "https://portal.uwaterloo.ca/", status: "complete" };
  // gmail source on a portal tab: no manifest entry's host maps to gmail.
  assert.equal(await reinjectTab(2, "gmail", deps), 0);
});

test("a hung executeScript does not wedge reinjectTab", async () => {
  const deps = fakeDeps();
  deps.injectTimeoutMs = 25;
  deps.tabsById[9] = { id: 9, url: "https://portal.uwaterloo.ca/", status: "complete" };
  deps.scripting.executeScript = () => new Promise(() => {});
  const start = Date.now();
  const n = await reinjectTab(9, "portal", deps);
  assert.equal(n, 0);
  assert.ok(Date.now() - start < 5000);
});

test("a hung executeScript does not stall reinjectAll's loop", async () => {
  const deps = fakeDeps({ manifest: {} });
  deps.injectTimeoutMs = 25;
  deps.scripting.getRegisteredContentScripts = async () => [
    { id: "x", matches: ["https://portal.uwaterloo.ca/*"], js: ["p.js"] },
    { id: "y", matches: ["https://mail.google.com/*"], js: ["g.js"] },
  ];
  deps.tabsByQuery[JSON.stringify(["https://portal.uwaterloo.ca/*"])] = [
    { id: 1, status: "complete" },
  ];
  deps.tabsByQuery[JSON.stringify(["https://mail.google.com/*"])] = [
    { id: 2, status: "complete" },
  ];
  deps.scripting.executeScript = (spec) =>
    spec.target.tabId === 1 ? new Promise(() => {}) : Promise.resolve();
  const done = await reinjectAll(deps);
  assert.deepEqual(done, [2]);
});

test("reinjectAll with no manifest entries still covers registered scripts", async () => {
  const deps = fakeDeps({ manifest: {} });
  deps.scripting.getRegisteredContentScripts = async () => [
    { id: "x", matches: ["https://discord.com/*"], js: ["d.js"] },
  ];
  deps.tabsByQuery[JSON.stringify(["https://discord.com/*"])] = [
    { id: 5, status: "complete" },
  ];
  const done = await reinjectAll(deps);
  assert.deepEqual(done, [5]);
});
