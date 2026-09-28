// @ts-check
// tools/live/cdp.mjs — pure parts only. The live commands need a real Edge
// with remote debugging on, so nothing here opens a socket.

import assert from "node:assert/strict";
import test from "node:test";

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
} from "../../tools/live/cdp.mjs";

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
