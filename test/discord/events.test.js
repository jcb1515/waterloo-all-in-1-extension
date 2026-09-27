// @ts-check
// Scheduled-events extraction: pure parser on synthetic extracts matching
// the real modal wording, the DOM reader on hand-built fixtures, and the
// adapter's state/output wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import { applyResult } from "../../extension/src/core/merge.js";
import adapter from "../../extension/src/sources/discord/index.js";
import {
  parseEventsExtract,
  parseEventDateLine,
} from "../../extension/src/sources/discord/events.js";
import { eventsModalExtract } from "../../extension/src/sources/discord/dom.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "discord"
);
const doc = (name) =>
  parseHTML(readFileSync(path.join(FIXTURES, name), "utf8")).document;

// Friday Sep 25 2026, 11am Toronto — all fixture events are upcoming.
const NOW = new Date("2026-09-25T15:00:00.000Z");
const NOW_MS = NOW.getTime();
const AT = NOW.toISOString();
const G = "1000000000000000001";
const EV1 = "7000000000000000011"; // Rover Autonomy Sync
const EV2 = "7000000000000000012"; // WATcloud Weekly Sync

const SETTINGS = { watched: { "Robotics Club": { focus: ["electrical"] } } };

const dom = (extract, url = `https://discord.com/channels/${G}/2001`) => ({
  source: "discord",
  kind: "dom",
  url,
  body: JSON.stringify(extract),
  at: AT,
});

function makeCtx(state = {}, settings = SETTINGS) {
  return { state, now: NOW, settings, textDates: extractDates, log() {} };
}

const inventory = {
  v: 1,
  type: "inventory",
  location: { guildId: G, channelId: "2001" },
  guilds: [{ guildId: G, name: "Robotics Club", unread: false, mentions: 0 }],
  channels: [
    {
      channelId: "2001", guildId: G, name: "announcements", type: "text",
      order: 0, unread: false, mentions: 0, limited: false,
    },
  ],
};

const L = (text, over = {}) => ({ text, heading: false, icon: false, ...over });

/* ----------------------------- parser ---------------------------------- */

test("event date line: weekday+month+day+time, ranges, year inference", () => {
  const d1 = parseEventDateLine("Tue Sep 29th · 6:00 PM", NOW_MS, "America/Toronto");
  assert.deepEqual(d1.start, { y: 2026, m: 9, d: 29, h: 18, mi: 0 });
  assert.equal(d1.end, null);

  const rng = parseEventDateLine(
    "Tue Sep 29th · 6:00 PM — Thu Oct 1st · 7:00 PM",
    NOW_MS,
    "America/Toronto"
  );
  assert.deepEqual(rng.end, { y: 2026, m: 10, d: 1, h: 19, mi: 0 });

  // Across a year boundary: now Dec 28, "Tue Jan 5th" resolves to 2027
  // (Jan 5 2027 is a Tuesday — the weekday pins the year).
  const xb = parseEventDateLine(
    "Tue Jan 5th · 6:00 PM",
    Date.parse("2026-12-28T12:00:00.000Z"),
    "America/Toronto"
  );
  assert.equal(xb.start.y, 2027);
  assert.deepEqual([xb.start.m, xb.start.d], [1, 5]);

  // Today/Tomorrow resolve against Toronto wall time.
  const t = parseEventDateLine("Today · 6:00 PM", NOW_MS, "America/Toronto");
  assert.deepEqual([t.start.y, t.start.m, t.start.d], [2026, 9, 25]);
  const tm = parseEventDateLine("Tomorrow at 6:00 PM", NOW_MS, "America/Toronto");
  assert.deepEqual([tm.start.y, tm.start.m, tm.start.d], [2026, 9, 26]);

  // Non-dates stay non-dates.
  assert.equal(parseEventDateLine("9pm ET", NOW_MS, "America/Toronto"), null);
  assert.equal(parseEventDateLine("Runs for ~1 hour", NOW_MS, "America/Toronto"), null);
});

const LIST_CARDS = [
  {
    lines: [
      L("Tue Sep 29th · 6:00 PM"),
      L("Repeats every Tuesday"),
      L("6"),
      L("Rover Autonomy Sync", { heading: true }),
      L("Weekly Rover Autonomy Syncs and Office Hours"),
      L("E7-5344", { icon: true }),
      L("…"),
      L("Copy Link"),
      L("Interested"),
      L("Events in series"),
      L("Tue Sep 29th · 6:00 PM"),
      L("Tue Oct 6th · 6:00 PM"),
      L("Tue Oct 13th · 6:00 PM"),
      L("Tue Oct 20th · 6:00 PM"),
    ],
    interested: true,
    eventRef: `events/${G}/${EV1}`,
  },
  {
    lines: [
      L("Wed Sep 30th · 9:00 PM"),
      L("Repeats every Wednesday"),
      L("9"),
      L("WATcloud Weekly Sync", { heading: true }),
      L("9pm ET"),
      L("Runs for ~1 hour"),
      L("…"),
      L("Copy Link"),
      L("Interested"),
    ],
    interested: false,
    eventRef: `events/${G}/${EV2}`,
  },
];

const listExtract = {
  v: 1,
  type: "events",
  location: { guildId: G },
  tz: "America/Toronto",
  modal: "list",
  guildName: "Robotics Club",
  cards: LIST_CARDS,
};

test("list extract: interested series -> listed + generated occurrences", () => {
  const items = parseEventsExtract(listExtract, {
    now: NOW,
    nowIso: AT,
    team: "Robotics Club",
  });
  const rover = items.filter((i) => i.title === "Rover Autonomy Sync");
  // Listed: Sep 29, Oct 6/13/20. Generated weekly: Oct 27, Nov 3.
  assert.equal(rover.length, 6);
  assert.equal(rover[0].startAt, "2026-09-29T22:00:00.000Z"); // 6pm EDT
  assert.equal(rover[0].endAt, "2026-09-29T23:00:00.000Z"); // no range → +1h
  assert.equal(rover[0].location, "E7-5344");
  assert.equal(rover[0].org, "Robotics Club");
  assert.equal(rover[0].type, "meeting");
  assert.equal(rover[0].category, "scheduled-event");
  assert.equal(
    rover[0].url,
    `https://discord.com/events/${G}/${EV1}`
  );
  assert.equal(rover[0].review, "auto");
  assert.equal(rover[0].confidence, "exact");
  assert.equal(
    rover[0].id,
    `discord:event:${G}:rover-autonomy-sync:2026-09-29`
  );
  assert.equal(rover[0].meta.recurrence.freq, "WEEKLY");
  assert.equal(rover[0].meta.recurrence.byDay, "TU");
  assert.equal(rover[0].meta.recurrence.time, "18:00");
  assert.ok(rover[0].meta.recurrence.occurrences.length <= 10);
  const gen = rover.filter((i) => i.meta.generated);
  assert.equal(gen.length, 2); // Oct 27 + Nov 3, inside now+6wk
  assert.ok(gen.every((i) => i.confidence === "tentative" && i.review === "auto"));
  assert.deepEqual(
    gen.map((i) => i.startAt),
    ["2026-10-27T22:00:00.000Z", "2026-11-03T23:00:00.000Z"] // Nov 3 = EST
  );
});

test("list extract: items carry meta.facts", () => {
  const items = parseEventsExtract(listExtract, {
    now: NOW,
    nowIso: AT,
    team: "Robotics Club",
  });
  const fmap = (it) =>
    Object.fromEntries((it.meta.facts || []).map((f) => [f.label, f.value]));
  const rover = fmap(items.find((i) => i.title === "Rover Autonomy Sync"));
  assert.equal(rover.Server, "Robotics Club");
  assert.equal(rover.Repeats, "Every Tuesday");
  assert.equal(rover.Where, "E7-5344");
  assert.equal(rover.Series, "Sep 29, Oct 6, Oct 13, Oct 20");
  assert.equal(rover.Interested, "Yes");
  const wat = fmap(items.find((i) => i.title === "WATcloud Weekly Sync"));
  assert.equal(wat.Server, "Robotics Club");
  assert.equal(wat.Repeats, "Every Wednesday");
  assert.equal(wat.Series, "Sep 30");
  assert.equal(wat.Interested, undefined); // "Yes" only when true
  assert.equal(wat.Where, undefined);
});

test("list extract: not-interested series -> one pending item only", () => {
  const items = parseEventsExtract(listExtract, {
    now: NOW,
    nowIso: AT,
    team: "Robotics Club",
  });
  const wat = items.filter((i) => i.title === "WATcloud Weekly Sync");
  assert.equal(wat.length, 1);
  assert.equal(wat[0].startAt, "2026-10-01T01:00:00.000Z"); // 9pm EDT Sep 30
  assert.equal(wat[0].review, "pending");
  assert.equal(wat[0].meta.pendingSeries, true);
  // "9pm ET"/"Runs for ~1 hour" land in the bounded description, not fields.
  assert.match(wat[0].details || "", /Runs for ~1 hour/);
  assert.equal(wat[0].location, undefined);
});

const DETAIL_CARDS = [
  {
    lines: [
      L("Rover Autonomy Sync", { heading: true }), // modal header
      L("Event Info"),
      L("6 Interested"),
      L("Tue Sep 29th · 6:00 PM — Thu Oct 1st · 7:00 PM"),
      L("Rover Autonomy Sync", { heading: true }), // repeated title
      L("Robotics Club"), // guild name line — dropped
      L("E7-5344", { icon: true }),
      L("6 people are interested"),
      // ("Created by …" never reaches the parser — dropped at extraction)
      L("Weekly Rover Autonomy Syncs and Office Hours"),
      L("Events in series"),
      L("Tue Sep 29th · 6:00 PM"),
      L("Tue Oct 6th · 6:00 PM"),
      L("Tue Oct 13th · 6:00 PM"),
      L("Tue Oct 20th · 6:00 PM"),
      L("…"),
      L("Copy Link"),
      L("Interested"),
    ],
    interested: true,
    eventRef: `events/${G}/${EV1}`,
  },
];

test("detail extract: range on a repeating event collapses to same-day end", () => {
  const items = parseEventsExtract(
    { ...listExtract, modal: "detail", cards: DETAIL_CARDS },
    { now: NOW, nowIso: AT, team: "Robotics Club" }
  );
  const rover = items.filter((i) => i.title === "Rover Autonomy Sync");
  assert.equal(rover.length, 6);
  assert.equal(rover[0].startAt, "2026-09-29T22:00:00.000Z");
  // The bogus "Thu Oct 1st" end collapses to 19:00 same day.
  assert.equal(rover[0].endAt, "2026-09-29T23:00:00.000Z");
  // Description survives; the guild name + repeated title do not.
  assert.match(rover[0].details || "", /Weekly Rover Autonomy/);
  assert.ok(!/Robotics Club/.test(rover[0].details || ""));
});

test("RSVP list overrides a null Interested button", () => {
  const cards = [
    {
      ...LIST_CARDS[1],
      interested: null, // button heuristic failed
    },
  ];
  const items = parseEventsExtract(
    { ...listExtract, cards },
    { now: NOW, nowIso: AT, team: "Robotics Club", rsvps: [EV2] }
  );
  // Interested via RSVP -> the anchor plus weekly generated occurrences
  // (Oct 7/14/21/28, Nov 4 — inside now+6wk), all auto-reviewed.
  assert.equal(items.length, 6);
  assert.ok(items.every((i) => i.review === "auto"));
  assert.equal(items.filter((i) => i.meta.generated).length, 5);
});

/* --------------------------- DOM reader -------------------------------- */

test("eventsModalExtract: list modal -> two cards with hints", () => {
  const ex = eventsModalExtract(
    doc("events-modal.html"),
    `https://discord.com/channels/${G}/2001`
  );
  assert.equal(ex.modal, "list");
  assert.equal(ex.guildName, "Robotics Club");
  assert.equal(ex.location.guildId, G);
  assert.equal(ex.cards.length, 2);
  const [c1, c2] = ex.cards;
  assert.equal(c1.interested, true); // aria-pressed
  assert.equal(c2.interested, false); // button present, not pressed
  assert.equal(c1.eventRef, `events/${G}/${EV1}`);
  const texts = c1.lines.map((l) => l.text);
  assert.ok(texts.includes("Rover Autonomy Sync"));
  assert.ok(texts.includes("Events in series"));
  assert.ok(texts.includes("Tue Oct 20th · 6:00 PM"));
  const title = c1.lines.find((l) => l.text === "Rover Autonomy Sync");
  assert.equal(title.heading, true);
  const loc = c1.lines.find((l) => l.text === "E7-5344");
  assert.equal(loc.icon, true);
  // Action buttons came through as lines the parser will skip.
  assert.ok(texts.includes("Copy Link"));
});

test("eventsModalExtract: detail modal -> one card, no attendee names", () => {
  const ex = eventsModalExtract(
    doc("events-detail.html"),
    `https://discord.com/channels/${G}/2001`
  );
  assert.equal(ex.modal, "detail");
  assert.equal(ex.cards.length, 1);
  const json = JSON.stringify(ex);
  assert.ok(!json.includes("Alex Person")); // "Created by" never leaves
  const texts = ex.cards[0].lines.map((l) => l.text);
  assert.ok(texts.some((t) => t.includes("— Thu Oct 1st")));
});

test("eventsModalExtract returns null when no events dialog is open", () => {
  assert.equal(
    eventsModalExtract(doc("sidebar.html"), "https://discord.com/channels/1/2"),
    null
  );
});

/* ---------------------------- adapter ---------------------------------- */

test("a list read stores guild events; output is watched-guild items", async () => {
  const r1 = await adapter.observe.parse(dom(inventory), makeCtx());
  const r2 = await adapter.observe.parse(dom(listExtract), makeCtx(r1.state));
  const events = r2.state.lastGood.events[G].items;
  assert.equal(events.length, 7); // 6 rover + 1 watcloud
  const out = r2.items.filter((i) => i.category === "scheduled-event");
  assert.equal(out.length, 7);
  assert.ok(out.every((i) => i.org === "Robotics Club"));
  // Fold through the real core: scope replace keeps them atomic.
  const raw = applyResult(null, r2, { mode: "scope", scope: r2.scope });
  assert.equal(
    raw.items.filter((i) => i.category === "scheduled-event").length,
    7
  );
});

test("unwatched guild events are stored but hidden from output", async () => {
  const r1 = await adapter.observe.parse(dom(inventory), makeCtx());
  const r2 = await adapter.observe.parse(
    dom(listExtract),
    makeCtx(r1.state, { watched: { "Other Server": {} } })
  );
  assert.equal(r2.state.lastGood.events[G].items.length, 7);
  assert.equal(
    r2.items.filter((i) => i.category === "scheduled-event").length,
    0
  );
});

test("a detail read replaces only its own series", async () => {
  const r1 = await adapter.observe.parse(dom(inventory), makeCtx());
  const r2 = await adapter.observe.parse(dom(listExtract), makeCtx(r1.state));
  // Detail read of the rover series with a moved start (7pm not 6pm).
  const detail = {
    ...listExtract,
    modal: "detail",
    cards: [
      {
        ...DETAIL_CARDS[0],
        lines: DETAIL_CARDS[0].lines.map((l) =>
          l.text.includes("— Thu Oct 1st")
            ? L("Tue Sep 29th · 7:00 PM — Thu Oct 1st · 8:00 PM")
            : /^\s*Tue \w+ \d+\w* · 6:00 PM/.test(l.text)
              ? L(l.text.replace("6:00 PM", "7:00 PM"))
              : l
        ),
      },
    ],
  };
  const r3 = await adapter.observe.parse(dom(detail), makeCtx(r2.state));
  const events = r3.state.lastGood.events[G].items;
  const rover = events.filter((i) => i.meta.series === "rover-autonomy-sync");
  const wat = events.filter((i) => i.meta.series === "watcloud-weekly-sync");
  assert.equal(wat.length, 1); // untouched by the detail read
  assert.ok(rover.every((i) => i.startAt.includes("T23:00") || i.meta.generated));
  assert.ok(
    rover.some((i) => i.startAt === "2026-09-29T23:00:00.000Z"),
    "7pm Toronto"
  );
});

test("a list re-read replaces the guild's events wholesale", async () => {
  const r1 = await adapter.observe.parse(dom(inventory), makeCtx());
  const r2 = await adapter.observe.parse(dom(listExtract), makeCtx(r1.state));
  const solo = { ...listExtract, cards: [LIST_CARDS[1]] };
  const r3 = await adapter.observe.parse(dom(solo), makeCtx(r2.state));
  const events = r3.state.lastGood.events[G].items;
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "WATcloud Weekly Sync");
});

test("event occurrences older than a day are pruned on each parse", async () => {
  const r1 = await adapter.observe.parse(dom(inventory), makeCtx());
  const stale = {
    ...listExtract,
    cards: [
      {
        lines: [L("Tue Sep 22nd · 6:00 PM"), L("Old Event", { heading: true })],
        interested: null,
        eventRef: null,
      },
    ],
  };
  const r2 = await adapter.observe.parse(dom(stale), makeCtx(r1.state));
  assert.equal(r2.state.lastGood.events[G].items.length, 0);
});

test("a scheduled event series suppresses the matching recurring suggestion", async () => {
  const r1 = await adapter.observe.parse(dom(inventory), makeCtx());
  const state = {
    ...r1.state,
    // Two occurrences, two ISO weeks -> a recurring suggestion would fire.
    meetingLog: [
      {
        guildId: G, channelId: "2001", key: "rover autonomy sync",
        startAt: "2026-09-22T22:00:00.000Z", at: AT, messageId: "1",
      },
      {
        guildId: G, channelId: "2001", key: "rover autonomy sync",
        startAt: "2026-09-29T22:00:00.000Z", at: AT, messageId: "2",
      },
    ],
  };
  const r2 = await adapter.observe.parse(dom(listExtract), makeCtx(state));
  const recurring = r2.items.filter((i) => i.category === "recurring");
  assert.equal(recurring.length, 0); // Tue 18:00 slot is covered by the event
});

test("an RSVP REST read marks the series interested on the next modal read", async () => {
  const r1 = await adapter.observe.parse(dom(inventory), makeCtx());
  const r2 = await adapter.observe.parse(
    {
      source: "discord",
      kind: "net",
      url: "https://discord.com/api/v10/users/@me/scheduled-events",
      method: "GET",
      status: 200,
      body: JSON.stringify([{ guild_scheduled_event_id: EV2 }]),
      at: AT,
    },
    makeCtx(r1.state)
  );
  assert.deepEqual(r2.state.rsvps, [EV2]);
  const r3 = await adapter.observe.parse(dom(listExtract), makeCtx(r2.state));
  const wat = r3.state.lastGood.events[G].items.filter(
    (i) => i.meta.series === "watcloud-weekly-sync"
  );
  // Interested via RSVP: every occurrence emitted, auto review.
  assert.ok(wat.length > 1);
  assert.ok(wat.every((i) => i.review === "auto"));
});
