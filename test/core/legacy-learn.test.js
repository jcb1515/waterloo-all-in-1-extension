// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import adapter, { toItem } from "../../extension/src/core/legacy-learn.js";

const NOW = "2025-09-15T16:00:00.000Z";

const courses = new Map([
  ["ou:1", { id: "ou:1", code: "ECE 105", name: "Classical Mechanics", orgUnitId: 12345 }],
]);

test("adapter shape", () => {
  assert.equal(adapter.id, "learn");
  assert.equal(adapter.label, "Learn");
  assert.deepEqual(adapter.origins, ["https://learn.uwaterloo.ca"]);
  assert.equal(adapter.intervalMinutes, 30);
  assert.equal(adapter.syncOnTabOpen, true);
  assert.equal(typeof adapter.sync, "function");
});

test("toItem maps a WATnow assignment to a contract Item", () => {
  const w = {
    id: "456:dropbox:7",
    courseId: "ou:1",
    kind: "dropbox",
    category: "assignment",
    title: "Lab Report 1",
    dueAt: "2025-09-20T03:59:00.000Z",
    opensAt: "2025-09-01T04:00:00.000Z",
    url: "https://learn.uwaterloo.ca/d2l/lms/dropbox/user/folder_submit_files.d2l?db=7",
    status: "submitted",
    seenIn: ["course:ou:1"],
  };
  const it = toItem(w, courses, NOW);
  assert.equal(it.id, "learn:456:dropbox:7");
  assert.equal(it.source, "learn");
  assert.equal(it.type, "deadline", "assignment maps to deadline");
  assert.equal(it.category, "assignment");
  assert.equal(it.title, "Lab Report 1");
  assert.equal(it.org, "ECE 105");
  assert.equal(it.dueAt, w.dueAt);
  assert.equal(it.opensAt, w.opensAt);
  assert.equal(it.url, w.url);
  assert.equal(it.status, "submitted");
  assert.equal(it.confidence, "exact");
  assert.equal(it.review, "auto");
  assert.deepEqual(it.seenIn, [{ source: "learn", key: "456:dropbox:7", scope: "course:ou:1", at: NOW }]);
  assert.deepEqual(it.evidence, { method: "api", url: w.url });
  assert.deepEqual(it.meta, { orgUnitId: 12345, kind: "dropbox" });
});

test("toItem maps lab and quiz categories to their types", () => {
  const base = { id: "x", courseId: "ou:1", title: "Quiz 1" };
  assert.equal(toItem({ ...base, category: "quiz" }, courses, NOW).type, "quiz");
  assert.equal(toItem({ ...base, category: "lab" }, courses, NOW).type, "lab");
  assert.equal(toItem({ ...base, category: "discussion" }, courses, NOW).type, "deadline");
  assert.equal(toItem({ ...base, category: "content" }, courses, NOW).type, "deadline");
});

test("toItem degrades gracefully without course or seenIn", () => {
  const it = toItem({ id: "x", courseId: "ou:missing", title: "T", category: "assignment" }, courses, NOW);
  assert.equal(it.org, undefined);
  assert.equal(it.seenIn[0].scope, "feed");
  assert.equal(it.status, "open");
});
