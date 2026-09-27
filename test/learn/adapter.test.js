// @ts-check

import test from "node:test";
import assert from "node:assert/strict";
import adapter from "../../extension/src/sources/learn/index.js";
import { learnRoutes, makeCtx, WHOAMI } from "../fixtures/learn/fixtures.js";

const byId = (result, id) => result.items.find((i) => i.id === id);

test("learn adapter: no worker session and no tab -> session no-tab", async () => {
  const { ctx } = makeCtx(learnRoutes(), { workerSignedOut: true, noTab: true });
  const result = await adapter.sync(ctx);
  assert.equal(result.complete, false);
  assert.equal(result.session, "no-tab");
  assert.deepEqual(result.items, []);
});

test("learn adapter: worker signed out, a signed-in tab relays the reads", async () => {
  const { ctx, calls } = makeCtx(learnRoutes(), { workerSignedOut: true });
  const result = await adapter.sync(ctx);
  assert.equal(result.session, "signed-in");
  assert.ok(calls.relay.some((p) => p.includes("/dropbox/folders/")), "relay asked for dropbox folders");
  assert.ok(byId(result, "learn:1001:dropbox:42"), "items came back via relay");
});

test("learn adapter: happy path", async () => {
  const { ctx } = makeCtx(learnRoutes());
  const result = await adapter.sync(ctx);

  // Dropbox folder with a DueDate and a submission.
  const a1 = byId(result, "learn:1001:dropbox:42");
  assert.ok(a1, "dropbox 42 item");
  assert.equal(a1.type, "deadline");
  assert.equal(a1.category, "assignment");
  assert.equal(a1.status, "submitted");
  assert.ok(a1.url && a1.url.includes("db=42"), "deep-link url");
  assert.equal(a1.confidence, "exact");
  assert.equal(a1.review, "auto");

  // The myItems feed row (db=42) merges into the same item.
  assert.equal(result.items.filter((i) => i.title === "Assignment 1").length, 1);
  const scopes = (a1.seenIn || []).map((s) => s.scope);
  assert.ok(scopes.includes("1001:dropbox"), "seenIn dropbox");
  assert.ok(scopes.includes("1001:feed"), "seenIn feed");

  // Folder with only Availability dates, in a Labs category.
  const lab = byId(result, "learn:1001:dropbox:43");
  assert.ok(lab, "lab folder");
  assert.equal(lab.category, "lab");
  assert.equal(lab.dueAt, "2026-10-09T03:59:00.000Z");
  assert.equal(lab.opensAt, "2026-09-28T04:00:00.000Z");

  // A quiz titled like a midterm classifies as exam/midterm.
  const quiz = byId(result, "learn:1001:quiz:55");
  assert.ok(quiz, "quiz item");
  assert.equal(quiz.type, "exam");
  assert.equal(quiz.category, "midterm");
  // Grade weight matched by name.
  assert.equal(quiz.weight, 25);

  // A discussion topic the student already posted in counts as submitted.
  const disc = byId(result, "learn:1001:discussion:77");
  assert.ok(disc, "discussion item");
  assert.equal(disc.status, "submitted");

  // A plain calendar event with a deadline-like title becomes a timed exam.
  const event = byId(result, "learn:1001:content:cal500");
  assert.ok(event, "calendar event item");
  assert.equal(event.type, "exam");
  assert.equal(event.startAt, "2026-10-27T20:30:00.000Z");
  assert.equal(event.endAt, "2026-10-27T22:20:00.000Z");
  assert.equal(event.dueAt, undefined);

  // The announcement with a moved midterm gives exactly one pending item.
  const newsItems = result.items.filter((i) => i.meta && i.meta.newsId);
  assert.equal(newsItems.length, 1);
  const news = newsItems[0];
  assert.equal(news.review, "pending");
  assert.equal(news.confidence, "tentative");
  assert.equal(news.type, "exam");
  assert.equal(news.startAt, "2026-10-29T20:30:00.000Z");
  assert.equal(news.endAt, "2026-10-29T22:20:00.000Z");
  assert.ok(news.evidence && news.evidence.snippet.includes("moved"));
  assert.ok(news.evidence.snippet.length <= 300);
  assert.equal(news.evidence.method, "text");

  // Courses: current-term courses only, with weights/outline/syllabus/grades.
  const ece = (result.courses || []).find((c) => c.code === "ECE 105");
  assert.ok(ece, "ECE 105 course");
  assert.equal(ece.term, 1269);
  assert.deepEqual(ece.weights, [
    { component: "Exams", weight: 40 },
    { component: "Assignments", weight: 60 },
  ]);
  assert.equal(ece.outlineUrl, "https://outline.uwaterloo.ca/viewer/view/abc123");
  assert.deepEqual(ece.syllabusUrls, [
    { title: "Syllabus", url: `https://learn.uwaterloo.ca/d2l/le/content/1001/Syllabus.pdf` },
  ]);
  assert.equal(ece.grades.length, 1);
  assert.equal(ece.grades[0].component, "Midterm Exam");
  assert.equal(ece.grades[0].weight, 25);
  assert.ok((result.courses || []).some((c) => c.code === "MATH 117"), "MATH 117 kept");
  assert.ok(!(result.courses || []).some((c) => c.code === "CHE 102"), "old-term course dropped");
  assert.ok(!(result.courses || []).some((c) => c.code === "LEARN 101"), "termless unit dropped");

  assert.equal(result.complete, true);
  for (const scope of ["1001:dropbox", "1001:news", "1001:grades", "1001:toc", "1002:dropbox"]) {
    assert.ok(result.readOk.includes(scope), `readOk has ${scope}`);
  }
  assert.equal(result.session, "signed-in");
  assert.ok(result.state && result.state.versions && result.state.versions.le, "state.versions set");
});

test("learn adapter: a failing quizzes route fails completeness, not the course", async () => {
  const routes = learnRoutes();
  routes.set("/d2l/api/le/V/1002/quizzes/", { status: 500, json: {} });
  const { ctx } = makeCtx(routes);
  const result = await adapter.sync(ctx);
  assert.equal(result.complete, false);
  assert.ok(result.readOk.includes("1002:dropbox"), "dropbox still read ok");
  assert.ok(!result.readOk.includes("1002:quizzes"), "quizzes not read ok");
  assert.ok(byId(result, "learn:1002:dropbox:44"), "MATH 117 item still returned");
  assert.ok(byId(result, "learn:1001:dropbox:42"), "ECE 105 items still returned");
});

test("learn adapter: quiz attempts are asked once per sync after a 403", async () => {
  const { ctx, calls } = makeCtx(learnRoutes());
  await adapter.sync(ctx);
  const attempts = calls.fetch.filter((k) => k.includes("/attempts/"));
  assert.equal(attempts.length, 1, `one attempts request, got ${JSON.stringify(attempts)}`);
});

test("learn adapter: the result never carries the student's name", async () => {
  const { ctx } = makeCtx(learnRoutes());
  const result = await adapter.sync(ctx);
  const json = JSON.stringify(result);
  assert.ok(!json.includes(WHOAMI.FirstName), "no FirstName");
  assert.ok(!json.includes(WHOAMI.LastName), "no LastName");
});
