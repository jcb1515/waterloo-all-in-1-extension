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
