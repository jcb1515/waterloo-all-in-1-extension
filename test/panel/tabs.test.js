// @ts-check
// Panel tab model (v2): four primary tabs + the More list, the agenda ->
// upcoming migration, saved-order/visibility for More views, and the
// primary-tab pin.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TABS,
  PRIMARY_TABS,
  MORE_TABS,
  tabsFor,
  primaryTabs,
  moreTabs,
  visibleTabs,
  editTabs,
  migrateTabId,
  moreSheetRows,
} from "../../extension/src/panel/model/tabs.js";

test("tabsFor: null settings give the v2 order — primary first, then More", () => {
  const tabs = tabsFor({});
  assert.deepEqual(
    tabs.map((t) => t.id),
    ["upcoming", "todo", "calendar", "sources", "courses", "coop", "teams", "projects"]
  );
  assert.equal(tabs.every((t) => t.visible), true);
  assert.deepEqual(primaryTabs({}).map((t) => t.id), ["upcoming", "todo", "calendar", "sources"]);
  assert.deepEqual(moreTabs({}).map((t) => t.id), ["courses", "coop", "teams", "projects"]);
});

test("migrateTabId: agenda -> upcoming, everything else passes through", () => {
  assert.equal(migrateTabId("agenda"), "upcoming");
  assert.equal(migrateTabId("courses"), "courses");
});

test("tabsFor: a saved v1 list migrates agenda and keeps More visibility/order", () => {
  const settings = {
    panel: {
      tabs: [
        { id: "todo", visible: true },
        { id: "agenda", visible: false }, // migrated -> upcoming (primary, pinned)
        { id: "teams", visible: false },
        { id: "coop", visible: true },
        { id: "bogus", visible: true }, // unknown id dropped
      ],
    },
  };
  const tabs = tabsFor(settings);
  assert.deepEqual(
    tabs.map((t) => `${t.id}:${t.visible ? "v" : "h"}`),
    [
      "upcoming:v",
      "todo:v",
      "calendar:v",
      "sources:v",
      "teams:h",
      "coop:v",
      "courses:v",
      "projects:v",
    ],
    "primary tabs always visible; More views in saved order, hidden kept hidden"
  );
  assert.deepEqual(
    moreTabs(settings).map((t) => t.id),
    ["coop", "courses", "projects"],
    "More dropdown skips the hidden view"
  );
});

test("visibleTabs: every visible tab id", () => {
  const settings = { panel: { tabs: [{ id: "teams", visible: false }] } };
  const ids = visibleTabs(settings).map((t) => t.id);
  assert.equal(ids.includes("teams"), false);
  assert.equal(ids.length, 7);
});

test("editTabs: persists {id, visible} pairs through save()", () => {
  const saved = [];
  const save = (p) => saved.push(p);
  editTabs(
    {},
    (list) => {
      const teams = list.find((t) => t.id === "teams");
      const rest = list.filter((t) => t.id !== "teams" && t.id !== "courses");
      const courses = { ...list.find((t) => t.id === "courses"), visible: false };
      return [teams, ...rest, courses];
    },
    save
  );
  assert.equal(saved.length, 1);
  const tabs = saved[0].panel.tabs;
  assert.equal(tabs[0].id, "teams");
  assert.equal(tabs[tabs.length - 1].id, "courses");
  assert.equal(tabs[tabs.length - 1].visible, false);
  assert.ok(tabs.every((t) => "id" in t && "visible" in t && !("label" in t)));
});

test("editTabs: primary tabs stay visible even if the edit hides them", () => {
  const saved = [];
  editTabs({}, (list) => list.map((t) => ({ ...t, visible: false })), (p) => saved.push(p));
  const upcoming = saved[0].panel.tabs.find((t) => t.id === "upcoming");
  const sources = saved[0].panel.tabs.find((t) => t.id === "sources");
  assert.equal(upcoming.visible, true);
  assert.equal(sources.visible, true);
});

test("DEFAULT_TABS ids are unique, labelled and partition primary/More", () => {
  assert.equal(new Set(DEFAULT_TABS.map((t) => t.id)).size, DEFAULT_TABS.length);
  assert.ok(DEFAULT_TABS.every((t) => t.label));
  assert.equal(PRIMARY_TABS.length, 4);
  assert.equal(MORE_TABS.length, 4);
  assert.deepEqual(
    DEFAULT_TABS.map((t) => t.id),
    [...PRIMARY_TABS, ...MORE_TABS].map((t) => t.id)
  );
});

/* ------------------------------ More sheet ------------------------------ */

const DAY = 86400000;
const SHEET_NOW = new Date("2026-10-15T16:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const t0 = SHEET_NOW.getTime();

const sheetItem = (id, over = {}) => ({
  id,
  source: "learn",
  type: "deadline",
  title: id,
  status: "open",
  ...over,
});

const sheetState = (over = {}) => ({
  items: {},
  applications: {},
  courses: {},
  projects: [],
  ...over,
});

test("moreSheetRows: one row per visible More view, in saved order", () => {
  const settings = {
    panel: {
      tabs: [
        { id: "teams", visible: false },
        { id: "projects", visible: true },
        { id: "coop", visible: true },
      ],
    },
  };
  const rows = moreSheetRows(settings, sheetState(), SHEET_NOW);
  assert.deepEqual(rows.map((r) => r.id), ["projects", "coop", "courses"], "saved order; hidden teams omitted");
  assert.ok(rows.every((r) => r.icon && r.description));
});

test("moreSheetRows: course count and singular/plural", () => {
  const one = moreSheetRows({}, sheetState({ courses: { "ECE 105": {} } }), SHEET_NOW);
  assert.equal(one.find((r) => r.id === "courses").count, "1 course");
  const many = moreSheetRows(
    {},
    sheetState({ courses: { "ECE 105": {}, "MATH 117": {}, "CS 246": {} } }),
    SHEET_NOW
  );
  assert.equal(many.find((r) => r.id === "courses").count, "3 courses");
  assert.equal(many.find((r) => r.id === "courses").description,
    "Outlines, grades and sections");
});

test("moreSheetRows: upcoming interviews beat the application count", () => {
  const state = sheetState({
    items: {
      i1: sheetItem("i1", { source: "waterlooworks", type: "interview", startAt: iso(t0 + DAY) }),
      i2: sheetItem("i2", { source: "waterlooworks", type: "interview", status: "cancelled", startAt: iso(t0 + DAY) }),
      i3: sheetItem("i3", { source: "waterlooworks", type: "interview", startAt: iso(t0 - DAY) }), // past
    },
    applications: {
      a1: { id: "a1", status: "interview-scheduled" },
      a2: { id: "a2", status: "applied" },
    },
  });
  assert.equal(moreSheetRows({}, state, SHEET_NOW).find((r) => r.id === "coop").count, "1 interview");
});

test("moreSheetRows: no interviews -> active applications -> no count", () => {
  const state = sheetState({
    applications: {
      a1: { id: "a1", status: "applied" },
      a2: { id: "a2", status: "interview-scheduled" },
      a3: { id: "a3", status: "matched" }, // outcome — not active
      a4: { id: "a4", status: "withdrawn" },
    },
  });
  assert.equal(moreSheetRows({}, state, SHEET_NOW).find((r) => r.id === "coop").count,
    "2 active applications");
  assert.equal(moreSheetRows({}, sheetState(), SHEET_NOW).find((r) => r.id === "coop").count, null);
});

test("moreSheetRows: discord items in the next 7 days count for Teams", () => {
  const state = sheetState({
    items: {
      d1: sheetItem("d1", { source: "discord", type: "meeting", startAt: iso(t0 + 2 * DAY) }),
      d2: sheetItem("d2", { source: "discord", type: "task", dueAt: iso(t0 + 9 * DAY) }), // too far
      d3: sheetItem("d3", { source: "gmail", type: "task", dueAt: iso(t0 + DAY), seenIn: [{ source: "discord" }] }),
      d4: sheetItem("d4", { source: "learn", dueAt: iso(t0 + DAY) }),
    },
  });
  assert.equal(moreSheetRows({}, state, SHEET_NOW).find((r) => r.id === "teams").count, "2 this week");
  assert.equal(moreSheetRows({}, sheetState(), SHEET_NOW).find((r) => r.id === "teams").count, null);
});

test("moreSheetRows: active projects count", () => {
  const state = sheetState({
    projects: [
      { id: "p1", name: "A", status: "active" },
      { id: "p2", name: "B", status: "archived" },
      { id: "p3", name: "C" }, // no status counts as active
    ],
  });
  assert.equal(moreSheetRows({}, state, SHEET_NOW).find((r) => r.id === "projects").count, "2 active");
});
