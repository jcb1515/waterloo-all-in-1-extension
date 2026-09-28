// @ts-check
// foundNotAdded (panel/model/agenda.js) + Upcoming's "Found, not added yet"
// section: pending finds with no verdict or to-do pin, anchored in
// [now, now + 21d]; excluded by verdicts, pins, hidden/cancelled/term-date/
// archived-project, or the review.showPending setting.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { parseHTML, CustomEvent } from "linkedom";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildAgenda,
  foundNotAdded,
} from "../../extension/src/panel/model/agenda.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOW = new Date("2026-10-15T18:00:00.000Z"); // a Thursday
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400000;

/** A pending find anchored `offsetDays` from now. */
const pending = (id, offsetDays, over = {}) => ({
  id,
  type: "event",
  source: "waterlooworks",
  title: `Event ${id}`,
  startAt: iso(NOW.getTime() + offsetDays * DAY),
  endAt: iso(NOW.getTime() + offsetDays * DAY + 3600000),
  review: "pending",
  meta: {},
  ...over,
});

/* ------------------------------- model -------------------------------- */

test("pending items inside the window list, sorted by anchor", () => {
  const items = {
    b: pending("b", 10),
    a: pending("a", 2),
    c: pending("c", 5),
  };
  const out = foundNotAdded({ items, userState: {}, settings: {}, now: NOW });
  assert.deepEqual(out.map((i) => i.id), ["a", "c", "b"]);
});

test("verdicts, to-do pins and showPending remove the item", () => {
  const items = {
    kept: pending("kept", 1),
    acc: pending("acc", 1),
    dis: pending("dis", 1),
    todo: pending("todo", 1),
    nulled: pending("nulled", 1),
  };
  const userState = {
    acc: { review: "accepted" },
    dis: { review: "dismissed" },
    todo: { todo: true },
    // The Review Undo writes review:null — that must NOT keep it out.
    nulled: { review: null },
  };
  const out = foundNotAdded({ items, userState, settings: {}, now: NOW });
  assert.deepEqual(out.map((i) => i.id).sort(), ["kept", "nulled"]);

  const shown = foundNotAdded({
    items,
    userState: {},
    settings: { review: { showPending: true } },
    now: NOW,
  });
  assert.deepEqual(shown, [], "showPending lists them in the normal groups");
});

test("past, far-future, cancelled, hidden, term-date and archived excluded", () => {
  const items = {
    kept: pending("kept", 1),
    past: pending("past", -1),
    far: pending("far", 22),
    cancelled: pending("cancelled", 1, { status: "cancelled" }),
    term: pending("term", 1, { type: "term-date", startAt: null, dueAt: iso(NOW.getTime() + DAY) }),
    proj: pending("proj", 1, { meta: { projectId: "p1" } }),
    rawPending: { ...pending("auto", 1), review: "auto" }, // not pending at all
  };
  const userState = { hid: { hidden: true } };
  items.hid = pending("hid", 1);
  const projects = [{ id: "p1", title: "P1", status: "archived" }];
  const out = foundNotAdded({ items, userState, settings: {}, now: NOW, projects });
  assert.deepEqual(out.map((i) => i.id), ["kept"]);
});

test("an override that moves the anchor out of the window drops the item", () => {
  const items = { x: pending("x", 1) };
  const out = foundNotAdded({
    items,
    userState: { x: { override: { startAt: iso(NOW.getTime() + 40 * DAY) } } },
    settings: {},
    now: NOW,
  });
  assert.deepEqual(out, []);
});

test("accepting a pending item moves it from foundNotAdded into buildAgenda", () => {
  const items = { ev: pending("ev", 1, { type: "deadline", startAt: null, dueAt: iso(NOW.getTime() + DAY) }) };
  const base = { items, settings: {}, now: NOW, projects: [] };

  assert.equal(foundNotAdded({ ...base, userState: {} }).length, 1);
  const pendingAgenda = buildAgenda({ ...base, userState: {} });
  assert.equal(
    pendingAgenda.groups.flatMap((g) => g.rows).some((r) => r.id === "ev"),
    false,
    "pending items stay out of the agenda groups"
  );

  const userState = { ev: { review: "accepted" } };
  assert.equal(
    foundNotAdded({ ...base, userState }).length,
    0,
    "accepted leaves the section"
  );
  const agenda = buildAgenda({ ...base, userState });
  assert.ok(
    agenda.groups.flatMap((g) => g.rows).some((r) => r.id === "ev"),
    "accepted appears in the agenda groups"
  );
});

/* ------------------------------- render -------------------------------- */

const dom = parseHTML("<!doctype html><html><body></body></html>");
globalThis.document = /** @type {any} */ (dom.document);
globalThis.location = /** @type {any} */ (
  new URL("http://localhost/src/panel/panel.html?preview=1")
);
globalThis.window = /** @type {any} */ ({
  open() {},
  addEventListener() {},
  removeEventListener() {},
});

const built = await build({
  stdin: {
    contents: `export { Upcoming } from "./extension/src/panel/views/Upcoming.jsx";
      export { h, render } from "preact";`,
    loader: "js",
    resolveDir: ROOT,
  },
  bundle: true,
  format: "esm",
  jsx: "automatic",
  jsxImportSource: "preact",
  write: false,
});
const bundlePath = path.join(
  mkdtempSync(path.join(tmpdir(), "wa1-found-")),
  "bundle.mjs"
);
writeFileSync(bundlePath, built.outputFiles[0].text);
const { Upcoming, h, render } = await import(pathToFileURL(bundlePath).href);

/** Minimal ready panel state carrying the given items. */
function stateFor(items, over = {}) {
  return {
    ready: true,
    items,
    userState: {},
    settings: {},
    projects: [],
    sourceState: {},
    probes: {},
    readStats: [],
    applications: {},
    updatesSeenAt: null,
    updates: [],
    ...over,
  };
}

function renderUpcoming(state, actions) {
  const root = dom.document.createElement("div");
  dom.document.body.appendChild(root);
  render(
    h(Upcoming, {
      state,
      actions,
      now: NOW,
      onGoSources() {},
      onGoCalendar() {},
    }),
    root
  );
  return root;
}

const click = (el) => el.dispatchEvent(new CustomEvent("click", { bubbles: true }));

const foundSection = (root) =>
  [...root.querySelectorAll("section.agenda-group")].find(
    (s) => s.getAttribute("aria-label") === "Found, not added yet"
  );

const foundActions = {
  openItem() {},
  setUserState() {},
  toast() {},
  toggleDone() {},
  open() {},
  openQuickAdd() {},
  dismissOnboarding() {},
  snoozeNudge() {},
  markOnboardingOpened() {},
};

test("the section is hidden when nothing is pending", () => {
  const root = renderUpcoming(
    stateFor({ done: pending("done", 1, { review: "auto" }) }),
    foundActions
  );
  try {
    assert.equal(foundSection(root), undefined);
    assert.ok(!root.textContent.includes("Found, not added yet"));
  } finally {
    root.remove();
  }
});

test("seven pending items render five rows plus 'Show all 7'", async () => {
  const items = {};
  for (let i = 1; i <= 7; i++) items[`e${i}`] = pending(`e${i}`, i + 1);
  const root = renderUpcoming(stateFor(items), foundActions);
  try {
    let section = foundSection(root);
    assert.ok(section, "section renders");
    assert.equal(section.querySelectorAll(".item-row").length, 5);
    const showAll = [...section.querySelectorAll("button")].find((b) =>
      (b.textContent || "").includes("Show all 7")
    );
    assert.ok(showAll, "Show all 7 rendered");
    click(showAll);
    // Preact queues the state-driven re-render on a microtask.
    await Promise.resolve();
    await Promise.resolve();
    section = foundSection(root);
    assert.equal(section.querySelectorAll(".item-row").length, 7);
    assert.equal(
      section.querySelectorAll(".badge-warn").length,
      7,
      "one Not added pill per row"
    );
  } finally {
    root.remove();
  }
});

test("the three verdict buttons write the exact userState patches", () => {
  const items = { e1: pending("e1", 3) };
  const calls = [];
  const toasts = [];
  const actions = {
    ...foundActions,
    setUserState: (id, patch) => calls.push([id, patch]),
    toast: (text, action) => toasts.push({ text, action }),
  };
  const root = renderUpcoming(stateFor(items), actions);
  try {
    // Scope to the section — the onboarding card has a Dismiss button too.
    const section = foundSection(root);
    assert.ok(section);
    const btn = (label) =>
      [...section.querySelectorAll("button")].find(
        (b) => (b.textContent || "").trim() === label
      );
    click(btn("Add to calendar"));
    click(btn("Add to To-do"));
    click(btn("Dismiss"));
    assert.deepEqual(calls, [
      ["e1", { review: "accepted" }],
      ["e1", { todo: true }],
      ["e1", { review: "dismissed" }],
    ]);
    assert.equal(toasts.length, 1, "dismiss shows the undo toast");
    assert.equal(toasts[0].text, "Event e1 dismissed");
    assert.equal(toasts[0].action.label, "Undo");
    calls.length = 0;
    toasts[0].action.run();
    assert.deepEqual(calls, [["e1", { review: null }]], "undo resets the verdict");
  } finally {
    root.remove();
  }
});
