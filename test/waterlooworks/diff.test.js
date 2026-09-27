// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { diffApplications } from "../../extension/src/sources/waterlooworks/diff.js";

/** @typedef {import("../../extension/src/core/contract.js").Application} Application */

const T1 = new Date("2026-09-10T12:00:00Z");
const T2 = new Date("2026-09-12T12:00:00Z");

/**
 * @param {string} id
 * @param {string} status
 * @param {Partial<Application>} [over]
 * @returns {Application}
 */
const app = (id, status, over = {}) => ({
  id: `waterlooworks:${id}`,
  employer: "Contoso",
  jobTitle: "Software Intern",
  status: /** @type {Application["status"]} */ (status),
  history: [],
  itemIds: [],
  ...over
});

test("the first ever read seeds history but emits no updates", () => {
  const next = [app("1", "applied"), app("2", "selected-for-interview", { employer: "Initech" })];
  for (const prev of [undefined, /** @type {Application[]} */ ([])]) {
    const { applications, updates } = diffApplications(prev, next, T1);
    assert.equal(updates.length, 0);
    assert.equal(applications.length, 2);
    assert.deepEqual(applications[0].history, [{ status: "applied", at: T1.toISOString() }]);
    assert.deepEqual(applications[1].history, [
      { status: "selected-for-interview", at: T1.toISOString() }
    ]);
  }
});

test("a new application on a later read emits a 'new' update", () => {
  const { applications: prev } = diffApplications([], [app("1", "applied")], T1);
  const { applications, updates } = diffApplications(prev, [...prev, app("2", "applied", { employer: "Initech" })], T2);
  assert.equal(applications.length, 2);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].kind, "new");
  assert.equal(updates[0].source, "waterlooworks");
  assert.equal(updates[0].text, "Applied: Initech · Software Intern");
  assert.equal(updates[0].refId, "waterlooworks:2");
  assert.equal(updates[0].at, T2.toISOString());
  assert.match(updates[0].id, /^waterlooworks:2:applied:2026-09-12T12:00:00\.000Z$/);
});

test("a status change appends history and emits a 'status' update", () => {
  const { applications: prev } = diffApplications([], [app("1", "applied")], T1);
  const { applications, updates } = diffApplications(
    prev,
    [app("1", "interview-scheduled", { employer: "Contoso" })],
    T2
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0].kind, "status");
  assert.equal(updates[0].text, "Interview booked: Contoso · Software Intern");
  assert.deepEqual(applications[0].history, [
    { status: "applied", at: T1.toISOString() },
    { status: "interview-scheduled", at: T2.toISOString() }
  ]);
});

test("an unknown next status keeps the stored status and history", () => {
  const { applications: prev } = diffApplications([], [app("1", "matched")], T1);
  const { applications, updates } = diffApplications(prev, [app("1", "unknown")], T2);
  assert.equal(updates.length, 0);
  assert.equal(applications[0].status, "matched");
  assert.deepEqual(applications[0].history, [{ status: "matched", at: T1.toISOString() }]);
});

test("an app absent from the next read is carried over unchanged", () => {
  const { applications: prev } = diffApplications(
    [],
    [app("1", "applied"), app("2", "offer", { employer: "Initech" })],
    T1
  );
  const { applications, updates } = diffApplications(prev, [app("1", "applied")], T2);
  assert.equal(updates.length, 0);
  assert.deepEqual(applications.map((a) => a.id), ["waterlooworks:1", "waterlooworks:2"]);
  assert.equal(applications[1].status, "offer"); // untouched prev record
});

test("itemIds merge across reads without duplicates", () => {
  const { applications: prev } = diffApplications(
    [],
    [app("1", "applied", { itemIds: ["waterlooworks:i1"] })],
    T1
  );
  const { applications } = diffApplications(
    prev,
    [app("1", "applied", { itemIds: ["waterlooworks:i1", "waterlooworks:i2"] })],
    T2
  );
  assert.deepEqual(applications[0].itemIds, ["waterlooworks:i1", "waterlooworks:i2"]);
});

test("a first-seen app with an unknown status gets empty history and no update", () => {
  const { applications: prev } = diffApplications([], [app("1", "applied")], T1);
  const { applications, updates } = diffApplications(prev, [...prev, app("2", "unknown")], T2);
  const found = applications.find((a) => a.id === "waterlooworks:2");
  assert.deepEqual(found?.history, []);
  assert.equal(updates.length, 0);
});

test("recovering from unknown to a known status emits a status update", () => {
  const { applications: s1 } = diffApplications([], [app("1", "unknown")], T1);
  const { applications, updates } = diffApplications(s1, [app("1", "ranked")], T2);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].kind, "status");
  assert.equal(updates[0].text, "Ranked: Contoso · Software Intern");
  assert.deepEqual(applications[0].history, [{ status: "ranked", at: T2.toISOString() }]);
});
