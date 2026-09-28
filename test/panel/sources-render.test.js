// @ts-check
// Smoke render for the Sources segments: esbuild bundles the real
// Check/PickedUp modules (JSX -> preact), then renders them into a linkedom
// document. Both render for waterlooworks and discord; the Discord sweep
// controls appear only for discord.

import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { parseHTML, CustomEvent } from "linkedom";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The panel modules read location.search at import (preview detection) and
// render into document — install both before the bundle loads.
const dom = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
globalThis.document = /** @type {any} */ (dom.document);
globalThis.location = /** @type {any} */ (
  new URL("http://localhost/src/panel/panel.html?preview=1")
);
globalThis.window = /** @type {any} */ ({ open() {} });

const built = await build({
  stdin: {
    contents: `
      export { Check } from "./extension/src/panel/views/sources/Check.jsx";
      export { PickedUp } from "./extension/src/panel/views/sources/PickedUp.jsx";
      export { Coop } from "./extension/src/panel/views/Coop.jsx";
      export { h, render } from "preact";
    `,
    loader: "js",
    resolveDir: ROOT,
  },
  bundle: true,
  format: "esm",
  jsx: "automatic",
  jsxImportSource: "preact",
  write: false,
});

const bundlePath = path.join(mkdtempSync(path.join(tmpdir(), "wa1-render-")), "bundle.mjs");
writeFileSync(bundlePath, built.outputFiles[0].text);
const mod = await import(pathToFileURL(bundlePath).href);
const { Check, PickedUp, Coop, h, render } = mod;

const NOW = new Date("2026-09-28T15:00:00.000Z");
const actions = { open() {}, sync() {}, clearSource() {}, toast() {} };

/** Minimal panel state for one source. @param {string} sourceId */
function stateFor(sourceId) {
  return {
    items: {
      [`${sourceId}:i1`]: {
        id: `${sourceId}:i1`,
        source: sourceId,
        type: "interview",
        title: "Interview: Fixture Role",
        startAt: "2026-10-02T20:00:00.000Z",
        review: "auto",
      },
      [`${sourceId}:i2`]: {
        id: `${sourceId}:i2`,
        source: sourceId,
        type: "deadline",
        title: "Apply: Fixture Posting",
        dueAt: "2026-10-05T13:00:00.000Z",
        review: "pending",
      },
    },
    readStats: [
      {
        source: sourceId,
        at: "2026-09-28T14:00:00.000Z",
        kind: "observe",
        path: "/myAccount/dashboard.htm",
        items: 3,
      },
    ],
    probes: {},
    sourceState: {
      [sourceId]: {
        state:
          sourceId === "discord"
            ? {
                sweepQueue: [
                  { name: "announcements", guildName: "Fixture Guild", url: "https://discord.com/channels/1/2" },
                ],
                unreadWatched: [
                  { channelId: "2", name: "announcements", guildName: "Fixture Guild", url: "https://discord.com/channels/1/2", mentions: 0 },
                ],
              }
            : {},
        itemCount: 2,
        lastOkAt: "2026-09-28T14:00:00.000Z",
      },
    },
    projects: [],
  };
}

/** Render a component and return the container's text. */
function renderText(Component, props) {
  const root = dom.document.createElement("div");
  dom.document.body.appendChild(root);
  render(h(Component, props), root);
  const text = root.textContent || "";
  root.remove();
  return text;
}

/** Render a component and return the live container for interaction tests. */
function renderInto(Component, props) {
  const root = dom.document.createElement("div");
  dom.document.body.appendChild(root);
  render(h(Component, props), root);
  return root;
}

const click = (el) => el.dispatchEvent(new CustomEvent("click", { bubbles: true }));
const keydown = (el, key) => {
  const ev = new CustomEvent("keydown", { bubbles: true });
  ev.key = key;
  el.dispatchEvent(ev);
};

for (const sourceId of ["waterlooworks", "discord"]) {
  test(`Check renders for ${sourceId}`, () => {
    const text = renderText(Check, { sourceId, state: stateFor(sourceId), actions, now: NOW });
    assert.ok(text.includes("Recent reads"), "recent reads section");
    assert.ok(text.includes("observe"), "a read-stat row");
    assert.ok(text.includes("Download check report"), "report button");
    assert.ok(text.includes("Clear data"), "action row");
  });

  test(`PickedUp renders for ${sourceId}`, () => {
    const text = renderText(PickedUp, { sourceId, state: stateFor(sourceId), actions, now: NOW });
    assert.ok(text.includes("Interviews (1)"), "group header with count");
    assert.ok(text.includes("Interview: Fixture Role"), "item title");
    assert.ok(text.includes("Deadlines (1)"), "deadline group");
    assert.ok(text.includes("Not added"), "pending pill");
    assert.ok(!text.includes("In review"), "old badge text is gone");
  });

  test(`Check Open site opens the sourceSiteUrl for ${sourceId}`, () => {
    const opened = [];
    const root = renderInto(Check, {
      sourceId,
      state: stateFor(sourceId),
      actions: { ...actions, open: (u) => opened.push(u) },
      now: NOW,
    });
    try {
      const btn = [...root.querySelectorAll("button")].find((b) =>
        (b.textContent || "").includes("Open site")
      );
      assert.ok(btn, "Open site button rendered");
      click(btn);
      assert.equal(opened.length, 1);
      // The checklist's first https row wins over the bare origin.
      assert.ok(
        /^https:\/\//.test(opened[0]) && opened[0].length > "https://x/".length,
        `opened a real page: ${opened[0]}`
      );
      assert.ok(
        opened[0] !== `https://${new URL(opened[0]).host}/`,
        "checklist url, not the bare origin"
      );
    } finally {
      root.remove();
    }
  });
}

test("PickedUp rows open the shared item sheet via ItemRow/openItem", () => {
  const opened = [];
  const state = stateFor("waterlooworks");
  const root = renderInto(PickedUp, {
    sourceId: "waterlooworks",
    state,
    actions: { ...actions, openItem: (it) => opened.push(it) },
    now: NOW,
  });
  try {
    const rows = [...root.querySelectorAll(".item-row")];
    assert.equal(rows.length, 2, "both items render as ItemRow");
    click(rows[0]);
    assert.deepEqual(
      opened.map((i) => i.id),
      ["waterlooworks:i1"],
      "row click calls actions.openItem with the item"
    );
    // Keyboard access: Enter on the row opens the same sheet.
    keydown(rows[1], "Enter");
    assert.deepEqual(opened.map((i) => i.id), [
      "waterlooworks:i1",
      "waterlooworks:i2",
    ]);
  } finally {
    root.remove();
  }
});

test("PickedUp drops the Not added pill once a verdict lands", () => {
  const state = stateFor("waterlooworks");
  state.userState = { "waterlooworks:i2": { review: "accepted" } };
  const text = renderText(PickedUp, {
    sourceId: "waterlooworks",
    state,
    actions,
    now: NOW,
  });
  assert.ok(!text.includes("Not added"), "accepted item shows no pill");
  // A dismissed verdict also clears it.
  state.userState["waterlooworks:i2"] = { review: "dismissed" };
  const dismissed = renderText(PickedUp, {
    sourceId: "waterlooworks",
    state,
    actions,
    now: NOW,
  });
  assert.ok(!dismissed.includes("Not added"));
});

test("Check hides Open site when the source has no site url", () => {
  // "teams" has no adapter -> no checklist rows and no origins -> null.
  const text = renderText(Check, {
    sourceId: "teams",
    state: stateFor("teams"),
    actions,
    now: NOW,
  });
  assert.ok(!text.includes("Open site"), "button hidden without a site url");
  const empty = renderText(PickedUp, {
    sourceId: "teams",
    state: { items: {}, userState: {}, projects: [] },
    actions,
    now: NOW,
  });
  assert.ok(empty.includes("Nothing picked up yet"));
  assert.ok(!empty.includes("Open site"), "empty-state button hidden too");
});

test("Co-op Events: row body opens the item sheet, Add/Dismiss don't", () => {
  const ev = (id, over = {}) => ({
    id,
    type: "event",
    title: `Info Session ${id}`,
    status: "open",
    review: "pending",
    source: "waterlooworks",
    startAt: "2026-10-06T15:00:00Z",
    endAt: "2026-10-06T16:00:00Z",
    meta: {},
    ...over,
  });
  const state = {
    items: {
      "ww:ev:1": ev("ww:ev:1"),
      "ww:ev:2": ev("ww:ev:2", {
        review: "auto",
        meta: { registered: true },
        startAt: "2026-10-08T15:00:00Z",
        endAt: "2026-10-08T16:00:00Z",
      }),
    },
    userState: {},
    settings: {},
    applications: {},
    projects: [],
  };
  const opened = [];
  const verdicts = [];
  const root = renderInto(Coop, {
    state,
    actions: {
      openItem: (it) => opened.push(it.id),
      setUserState: (id, us) => verdicts.push([id, us.review]),
      open() {},
      toggleDone() {},
    },
    now: NOW,
  });
  try {
    assert.ok(root.textContent.includes("Not added"), "pending pill shown");
    assert.ok(root.textContent.includes("Registered"), "registered badge");

    const mains = [...root.querySelectorAll(".event-main")];
    assert.equal(mains.length, 2, "one row body per event");
    assert.equal(mains[0].getAttribute("role"), "link");
    // linkedom keeps tabIndex as an attribute (no property reflection).
    assert.equal(
      mains[0].getAttribute("tabIndex"),
      "0",
      "focusable for keyboard users"
    );

    click(mains[0]);
    assert.deepEqual(opened, ["ww:ev:1"], "pending row click -> openItem");
    keydown(mains[1], "Enter");
    assert.deepEqual(
      opened,
      ["ww:ev:1", "ww:ev:2"],
      "registered row Enter -> openItem too"
    );

    // The verdict buttons do their job and never open the sheet.
    const buttons = [...root.querySelectorAll(".event-acts button")];
    assert.equal(buttons.length, 2, "Add + Dismiss");
    click(buttons[0]);
    click(buttons[1]);
    assert.deepEqual(verdicts, [
      ["ww:ev:1", "accepted"],
      ["ww:ev:1", "dismissed"],
    ]);
    assert.deepEqual(opened, ["ww:ev:1", "ww:ev:2"], "no sheet from verdicts");
  } finally {
    root.remove();
  }
});

test("Check renders the Discord sweep controls only for discord", () => {
  const discord = renderText(Check, { sourceId: "discord", state: stateFor("discord"), actions, now: NOW });
  assert.ok(discord.includes("Start sweep"));
  assert.ok(discord.includes("Copy Discord report"));
  assert.ok(discord.includes("watched channel"), "unread watched list");

  const ww = renderText(Check, { sourceId: "waterlooworks", state: stateFor("waterlooworks"), actions, now: NOW });
  assert.ok(!ww.includes("Start sweep"));
  assert.ok(!ww.includes("Copy Discord report"));
  assert.ok(!ww.includes("watched channel"));
});
