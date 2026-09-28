// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  comingUp,
  groupApplications,
  groupForStatus,
  defaultChecklist,
  checklistFor,
  appLastAt,
  coopEvents,
} from "../../extension/src/panel/model/coop.js";

const NOW = new Date("2026-10-05T16:00:00.000Z");

const app = (id, status, hist = [], over = {}) => ({
  id,
  status,
  employer: `Co ${id}`,
  jobTitle: "Developer",
  history: hist,
  ...over,
});

test("every contract status maps into a chip group; unknown -> applied", () => {
  const expect = {
    applied: "applied",
    unknown: "applied",
    "selected-for-interview": "interviewing",
    "interview-scheduled": "interviewing",
    alternate: "interviewing",
    offer: "offers",
    ranked: "offers",
    matched: "offers",
    "not-selected": "closed",
    withdrawn: "closed",
    declined: "closed",
  };
  for (const [status, group] of Object.entries(expect)) {
    assert.equal(groupForStatus(status), group, status);
  }
  assert.equal(groupForStatus("something-new"), "applied");
});

test("groupApplications buckets and sorts each group by the last change", () => {
  const applications = {
    a: app("a", "applied", [{ status: "applied", at: "2026-10-01T12:00:00Z" }]),
    b: app("b", "interview-scheduled", [
      { status: "applied", at: "2026-09-20T12:00:00Z" },
      { status: "interview-scheduled", at: "2026-10-04T12:00:00Z" },
    ]),
    c: app("c", "matched", [{ status: "matched", at: "2026-10-03T12:00:00Z" }]),
    d: app("d", "applied", [{ status: "applied", at: "2026-10-05T12:00:00Z" }]),
  };
  const groups = groupApplications(applications);
  assert.deepEqual(
    groups.map((g) => [g.key, g.apps.length]),
    [
      ["all", 4],
      ["applied", 2],
      ["interviewing", 1],
      ["offers", 1],
      ["closed", 0],
    ]
  );
  assert.deepEqual(
    groups.find((g) => g.key === "applied").apps.map((a) => a.id),
    ["d", "a"]
  );
  assert.deepEqual(
    groups.find((g) => g.key === "all").apps.map((a) => a.id),
    ["d", "b", "c", "a"]
  );
});

test("comingUp keeps co-op items in the next 14 days plus still-open overdue", () => {
  const items = {
    soon: {
      id: "soon",
      type: "interview",
      title: "soon",
      status: "open",
      source: "waterlooworks",
      startAt: "2026-10-10T15:00:00Z",
    },
    far: {
      id: "far",
      type: "interview",
      title: "far",
      status: "open",
      source: "waterlooworks",
      startAt: "2026-11-30T15:00:00Z",
    },
    overdue: {
      id: "overdue",
      type: "offer-deadline",
      title: "overdue",
      status: "open",
      source: "waterlooworks",
      dueAt: "2026-10-01T15:00:00Z",
    },
    done: {
      id: "done",
      type: "interview",
      title: "done",
      status: "done",
      source: "waterlooworks",
      startAt: "2026-10-06T15:00:00Z",
    },
    class: {
      id: "class",
      type: "class",
      title: "class",
      status: "open",
      source: "learn",
      startAt: "2026-10-06T15:00:00Z",
    },
    pending: {
      id: "pending",
      type: "interview",
      title: "pending",
      status: "open",
      review: "pending",
      source: "waterlooworks",
      startAt: "2026-10-06T15:00:00Z",
    },
    slot: {
      id: "slot",
      type: "deadline",
      category: "interview-timeslot",
      title: "slot",
      status: "open",
      source: "waterlooworks",
      dueAt: "2026-10-07T15:00:00Z",
    },
  };
  const ids = comingUp(items, {}, NOW, 14).map((i) => i.id);
  // Done items still surface (they render dimmed); cancelled/pending don't.
  assert.deepEqual(ids, ["overdue", "done", "slot", "soon"]);
  // Pending items show when the review.showPending flag allows them.
  const withPending = comingUp(items, {}, NOW, 14, { acceptPending: true }).map(
    (i) => i.id
  );
  assert.ok(withPending.includes("pending"));
});

test("default prep checklist adds the camera/mic step for video interviews", () => {
  const inPerson = {
    id: "x",
    type: "interview",
    meta: { prep: { format: "In person", location: "TC 1208" } },
  };
  const video = {
    id: "y",
    type: "interview",
    meta: { prep: { format: "Video call", location: "Zoom link in WW" } },
  };
  assert.equal(defaultChecklist(inPerson).length, 3);
  const steps = defaultChecklist(video);
  assert.equal(steps.length, 4);
  assert.equal(steps[3], "Test camera and mic");
});

test("checklistFor prefers saved subtasks and normalises string lists", () => {
  const item = { id: "x", type: "interview", meta: { prep: {} } };
  assert.deepEqual(checklistFor(item, { subtasks: ["a", "b"] }), [
    { text: "a", done: false },
    { text: "b", done: false },
  ]);
  assert.deepEqual(checklistFor(item, { subtasks: [{ text: "x", done: true }] }), [
    { text: "x", done: true },
  ]);
  assert.equal(checklistFor(item, {}).length, 3);
});

test("coopEvents splits pending vs registered, hides dismissed/cancelled/past", () => {
  const ev = (id, over = {}) => ({
    id,
    type: "event",
    title: `Event ${id}`,
    status: "open",
    review: "pending",
    source: "waterlooworks",
    startAt: "2026-10-06T15:00:00Z",
    meta: {},
    ...over,
  });
  const items = {
    pending: ev("pending"),
    registeredBadge: ev("registeredBadge", {
      review: "auto",
      meta: { registered: true },
      startAt: "2026-10-07T15:00:00Z",
    }),
    waitlisted: ev("waitlisted", {
      meta: { registered: false, waitlisted: true },
      startAt: "2026-10-08T15:00:00Z",
    }),
    cancelled: ev("cancelled", { status: "cancelled" }),
    past: ev("past", { startAt: "2026-10-01T15:00:00Z" }),
    otherSource: { ...ev("otherSource"), source: "gcal" },
    notEvent: { ...ev("notEvent"), type: "interview" },
  };
  const userState = {
    accepted: { review: "accepted" },
    dismissed: { review: "dismissed" },
  };
  items.accepted = ev("accepted", { startAt: "2026-10-09T15:00:00Z" });
  items.dismissed = ev("dismissed");

  const { pending, registered } = coopEvents(items, userState, NOW);
  assert.deepEqual(
    pending.map((i) => i.id),
    ["pending", "waitlisted"],
    "pending + waitlisted stay actionable"
  );
  assert.deepEqual(
    registered.map((i) => i.id),
    ["registeredBadge", "accepted"],
    "registered badge + user-accepted sort by start"
  );
});

test("appLastAt reads the last history entry", () => {
  assert.ok(
    Number.isNaN(appLastAt(app("a", "applied")))
  );
  assert.equal(
    appLastAt(app("a", "applied", [{ at: "2026-10-02T00:00:00Z" }])),
    Date.parse("2026-10-02T00:00:00Z")
  );
});
