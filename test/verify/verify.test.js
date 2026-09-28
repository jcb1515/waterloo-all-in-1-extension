// @ts-check
// tools/verify.mjs: CLI smoke test, the duplicate detector, the
// invalid-date checker, and the injected-driver failure path.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runVerify,
  findSuspectedDuplicates,
  orgsCompatible,
  findInvalidDates,
  DEFAULT_NOW,
} from "../../tools/verify.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("verify --check exits 0 with a parseable summary covering every source", () => {
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, "tools", "verify.mjs"), "--check"],
    { cwd: ROOT, encoding: "utf8", timeout: 120000 },
  );
  assert.equal(r.status, 0, `verify --check failed:\n${r.stdout}\n${r.stderr}`);
  const line = r.stdout.trim().split("\n").filter(Boolean).pop();
  const summary = JSON.parse(String(line));
  for (const src of ["learn", "outline", "portal", "email", "waterlooworks", "discord"]) {
    assert.ok(
      summary.sources[src] && summary.sources[src].fixtures >= 1,
      `${src}: expected >= 1 fixture, got ${JSON.stringify(summary.sources[src])}`,
    );
  }
  assert.equal(summary.duplicates, 0);
  assert.equal(summary.invalidDates, 0);
  assert.equal(summary.throws, 0);
});

test("orgsCompatible: equal codes, empty side, containment, course-code clash", () => {
  assert.equal(orgsCompatible("MATH 117", "math117"), true);
  assert.equal(orgsCompatible("MATH 117", ""), true);
  assert.equal(orgsCompatible("MATH", "MATH 117"), true);
  assert.equal(orgsCompatible("MATH 117", "ECE 105"), false);
});

test("duplicate detector: same-time compatible orgs flag, course clash doesn't", () => {
  const ev = (over) => ({
    id: "x",
    type: "exam",
    title: "Midterm Exam",
    org: "MATH 117",
    startAt: "2026-10-06T23:00:00.000Z",
    ...over,
  });
  // Same time, same course code written two ways.
  assert.equal(
    findSuspectedDuplicates([ev({ id: "a" }), ev({ id: "b", org: "MATH117" })]).length,
    1,
  );
  // Same time, same title, two different course codes: a clash, not a dupe.
  assert.equal(
    findSuspectedDuplicates([ev({ id: "a" }), ev({ id: "b", org: "ECE 105" })]).length,
    0,
  );
  // 6 minutes apart is outside the ±5 minute window.
  assert.equal(
    findSuspectedDuplicates([
      ev({ id: "a" }),
      ev({ id: "b", startAt: "2026-10-06T23:06:00.000Z" }),
    ]).length,
    0,
  );
});

test("invalid-date checker: unparseable, reversed range, too far out", () => {
  const bad = findInvalidDates(
    {
      a: { id: "a", dueAt: "not a date" },
      b: { id: "b", startAt: "2026-10-01T00:00:00Z", endAt: "2026-09-30T00:00:00Z" },
      c: { id: "c", dueAt: "2099-01-01T00:00:00Z" },
      d: { id: "d", dueAt: "2026-10-01T00:00:00Z" },
      e: { id: "e" },
    },
    DEFAULT_NOW,
  );
  assert.deepEqual(
    bad.map((x) => `${x.id}:${x.field}`).sort(),
    ["a:dueAt", "b:endAt", "c:dueAt"],
  );
});

test("an injected driver that throws counts as a failure, not a crash", async () => {
  const { summary, failures } = await runVerify({
    check: true,
    drivers: [
      {
        source: "fake",
        match: (p) => /applications\.html$/i.test(p),
        run: async () => {
          throw new Error("boom");
        },
      },
    ],
  });
  assert.equal(failures.throws, 1);
  assert.equal(summary.throws, 1);
});
