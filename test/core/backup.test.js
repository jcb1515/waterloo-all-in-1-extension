// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBackup,
  backupFileName,
  buildBackup,
  validateBackup,
  BACKUP_VERSION,
} from "../../extension/src/core/backup.js";

const NOW = new Date("2026-10-01T16:00:00.000Z");

test("buildBackup produces the v1 payload shape", () => {
  const b = buildBackup({
    settings: { general: { theme: "dark" }, reminders: {} },
    userState: { "manual:x": { notes: "hi" } },
    manualItems: [{ id: "manual:x", title: "Quiz" }],
    outlineFiles: [{ id: "f1", name: "syllabus.pdf" }],
    now: NOW,
  });
  assert.equal(b.version, 1);
  assert.equal(b.exportedAt, NOW.toISOString());
  assert.equal(b.settings.general.theme, "dark");
  assert.equal(Object.keys(b.userState).length, 1);
  assert.equal(b.manualItems.length, 1);
  assert.equal(b.outlineFiles.length, 1);
  // No feed secret, discovery or raw source data keys.
  for (const k of Object.keys(b)) {
    assert.ok(
      ["version", "exportedAt", "settings", "userState", "manualItems", "outlineFiles", "projects"].includes(k),
      `unexpected key ${k}`,
    );
  }
});

test("projects round-trip through build/validate/apply; old backups stay valid", () => {
  const b = buildBackup({
    projects: [{ id: "proj_a", name: "Hack", color: 2, status: "active", calendar: true }],
    now: NOW,
  });
  const res = validateBackup(b);
  assert.equal(res.ok, true);
  assert.equal(res.summary.projects, 1);
  const writes = applyBackup(b, {});
  assert.deepEqual(writes.projects, [{ id: "proj_a", name: "Hack", color: 2, status: "active", calendar: true }]);

  // A backup without the key validates and never emits a projects write.
  const old = { version: 1, settings: {}, userState: {}, manualItems: [] };
  assert.equal(validateBackup(old).ok, true);
  assert.equal(validateBackup(old).summary.projects, 0);
  assert.equal("projects" in applyBackup(old, {}), false);
  // Malformed projects are rejected.
  assert.equal(validateBackup({ version: 1, projects: {} }).ok, false);
});

test("buildBackup tolerates missing slices", () => {
  const b = buildBackup({ now: NOW });
  assert.deepEqual(b.settings, {});
  assert.deepEqual(b.userState, {});
  assert.deepEqual(b.manualItems, []);
  assert.deepEqual(b.outlineFiles, []);
});

test("backupFileName uses the YYYY-MM-DD date", () => {
  assert.equal(backupFileName(NOW), "waterloo-all-in-1-backup-2026-10-01.json");
});

test("validateBackup counts the summary", () => {
  const b = buildBackup({
    settings: { a: 1, b: 2 },
    userState: { x: {}, y: {}, z: {} },
    manualItems: [{ id: "m1" }],
    outlineFiles: [],
  });
  const res = validateBackup(b);
  assert.equal(res.ok, true);
  assert.deepEqual(res.summary, {
    settingsSections: 2,
    itemEdits: 3,
    manualItems: 1,
    outlineFiles: 0,
    projects: 0,
  });
});

test("validateBackup rejects malformed payloads", () => {
  assert.equal(validateBackup(null).ok, false);
  assert.equal(validateBackup("backup").ok, false);
  assert.equal(validateBackup({ version: 99 }).ok, false);
  assert.equal(validateBackup({ version: 1, settings: [] }).ok, false);
  assert.equal(validateBackup({ version: 1, manualItems: {} }).ok, false);
  assert.equal(validateBackup({ version: BACKUP_VERSION }).ok, true);
});

test("applyBackup replaces settings/manual/outline and merges userState", () => {
  const backup = buildBackup({
    settings: { general: { theme: "dark" } },
    userState: { a: { notes: "imported" }, b: { done: true } },
    manualItems: [{ id: "manual:m" }],
    outlineFiles: [{ id: "f" }],
  });
  const writes = applyBackup(backup, {
    userState: { a: { notes: "local" }, c: { hidden: true } },
  });
  assert.deepEqual(writes.settings, { general: { theme: "dark" } });
  assert.deepEqual(writes.userState, {
    a: { notes: "imported" }, // imported wins
    b: { done: true },
    c: { hidden: true }, // kept
  });
  assert.deepEqual(writes.manualItems, [{ id: "manual:m" }]);
  assert.deepEqual(writes.outlineFiles, [{ id: "f" }]);
});

test("applyBackup tolerates absent slices", () => {
  const writes = applyBackup({ version: 1 }, {});
  assert.deepEqual(writes.settings, {});
  assert.deepEqual(writes.userState, {});
  assert.deepEqual(writes.manualItems, []);
  assert.deepEqual(writes.outlineFiles, []);
});
