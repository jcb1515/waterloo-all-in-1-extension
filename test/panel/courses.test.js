// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  courseCards,
  courseItems,
  gradeSummary,
  weekTopics,
} from "../../extension/src/panel/model/courses.js";
import { zonedIso } from "../../extension/src/lib/textdates/index.js";

const NOW = new Date("2026-10-05T16:00:00.000Z"); // Monday, Toronto

const course = (over = {}) => ({
  code: "MATH 117",
  name: "Calculus 1",
  sections: ["LEC 002", "TUT 101"],
  group: "B",
  learnOrgUnitId: "12345",
  weights: [
    { component: "Assignments", weight: 30 },
    { component: "Midterm", weight: 30 },
    { component: "Final", weight: 40 },
  ],
  grades: [],
  ...over,
});

test("gradeSummary matches Learn grades to components by name", () => {
  const c = course({
    grades: [
      { component: "Assignments", points: 24, max: 30 },
      { component: "Midterm", display: "80%" },
      { component: "Participation", display: "100%" }, // no matching component
    ],
  });
  const s = gradeSummary(c, { target: 80 });
  assert.equal(s.gradedWeight, 60);
  assert.equal(s.remainingWeight, 40);
  // current = (80 + 80) / 60 graded? assignments 24/30=80, midterm 80 -> 80
  assert.equal(Math.round(s.current * 10) / 10, 80);
  const matched = Object.fromEntries(
    s.components.map((x) => [x.component, x.pct])
  );
  assert.equal(matched.Assignments, 80);
  assert.equal(matched.Midterm, 80);
  assert.equal(matched.Final, null);
});

test("gradeSummary computes the average needed on the remaining work", () => {
  const c = course({
    grades: [{ component: "Assignments", points: 30, max: 30 }], // 100 on 30%
  });
  const s = gradeSummary(c, { target: 80 });
  // earned = 30; need (80 - 30) / 70 = 71.4
  assert.equal(Math.round(s.needed * 10) / 10, 71.4);
  assert.equal(s.secured, false);
  assert.equal(s.notReachable, false);
});

test("gradeSummary flags secured and not-reachable targets", () => {
  const strong = course({
    grades: [
      { component: "Assignments", points: 30, max: 30 },
      { component: "Midterm", display: "100%" },
    ],
  });
  const secured = gradeSummary(strong, { target: 50 });
  // earned 60 of 100 total; need (50-60)/40 < 0 -> secured
  assert.equal(secured.secured, true);

  const weak = course({
    grades: [{ component: "Assignments", points: 3, max: 30 }],
  });
  const nr = gradeSummary(weak, { target: 95 });
  // earned 3; need (95-3)/70 = 131 -> not reachable
  assert.equal(nr.notReachable, true);
  assert.ok(nr.needed > 100);
});

test("gradeSummary uses a selected scheme's rows instead of course.weights", () => {
  const c = course({
    gradingSchemes: [
      { name: "Default", rows: [{ component: "Final", weight: 100 }] },
      {
        name: "No final",
        rows: [
          { component: "Assignments", weight: 50 },
          { component: "Midterm", weight: 50 },
        ],
      },
    ],
    grades: [{ component: "Assignments", points: 20, max: 25 }],
  });
  const scheme = c.gradingSchemes[1];
  const s = gradeSummary(c, { scheme, target: 80 });
  assert.equal(s.totalWeight, 100);
  assert.equal(s.gradedWeight, 50);
  assert.equal(s.components.length, 2);
});

test("gradeSummary tolerates missing weights and empty grades", () => {
  const c = course({
    weights: [{ component: "Assignments", weight: null }, { component: "Final", weight: 60 }],
    grades: [],
  });
  const s = gradeSummary(c);
  assert.equal(s.current, null);
  assert.equal(s.totalWeight, 60);
  assert.equal(s.components.length, 2);
  assert.equal(s.components[0].weight, null);
});

test("courseCards picks next class, next deliverable and build links", () => {
  const courses = { "MATH 117": course() };
  const items = {
    lec: {
      id: "lec",
      type: "class",
      org: "MATH 117",
      title: "LEC",
      status: "open",
      source: "learn",
      startAt: zonedIso(2026, 10, 6, 10, 0),
      location: "MC 4041",
    },
    quiz: {
      id: "quiz",
      type: "quiz",
      org: "MATH117", // unnormalised code still groups under MATH 117
      title: "Quiz 4",
      status: "open",
      source: "learn",
      dueAt: zonedIso(2026, 10, 8, 23, 59),
    },
  };
  const [card] = courseCards(courses, items, {}, NOW);
  assert.equal(card.code, "MATH 117");
  assert.equal(card.learnUrl, "https://learn.uwaterloo.ca/d2l/home/12345");
  assert.equal(card.nextClass.id, "lec");
  assert.equal(card.nextDue.id, "quiz");
  assert.equal(card.upcomingCount, 2);
});

test("weekTopics collects this week's class details only", () => {
  const list = [
    {
      id: "a",
      type: "class",
      org: "MATH 117",
      status: "open",
      startAt: zonedIso(2026, 10, 6, 10, 0),
      details: "Integration by parts",
    },
    {
      id: "b",
      type: "class",
      org: "MATH 117",
      status: "open",
      startAt: zonedIso(2026, 10, 20, 10, 0),
      details: "Next week's topic",
    },
    {
      id: "c",
      type: "deadline",
      org: "MATH 117",
      status: "open",
      dueAt: zonedIso(2026, 10, 7, 23, 59),
      details: "not a class topic",
    },
  ];
  assert.deepEqual(weekTopics(list, NOW), ["Integration by parts"]);
});

test("courseItems normalises org codes and drops hidden/cancelled items", () => {
  const items = {
    a: {
      id: "a",
      type: "deadline",
      org: "math117",
      title: "a",
      status: "open",
      dueAt: zonedIso(2026, 10, 9, 23, 59),
    },
    b: {
      id: "b",
      type: "deadline",
      org: "MATH 117",
      title: "b",
      status: "cancelled",
      dueAt: zonedIso(2026, 10, 9, 23, 59),
    },
    c: {
      id: "c",
      type: "deadline",
      org: "MATH 117",
      title: "c",
      status: "open",
      dueAt: zonedIso(2026, 10, 10, 23, 59),
    },
  };
  const us = { c: { hidden: true } };
  assert.deepEqual(
    courseItems(items, us, "MATH 117", NOW).map((i) => i.id),
    ["a"]
  );
});
