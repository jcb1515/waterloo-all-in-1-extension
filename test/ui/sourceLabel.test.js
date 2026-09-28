// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { itemSourceIds, sourceLabel, sourceBadge } from "../../extension/src/ui/sourceLabel.js";

const item = (over = {}) => ({
  id: "i1",
  type: "meeting",
  title: "Sync",
  startAt: "2026-10-08T23:00:00.000Z",
  source: "portal",
  seenIn: [{ source: "portal", scope: "calendar" }],
  ...over,
});

test("itemSourceIds reads seenIn objects, dedupes and orders by precedence", () => {
  const i = item({
    source: "portal",
    seenIn: [
      { source: "gmail" },
      { source: "outline" },
      { source: "portal" },
      { source: "gmail" },
    ],
  });
  assert.deepEqual(itemSourceIds(i), ["portal", "outline", "gmail"]);
});

test("itemSourceIds falls back to item.source when seenIn is absent", () => {
  const i = item({ seenIn: undefined, source: "learn" });
  assert.deepEqual(itemSourceIds(i), ["learn"]);
});

test("primary-source precedence: WaterlooWorks and Portal beat email/outline", () => {
  assert.equal(
    sourceBadge(item({ source: "waterlooworks", seenIn: [{ source: "gmail" }, { source: "waterlooworks" }] }))?.label,
    "WaterlooWorks",
  );
  assert.equal(
    sourceBadge(item({ source: "portal", seenIn: [{ source: "outline" }, { source: "portal" }] }))?.label,
    "Portal",
  );
  assert.equal(
    sourceBadge(item({ source: "learn", seenIn: [{ source: "gmail" }, { source: "learn" }] }))?.label,
    "Learn",
  );
});

test("Discord badge carries the team name from org", () => {
  const b = sourceBadge(item({ source: "discord", seenIn: [{ source: "discord" }], org: "WATonomous" }));
  assert.equal(b?.label, "Discord · WATonomous");
  assert.equal(b?.color, "var(--src-discord)");
});

test("Discord without an org falls back to plain Discord", () => {
  const b = sourceBadge(item({ source: "discord", seenIn: [{ source: "discord" }], org: undefined }));
  assert.equal(b?.label, "Discord");
});

test("email provider comes from the source id", () => {
  assert.equal(sourceBadge(item({ source: "gmail", seenIn: [{ source: "gmail" }] }))?.label, "Gmail");
  assert.equal(sourceBadge(item({ source: "outlook", seenIn: [{ source: "outlook" }] }))?.label, "Outlook");
});

test("email provider comes from meta.provider when the source isn't a provider", () => {
  const i = item({ source: "email", seenIn: [{ source: "email" }], meta: { provider: "outlook" } });
  assert.equal(sourceLabel("email", i), "Outlook");
  // meta.provider also surfaces the provider as a source id
  assert.ok(itemSourceIds(i).includes("outlook"));
});

test("manual and project items read Mine", () => {
  assert.equal(sourceBadge(item({ source: "manual", seenIn: [{ source: "manual" }] }))?.label, "Mine");
  const proj = item({ source: "manual", seenIn: [{ source: "manual" }], meta: { projectId: "p1" } });
  assert.equal(sourceBadge(proj)?.label, "Mine");
});

test("gcal items read Google Calendar", () => {
  assert.equal(sourceBadge(item({ source: "gcal", seenIn: [{ source: "gcal" }] }))?.label, "Google Calendar");
});

test("multi-source badge collapses to +N and titles every source", () => {
  const b = sourceBadge(
    item({ source: "portal", seenIn: [{ source: "portal" }, { source: "outline" }, { source: "gmail" }] }),
  );
  assert.equal(b?.label, "Portal");
  assert.equal(b?.extra, 2);
  assert.equal(b?.title, "Portal · Outline · Gmail");
});

test("a sourceless item yields no badge", () => {
  assert.equal(sourceBadge({ id: "x", type: "event", title: "?" }), null);
});

test("unknown source ids label with the raw id and a neutral colour", () => {
  const b = sourceBadge(item({ source: "mystery", seenIn: [{ source: "mystery" }] }));
  assert.equal(b?.label, "mystery");
  assert.equal(b?.color, "var(--text-3)");
});
