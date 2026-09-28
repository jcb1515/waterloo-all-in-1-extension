// @ts-check
// tools/live/cdp.mjs — pure parts only. The live commands need a real Edge
// with remote debugging on, so nothing here opens a socket.

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CHECK_SOURCES } from "../../extension/src/sources/probes.js";
import { ADAPTERS } from "../../extension/src/core/registry.js";
import {
  pageTargets,
  pickPage,
  sourceForUrl,
  filterBySource,
  countByType,
  fmtWhen,
  fmtRow,
  serviceWorkerTargets,
  swExtId,
  pickServiceWorker,
  extPageTargets,
  buildAllowlist,
  resolveTarget,
  canTouch,
  extPageUrl,
  checkRunDone,
} from "../../tools/live/cdp.mjs";

const TOOLS_LIVE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tools",
  "live",
);

const TARGETS = [
  {
    id: "t1",
    type: "page",
    url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/jobs.htm?ck=Vid#?x=1",
    title: "Jobs",
  },
  {
    id: "t2",
    type: "page",
    url: "https://discord.com/channels/123/456",
    title: "Discord",
  },
  {
    id: "bg1",
    type: "service_worker",
    url: "chrome-extension://abc/background/index.js",
    title: "",
  },
  { id: "t3", type: "page", url: "not a url", title: "" },
  { id: "oth", type: "other", url: "https://learn.uwaterloo.ca/", title: "" },
];

test("pageTargets keeps pages only and drops query strings", () => {
  const pages = pageTargets(TARGETS);
  assert.deepEqual(
    pages.map((p) => p.id),
    ["t1", "t2", "t3"],
  );
  assert.equal(pages[0].host, "waterlooworks.uwaterloo.ca");
  assert.equal(pages[0].path, "/myAccount/co-op/full/jobs.htm");
  assert.equal(pages[1].host, "discord.com");
  assert.equal(pages[1].path, "/channels/123/456");
  assert.equal(pages[2].host, "");
  assert.equal(pageTargets(undefined).length, 0);
});

test("pickPage matches on URL substring, case-insensitive, first match wins", () => {
  assert.equal(pickPage(TARGETS, "WATERLOOWORKS").id, "t1");
  assert.equal(pickPage(TARGETS, "channels/123").id, "t2");
  assert.equal(pickPage(TARGETS, "no-such-tab"), null);
  // service workers are never page targets even if the url matched
  assert.equal(pickPage(TARGETS, "chrome-extension"), null);
});

test("sourceForUrl maps hosts through SITE_BY_HOST", () => {
  assert.equal(sourceForUrl("https://waterlooworks.uwaterloo.ca/x?y=1"), "waterlooworks");
  assert.equal(sourceForUrl("https://discord.com/channels/1/2"), "discord");
  assert.equal(sourceForUrl("https://mail.google.com/mail/u/0/#inbox"), "gmail");
  assert.equal(sourceForUrl("https://calendar.google.com/calendar/r"), "gcal");
  assert.equal(sourceForUrl("https://example.com/"), null);
  assert.equal(sourceForUrl("::bad::"), null);
});

test("filterBySource matches source and seenIn entries", () => {
  const items = {
    a: { id: "a", source: "learn", seenIn: [{ source: "learn" }] },
    b: { id: "b", source: "outline", seenIn: [{ source: "learn" }, { source: "outline" }] },
    c: { id: "c", source: "portal" },
    d: { id: "d" },
  };
  const learn = filterBySource(items, "learn").map((i) => i.id);
  assert.deepEqual(learn.sort(), ["a", "b"]);
  assert.deepEqual(
    filterBySource(items, "portal").map((i) => i.id),
    ["c"],
  );
  assert.equal(filterBySource(items, "gmail").length, 0);
});

test("countByType and fmtRow render the probe rows", () => {
  const items = [
    { type: "interview", title: "Acme SWE interview", startAt: "2026-10-08T23:00:00Z" },
    { type: "exam", title: "MATH 117 midterm ".repeat(6), dueAt: "2026-10-08T14:00:00Z" },
    { type: "exam" },
  ];
  assert.deepEqual(countByType(items), { interview: 1, exam: 2 });
  // 23:00Z on Oct 8 = 7:00 PM Toronto (EDT); 14:00Z = 10:00 AM.
  const row = fmtRow(items[0]);
  assert.match(row, /^interview \| /);
  assert.match(row, /Oct 8, 2026, 7:00\s?[pP]/);
  assert.match(row, /Acme SWE interview$/);
  // title truncated to 40 chars
  const long = fmtRow(items[1]);
  const titlePart = long.split("|").pop().trim();
  assert.equal(titlePart.length, 40);
  // no date -> "-"
  assert.match(fmtRow(items[2]), / \| - \| \?$/);
  assert.equal(fmtWhen({}), "-");
});

test("serviceWorkerTargets keeps chrome-extension workers only", () => {
  const sws = serviceWorkerTargets(TARGETS);
  assert.equal(sws.length, 1);
  assert.equal(sws[0].id, "bg1");
});

test("swExtId reads the extension id from the worker url", () => {
  assert.equal(
    swExtId({ url: "chrome-extension://maihpiennplbbcopdcklaobaoipbejjb/background/index.js" }),
    "maihpiennplbbcopdcklaobaoipbejjb",
  );
  assert.equal(swExtId({ url: "not a url" }), "");
  assert.equal(swExtId(null), "");
});

test("pickServiceWorker narrows by --ext/WA1_EXT_ID, errors on a miss", () => {
  const sws = [
    { id: "sw1", type: "service_worker", url: "chrome-extension://maihpiennplbbcopdcklaobaoipbejjb/background/index.js" },
    { id: "sw2", type: "service_worker", url: "chrome-extension://pcpgjaffdmfebdjjcaeikkjicemokbnd/background/index.js" },
    { id: "sw3", type: "service_worker", url: "chrome-extension://otherext/background/index.js" },
  ];
  // no selector: every candidate goes to name verification
  assert.deepEqual(pickServiceWorker(sws, null).candidates?.map((s) => s.id), ["sw1", "sw2", "sw3"]);
  // selector picks exactly the matching copy (main's vs W2's dist)
  const main = pickServiceWorker(sws, "maihpiennplbbcopdcklaobaoipbejjb");
  assert.equal(main.candidates?.length, 1);
  assert.equal(main.candidates?.[0].id, "sw1");
  const w2 = pickServiceWorker(sws, "pcpgjaffdmfebdjjcaeikkjicemokbnd");
  assert.equal(w2.candidates?.[0].id, "sw2");
  // unknown id: an error, never a guess
  assert.match(String(pickServiceWorker(sws, "nosuchid").error), /nosuchid/);
  assert.deepEqual(pickServiceWorker(undefined, "x").error !== undefined, true);
});

/* ------------------------- open/close/scroll rules ------------------------ */

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test("tools/live never references input events or page navigation", () => {
  const files = walk(TOOLS_LIVE);
  assert.ok(files.length >= 2, "expected cdp.mjs and README.md under tools/live");
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!text.includes("Input."), `${f} must not dispatch DevTools input events`);
    assert.ok(!text.includes("Page.navigate"), `${f} must not navigate pages`);
  }
  const cdp = readFileSync(path.join(TOOLS_LIVE, "cdp.mjs"), "utf8");
  assert.ok(cdp.includes("Target.createTarget"), "open must create its own target");
});

const ALLOW = buildAllowlist(CHECK_SOURCES, ADAPTERS);
const resolve = (arg) => resolveTarget(arg, ALLOW);

test("buildAllowlist: every checklist row url plus each adapter home", () => {
  assert.ok(
    ALLOW.some(
      (e) => e.source === "portal" && e.rowId === "portal-open" &&
        e.url === "https://portal.uwaterloo.ca/",
    ),
  );
  for (const a of ADAPTERS) {
    assert.ok(
      ALLOW.some((e) => e.source === a.id && e.rowId === "home" && e.url === `${a.origins[0]}/`),
      `${a.id} home`,
    );
  }
});

test("resolveTarget: source:rowId and source:home", () => {
  assert.deepEqual(resolve("portal:portal-open"), {
    ok: true,
    url: "https://portal.uwaterloo.ca/",
    source: "portal",
    rowId: "portal-open",
  });
  assert.equal(
    resolve("waterlooworks:applications").url,
    "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/applications.htm",
  );
  assert.equal(
    resolve("waterlooworks:interviews").url,
    "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/interviews.htm",
  );
  assert.equal(
    resolve("waterlooworks:dashboard").url,
    "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm",
  );
  assert.equal(resolve("learn:home").url, "https://learn.uwaterloo.ca/");
  assert.equal(resolve("portal:nope").ok, false);
});

test("resolveTarget: raw urls match the clean allowlisted url", () => {
  const exact = resolve("https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/applications.htm");
  assert.equal(exact.ok, true);
  assert.equal(exact.rowId, "applications");
  // query + hash ignored; the allowlisted (clean) url is what opens
  const messy = resolve(
    "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/applications.htm?x=1#y",
  );
  assert.equal(messy.ok, true);
  assert.equal(messy.url, "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/applications.htm");
});

test("resolveTarget: discord is refused before the allowlist", () => {
  for (const arg of [
    "discord:channel",
    "discord:events",
    "discord:home",
    "https://discord.com/channels/@me",
    "https://ptb.discord.com/x",
    "https://discord.gg/abc",
    "https://discordapp.com/channels/1",
  ]) {
    const r = resolve(arg);
    assert.equal(r.ok, false, arg);
    assert.match(String(r.reason), /never opened by the tool/);
  }
});

test("resolveTarget: https only, on-list paths only", () => {
  assert.equal(resolve("http://portal.uwaterloo.ca/").ok, false);
  const off = resolve("https://waterlooworks.uwaterloo.ca/myAccount/logout.htm");
  assert.equal(off.ok, false);
  assert.match(String(off.reason), /waterlooworks:applications/); // options listed
  assert.equal(resolve("https://example.com/").ok, false);
  assert.equal(resolve("portal").ok, false);
});

const MAIN_ID = "maihpiennplbbcopdcklaobaoipbejjb";

test("extPageUrl builds chrome-extension urls for relative paths only", () => {
  assert.equal(
    extPageUrl(MAIN_ID, "src/panel/panel.html?more=1"),
    `chrome-extension://${MAIN_ID}/src/panel/panel.html?more=1`,
  );
  assert.equal(
    extPageUrl(MAIN_ID, "src/options/options.html"),
    `chrome-extension://${MAIN_ID}/src/options/options.html`,
  );
  // a full absolute url, even on the same origin, is rejected
  assert.equal(extPageUrl(MAIN_ID, `chrome-extension://${MAIN_ID}/src/x`), null);
  assert.equal(extPageUrl(MAIN_ID, "https://example.com/"), null);
  assert.equal(extPageUrl(MAIN_ID, "javascript:alert(1)"), null);
  assert.equal(extPageUrl(MAIN_ID, "//example.com/x"), null);
  // escapes and encodings
  assert.equal(extPageUrl(MAIN_ID, "../manifest.json"), null);
  assert.equal(extPageUrl(MAIN_ID, "a/../../x"), null);
  assert.equal(extPageUrl(MAIN_ID, "%2e%2e/x"), null);
  assert.equal(extPageUrl(MAIN_ID, "src\\..\\x"), null);
  // bad inputs
  assert.equal(extPageUrl("not-an-id", "src/x"), null);
  assert.equal(extPageUrl(MAIN_ID, ""), null);
});

test("extPageTargets picks non-SW extension pages for worker wake-up", () => {
  const targets = [
    {
      type: "service_worker",
      url: `chrome-extension://${MAIN_ID}/src/background/index.js`,
    },
    {
      type: "page",
      url: `chrome-extension://${MAIN_ID}/src/panel/panel.html`,
    },
    {
      type: "other",
      url: `chrome-extension://${MAIN_ID}/src/capture/offscreen.html`,
    },
    // other extension, web page, and a missing url never match
    { type: "page", url: "chrome-extension://otherextid00000000000000/src/panel/panel.html" },
    { type: "page", url: "https://example.com/" },
    { type: "page" },
  ];
  const hits = extPageTargets(targets, MAIN_ID);
  assert.equal(hits.length, 2);
  assert.deepEqual(
    hits.map((t) => t.url),
    [
      `chrome-extension://${MAIN_ID}/src/panel/panel.html`,
      `chrome-extension://${MAIN_ID}/src/capture/offscreen.html`,
    ],
  );
  assert.equal(extPageTargets(targets, "otherextid00000000000000").length, 1);
  assert.equal(extPageTargets(targets, "nosuchid0000000000000000").length, 0);
  assert.equal(extPageTargets(undefined, MAIN_ID).length, 0);
});

test("canTouch trusts only ids recorded in .opened.json", () => {
  const opened = [{ targetId: "A1" }, { targetId: "B2" }];
  assert.equal(canTouch("A1", opened), true);
  assert.equal(canTouch("B2", opened), true);
  assert.equal(canTouch("C3", opened), false);
  assert.equal(canTouch("A1", []), false);
  assert.equal(canTouch("A1", undefined), false);
  assert.equal(canTouch("", opened), false);
});

test("checkRunDone returns only a terminal entry for the exact runId", () => {
  const runs = {
    learn: { runId: "r1", status: "running" },
    outline: { runId: "r2", status: "ok", checked: 4, newItems: 1 },
    gmail: { runId: "r3", status: "failed", reason: "timeout" },
  };
  assert.equal(checkRunDone(runs, "learn", "r1"), null, "still running");
  assert.equal(checkRunDone(runs, "learn", "other"), null, "stale runId");
  assert.deepEqual(checkRunDone(runs, "outline", "r2"), runs.outline);
  assert.equal(checkRunDone(runs, "gmail", "r3").reason, "timeout");
  assert.equal(checkRunDone(runs, "portal", "r2"), null);
  assert.equal(checkRunDone(null, "learn", "r1"), null);
});
