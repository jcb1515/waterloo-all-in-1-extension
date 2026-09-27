// @ts-check

import test from "node:test";
import assert from "node:assert/strict";
import { classify, TRIGGER_RE } from "../../extension/src/sources/learn/classify.js";

test("classify: final exam titles", () => {
  assert.deepEqual(classify({ title: "Final Exam" }), { type: "exam", category: "final" });
  assert.deepEqual(classify({ title: "MATH 117 Final Examination" }), { type: "exam", category: "final" });
  // Title beats the Learn kind: a quiz tool entry that is really the final.
  assert.deepEqual(classify({ title: "Final Exam", kind: "quiz" }), { type: "exam", category: "final" });
});

test("classify: midterm titles", () => {
  assert.deepEqual(classify({ title: "Midterm Exam" }), { type: "exam", category: "midterm" });
  assert.deepEqual(classify({ title: "Mid-term quiz" }), { type: "exam", category: "midterm" });
  assert.deepEqual(classify({ title: "Term Test 2" }), { type: "exam", category: "midterm" });
});

test("classify: presentation titles", () => {
  assert.deepEqual(classify({ title: "Project Pitch" }), { type: "presentation", category: "presentation" });
  assert.deepEqual(classify({ title: "Group presentation" }), { type: "presentation", category: "presentation" });
  assert.deepEqual(classify({ title: "Capstone demo day" }), { type: "presentation", category: "presentation" });
  assert.deepEqual(classify({ title: "Design showcase" }), { type: "presentation", category: "presentation" });
});

test("classify: quiz kind", () => {
  assert.deepEqual(classify({ title: "Quiz 3", kind: "quiz" }), { type: "quiz", category: "quiz" });
});

test("classify: the default keeps the WATnow category", () => {
  assert.deepEqual(classify({ title: "Lab 2 Report", kind: "dropbox", category: "lab" }), {
    type: "deadline",
    category: "lab",
  });
  assert.deepEqual(classify({ title: "Assignment 1", kind: "dropbox", category: "assignment" }), {
    type: "deadline",
    category: "assignment",
  });
  assert.deepEqual(classify({ title: "Week 3 discussion", kind: "discussion", category: "discussion" }), {
    type: "deadline",
    category: "discussion",
  });
});

test("TRIGGER_RE: date-worthy announcement words", () => {
  for (const s of [
    "Assignment 3 due Oct 5",
    "deadline is Friday",
    "Midterm moved to Thursday, October 29, 4:30 - 6:20 pm in STC 1012.",
    "The midterm is rescheduled",
    "Quiz postponed",
    "Exam room changed",
    "deadline extended",
    "submission cancelled",
    "Lab 2 extension granted",
  ]) {
    assert.ok(TRIGGER_RE.test(s), s);
  }
});

test("TRIGGER_RE: a plain closure note has no trigger", () => {
  assert.ok(!TRIGGER_RE.test("The library is closed Oct 12."));
  assert.ok(!TRIGGER_RE.test("Office hours are Tuesday afternoons."));
});
