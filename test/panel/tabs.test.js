// @ts-check
// Panel tab model: default order, saved reorder/hide, the Agenda pin and
// unknown-id tolerance.

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TABS, tabsFor, visibleTabs, editTabs } from "../../extension/src/panel/model/tabs.js";

test("tabsFor: null settings give the default order, all visible", () => {
  const tabs = tabsFor({});
  assert.deepEqual(
    tabs.map((t) => t.id),
    ["agenda", "todo", "calendar", "projects", "coop", "courses", "teams"]
  );
  assert.equal(tabs.every((t) => t.visible), true);
  assert.equal(visibleTabs({}).length, 7);
});

test("tabsFor: a saved list orders and hides; agenda is pinned visible", () => {
  const settings = {
    panel: {
      tabs: [
        { id: "todo", visible: true },
        { id: "agenda", visible: false }, // can't hide — pinned
        { id: "teams", visible: false },
        { id: "bogus", visible: true }, // unknown id dropped
      ],
    },
  };
  const tabs = tabsFor(settings);
  assert.deepEqual(
    tabs.map((t) => `${t.id}:${t.visible ? "v" : "h"}`),
    ["todo:v", "agenda:v", "teams:h", "calendar:v", "projects:v", "coop:v", "courses:v"],
    "saved order first, new tabs appended visible"
  );
  assert.deepEqual(
    visibleTabs(settings).map((t) => t.id),
    ["todo", "agenda", "calendar", "projects", "coop", "courses"],
    "visible list is what keys 1-7 follow"
  );
});

test("editTabs: persists {id, visible} pairs through save()", () => {
  const saved = [];
  const save = (p) => saved.push(p);
  editTabs(
    {},
    (list) => {
      // Move "teams" to the front and hide "courses".
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

test("editTabs: agenda stays visible even if the edit hides it", () => {
  const saved = [];
  editTabs({}, (list) => list.map((t) => ({ ...t, visible: false })), (p) => saved.push(p));
  const agenda = saved[0].panel.tabs.find((t) => t.id === "agenda");
  assert.equal(agenda.visible, true);
});

test("DEFAULT_TABS ids are unique and labelled", () => {
  assert.equal(new Set(DEFAULT_TABS.map((t) => t.id)).size, DEFAULT_TABS.length);
  assert.ok(DEFAULT_TABS.every((t) => t.label));
});
