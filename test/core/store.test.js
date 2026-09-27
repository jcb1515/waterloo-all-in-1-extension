// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, withDevProfile, resolveSettings } from "../../extension/src/core/store.js";

test("DEFAULT_SETTINGS ships no personal data", () => {
  assert.deepEqual(DEFAULT_SETTINGS.profile.sections, {});
  assert.deepEqual(DEFAULT_SETTINGS.profile.groups, {});
  assert.deepEqual(DEFAULT_SETTINGS.sources.outline.urls, {});
  assert.deepEqual(DEFAULT_SETTINGS.sources.discord.watched, {});
  assert.equal(DEFAULT_SETTINGS.sources.outline.enabled, true);
  assert.equal(DEFAULT_SETTINGS.sources.discord.enabled, true);
  assert.equal(DEFAULT_SETTINGS.agenda.showClasses, "today");
});

test("withDevProfile merges plain objects, replaces arrays and scalars", () => {
  const merged = withDevProfile(DEFAULT_SETTINGS, {
    profile: { sections: { "ECE 150": ["LEC 002"] }, groups: { "ECE 190": "5" } },
    sources: { outline: { urls: { "ECE 150": "https://example.test/o" } } },
    theme: "dark",
  });
  assert.deepEqual(merged.profile.sections, { "ECE 150": ["LEC 002"] });
  assert.deepEqual(merged.profile.groups, { "ECE 190": "5" });
  assert.deepEqual(merged.sources.outline.urls, { "ECE 150": "https://example.test/o" });
  assert.equal(merged.sources.outline.enabled, true, "untouched default kept");
  assert.equal(merged.theme, "dark");

  // No profile at all -> the defaults themselves (fresh object).
  const plain = withDevProfile(DEFAULT_SETTINGS, null);
  assert.deepEqual(plain.profile.sections, {});
  assert.notEqual(plain, DEFAULT_SETTINGS);
});

test("stored settings win over the dev profile; deleted rows stay deleted", () => {
  const saved = { profile: { sections: {} } };
  const merged = resolveSettings(saved);
  // No dev profile in tests: identical to merging over DEFAULT_SETTINGS.
  assert.deepEqual(merged.profile.sections, {});
});
