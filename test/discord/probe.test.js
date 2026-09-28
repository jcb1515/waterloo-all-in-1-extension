// @ts-check
// Discord probe: exact counts per fixture, page kinds (channel /
// events-modal / dm / other / unknown), hints, and the counts-only
// privacy guarantee.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import {
  probe,
  CHECKLIST,
} from "../../extension/src/sources/discord/probe.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "discord"
);
const G = "1000000000000000001";
const CH = "2000000000000000001";
const HREF = `https://discord.com/channels/${G}/${CH}`;
const doc = (name) =>
  parseHTML(readFileSync(path.join(FIXTURES, name), "utf8")).document;

test("sidebar fixture: channel page with rail/channel counts, no messages", () => {
  const r = probe(doc("sidebar.html"), HREF);
  assert.equal(r.page, "channel");
  assert.deepEqual(r.counts, {
    guildRail: 4,
    channelRows: 8,
    categories: 2,
    unreadChannels: 2,
    messageRows: 0,
    messageTimes: 0,
    messageContent: 0,
    roleMentions: 0,
  });
  assert.equal(r.ok, false);
  assert.ok(r.hints.some((h) => /recent messages/i.test(h)));
});

test("chat fixture: message counts, no channel list", () => {
  const r = probe(doc("chat-messages.html"), HREF);
  assert.equal(r.page, "channel");
  assert.deepEqual(r.counts, {
    guildRail: 0,
    channelRows: 0,
    categories: 0,
    unreadChannels: 0,
    messageRows: 4,
    messageTimes: 5,
    messageContent: 4,
    roleMentions: 1,
  });
  assert.equal(r.ok, false);
  assert.ok(r.hints.some((h) => /channel list/i.test(h)));
});

test("a real channel page (sidebar + chat) is ok", () => {
  const combined = parseHTML(
    readFileSync(path.join(FIXTURES, "sidebar.html"), "utf8") +
      readFileSync(path.join(FIXTURES, "chat-messages.html"), "utf8")
  ).document;
  const r = probe(combined, HREF);
  assert.equal(r.page, "channel");
  assert.equal(r.ok, true);
  assert.deepEqual(r.hints, []);
  assert.equal(r.counts.channelRows, 8);
  assert.equal(r.counts.messageRows, 4);
});

test("events modal: events-modal page with card counts plus channel counts", () => {
  const r = probe(doc("events-modal.html"), HREF);
  assert.equal(r.page, "events-modal");
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, {
    guildRail: 1,
    channelRows: 0,
    categories: 0,
    unreadChannels: 0,
    messageRows: 0,
    messageTimes: 0,
    messageContent: 0,
    roleMentions: 0,
    eventsDialog: 1,
    eventCards: 2,
    dateLines: 6,
    seriesSections: 1,
    interestedButtons: 2,
    copyLinkButtons: 2,
  });
});

test("event detail modal counts as events-modal too", () => {
  const r = probe(doc("events-detail.html"), HREF);
  assert.equal(r.page, "events-modal");
  assert.equal(r.ok, true);
  assert.equal(r.counts.eventCards, 1);
  assert.equal(r.counts.dateLines, 5);
  assert.equal(r.counts.seriesSections, 1);
  assert.equal(r.counts.interestedButtons, 1);
  assert.equal(r.counts.copyLinkButtons, 1);
});

test("DM pages report only the rail and point at server channels", () => {
  const r = probe(
    doc("sidebar.html"),
    "https://discord.com/channels/@me/999999"
  );
  assert.equal(r.page, "dm");
  assert.deepEqual(r.counts, { guildRail: 4 });
  assert.equal(r.ok, false);
  assert.ok(r.hints.some((h) => /server channel/i.test(h)));
});

test("non-channel discord paths are 'other'", () => {
  const r = probe(doc("sidebar.html"), "https://discord.com/shop");
  assert.equal(r.page, "other");
  assert.equal(r.counts.channelRows, 8);
});

test("empty and garbage docs never throw and report unknown", () => {
  for (const bad of [
    parseHTML("").document,
    parseHTML("<p>hi</p>").document,
    null,
    undefined,
    {},
  ]) {
    const r = probe(bad, HREF);
    assert.equal(r.page, "unknown");
    assert.equal(r.ok, false);
    assert.deepEqual(r.counts, {});
    assert.ok(r.hints.length > 0);
  }
});

test("probe output carries no page text — counts only", () => {
  for (const name of [
    "sidebar.html",
    "chat-messages.html",
    "events-modal.html",
    "events-detail.html",
  ]) {
    const json = JSON.stringify(probe(doc(name), HREF));
    for (const secret of [
      "Robotics Club",
      "Rocket Team",
      "elec-general",
      "pcb-design",
      "schematic",
      "electrical",
      "Weekly",
      "E5-4128",
      "design review",
    ]) {
      assert.ok(!json.includes(secret), `${name} leaked "${secret}"`);
    }
  }
});

test("CHECKLIST is a list of {id, label, how} entries", () => {
  assert.ok(CHECKLIST.length >= 5);
  for (const item of CHECKLIST) {
    assert.ok(item.id && item.label && item.how);
  }
});
