// @ts-check
// Smoke render for the Sources segments: esbuild bundles the real
// Check/PickedUp modules (JSX -> preact), then renders them into a linkedom
// document. Both render for waterlooworks and discord; the Discord sweep
// controls appear only for discord.

import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
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
const { Check, PickedUp, h, render } = mod;

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
    assert.ok(text.includes("In review"), "pending badge");
  });
}

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
