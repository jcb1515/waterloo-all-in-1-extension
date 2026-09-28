// @ts-check
// "Check readers": checklist statuses (probe + readStats), recorder probe
// throttling, and report redaction.

import test from "node:test";
import assert from "node:assert/strict";
import {
  checklistRowStatus,
  checklistFor,
  recordProbe,
  appendReadStat,
  shouldSendProbe,
  checkReport,
  CHECK_SOURCES,
  PORTAL_OPEN_ROW,
  READ_STATS_CAP,
} from "../../extension/src/sources/probes.js";

const NOW = new Date("2026-09-27T16:00:00.000Z");
const minAgo = (n) => new Date(NOW.getTime() - n * 60000).toISOString();

test("checklistRowStatus: unchecked with no probe and no readStats", () => {
  const row = CHECK_SOURCES.discord.checklist[0]; // channel
  const s = checklistRowStatus(row, {}, [], NOW, "discord");
  assert.equal(s.status, "unchecked");
  assert.equal(s.text, "Not checked yet");
});

test("checklistRowStatus: ok probe with a recent readStat reads 'Read OK · rows · items'", () => {
  const row = { id: "channel", label: "channel", how: "open" };
  const probeByPage = {
    channel: { counts: { messageRows: 25, channelRows: 8 }, ok: true, hints: [] },
  };
  const stats = [
    { source: "discord", at: minAgo(4), kind: "observe", scope: "discord", items: 3 },
  ];
  const s = checklistRowStatus(row, probeByPage, stats, NOW, "discord");
  assert.equal(s.status, "ok");
  assert.match(s.text, /Read OK · 25 rows · 3 items/);
});

test("checklistRowStatus: a not-ok probe reports fail with its hints", () => {
  const row = { id: "channel", label: "channel", how: "open" };
  const probeByPage = {
    channel: {
      counts: { channelRows: 0, messageRows: 0 },
      ok: false,
      hints: ["Open a channel with recent messages.", "Scroll the channel list so channels load."],
    },
  };
  const s = checklistRowStatus(row, probeByPage, [], NOW, "discord");
  assert.equal(s.status, "fail");
  assert.equal(s.text, "Open a channel with recent messages.");
  assert.deepEqual(s.hints, probeByPage.channel.hints);
});

test("aliased rows: discord timestamp satisfied by a channel probe with messageTimes", () => {
  const row = { id: "timestamp", label: "ts", how: "find" };
  const ok = checklistRowStatus(
    row,
    { channel: { counts: { messageRows: 10, messageTimes: 4 }, ok: true, hints: [] } },
    [],
    NOW,
    "discord"
  );
  assert.equal(ok.status, "ok");
  const none = checklistRowStatus(
    row,
    { channel: { counts: { messageRows: 10, messageTimes: 0 }, ok: true, hints: ["h"] } },
    [],
    NOW,
    "discord"
  );
  assert.equal(none.status, "fail");
});

test("learn has no probe: rows are satisfied by a recent sync readStat", () => {
  const rows = checklistFor(
    "learn",
    {},
    [{ source: "learn", at: minAgo(10), kind: "sync", items: 12 }],
    NOW
  );
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.equal(r.status, "ok");
    assert.match(r.text, /Read OK · 12 items/);
  }
  // Stale or empty reads don't count.
  const stale = checklistFor(
    "learn",
    {},
    [{ source: "learn", at: minAgo(90), kind: "sync", items: 12 }],
    NOW
  );
  assert.equal(stale[0].status, "unchecked");
  const empty = checklistFor(
    "learn",
    {},
    [{ source: "learn", at: minAgo(5), kind: "sync", items: 0 }],
    NOW
  );
  assert.equal(empty[0].status, "unchecked");
});

test("the single portal-open row requires a portal:schedule observe", () => {
  const rows = CHECK_SOURCES.portal.checklist;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "portal-open");
  const ok = checklistFor(
    "portal",
    {},
    [{ source: "portal", at: minAgo(5), kind: "observe", scope: "portal:schedule", items: 9 }],
    NOW
  );
  assert.equal(ok[0].status, "ok");
  const wrongScope = checklistFor(
    "portal",
    {},
    [{ source: "portal", at: minAgo(5), kind: "observe", scope: "portal:exams", items: 9 }],
    NOW
  );
  assert.equal(wrongScope[0].status, "unchecked");
});

test("readStat errors never satisfy a checklist row", () => {
  const rows = checklistFor(
    "learn",
    {},
    [{ source: "learn", at: minAgo(2), kind: "sync", items: 5, error: "timeout" }],
    NOW
  );
  assert.equal(rows[0].status, "unchecked");
});

test("gmail and outlook share the email checklist, filtered by id", () => {
  const g = CHECK_SOURCES.gmail.checklist;
  const o = CHECK_SOURCES.outlook.checklist;
  assert.ok(g.length > 0 && o.length > 0);
  assert.ok(g.every((r) => r.id.startsWith("gmail")));
  assert.ok(o.every((r) => r.id.startsWith("outlook")));
});

test("recordProbe keeps only the latest result per page", () => {
  let probes = recordProbe({}, { source: "waterlooworks", page: "applications", counts: { listRows: 5 }, ok: true });
  probes = recordProbe(probes, { source: "waterlooworks", page: "interviews", counts: { rows: 2 }, ok: false, hints: ["h"] });
  probes = recordProbe(probes, { source: "waterlooworks", page: "applications", counts: { listRows: 9 }, ok: true });
  assert.equal(probes.waterlooworks.applications.counts.listRows, 9);
  assert.equal(probes.waterlooworks.interviews.ok, false);
  assert.equal(Object.keys(probes.waterlooworks).length, 2);
});

test("appendReadStat caps the list at READ_STATS_CAP", () => {
  let list = [];
  for (let i = 0; i < READ_STATS_CAP + 5; i++) {
    list = appendReadStat(list, { source: "learn", at: minAgo(0), kind: "sync", items: i });
  }
  assert.equal(list.length, READ_STATS_CAP);
  assert.equal(list[list.length - 1].items, READ_STATS_CAP + 4);
});

test("shouldSendProbe: first send, skip unchanged, at most once per interval", () => {
  let last = { at: 0, json: "" };
  assert.equal(shouldSendProbe(last, "A", 10000), true);
  last = { at: 10000, json: "A" };
  assert.equal(shouldSendProbe(last, "A", 14000), false); // unchanged
  assert.equal(shouldSendProbe(last, "A", 20000), false); // unchanged forever
  assert.equal(shouldSendProbe(last, "B", 12000), false); // changed but inside 5s
  assert.equal(shouldSendProbe(last, "B", 16000), true);  // changed after 5s
});

test("checkReport: statuses + probes + readStats + structures, no page text", () => {
  const report = checkReport({
    probes: {
      discord: { channel: { counts: { messageRows: 7 }, ok: true, hints: [], at: minAgo(3) } },
    },
    readStats: [
      { source: "discord", at: minAgo(2), kind: "observe", scope: "discord", items: 2 },
      { source: "learn", at: minAgo(1), kind: "sync", items: 30 },
    ],
    discovery: {
      "discovery:waterlooworks": {
        site: "waterlooworks",
        net: { "GET /x 200": { method: "GET" } },
        pages: {
          "/applications": {
            path: "/applications",
            title: "REDACTED PAGE TITLE THAT MUST NOT LEAK",
            count: 2,
            note: "missed the interview row",
            variants: [{ outline: { html: 1 }, count: 2, lastAt: minAgo(1) }],
          },
        },
      },
    },
    now: NOW,
  });
  assert.equal(report.kind, "waterloo-all-in-1-check");
  const discord = report.sources.discord.rows.find((r) => r.id === "channel");
  assert.equal(discord.status, "ok");
  assert.equal(report.sources.learn.rows[0].status, "ok");
  assert.equal(report.structures.waterlooworks.pages[0].note, "missed the interview row");
  const json = JSON.stringify(report);
  assert.ok(!json.includes("REDACTED PAGE TITLE"), "titles must not leak into the report");
  assert.ok(!json.includes('"net"'), "net records stay out of the check report");
});

test("v2 row metadata: learn/portal urls, essential, refreshDays", () => {
  const [home, course] = CHECK_SOURCES.learn.checklist;
  assert.equal(home.id, "learn-home");
  assert.equal(home.url, "https://learn.uwaterloo.ca/d2l/home");
  assert.equal(home.essential, true);
  assert.equal(course.url, undefined);
  assert.ok(!course.essential);

  // Portal is a single row now that auto-fetch reads everything from any page.
  const [open] = CHECK_SOURCES.portal.checklist;
  assert.equal(open.id, "portal-open");
  assert.equal(open.url, "https://portal.uwaterloo.ca/");
  assert.equal(open.essential, true);
  assert.equal(open.refreshDays, 14);
});

test("PORTAL_OPEN_ROW is Portal's live checklist row", () => {
  assert.deepEqual(PORTAL_OPEN_ROW, {
    id: "portal-open",
    label: "Open Portal once",
    how: "Open any Portal page — your schedule, exams and term dates are read while it's open.",
    url: "https://portal.uwaterloo.ca/",
    essential: true,
    refreshDays: 14,
    stat: { kind: "observe", scope: "portal:schedule", itemsMin: 1 },
  });
});
