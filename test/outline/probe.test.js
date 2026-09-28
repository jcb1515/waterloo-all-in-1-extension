// @ts-check
// Outline reader probe: page detection, selector counts, ok flags, hints
// and the privacy rule (counts only — never text).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { probe, CHECKLIST } from "../../extension/src/sources/outline/probe.js";
import { parseOutline } from "../../extension/src/sources/outline/parsers.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "outline");
const html = (name) => fs.readFileSync(path.join(DIR, `${name}.html`), "utf8");
const VIEW = "https://outline.uwaterloo.ca/viewer/view/";

test("probe: outline fixtures are ok outlines whose counts match parseOutline", () => {
  for (const name of ["MATH117", "ECE190", "GENE119"]) {
    const { document } = parseHTML(html(name));
    const r = probe(document, VIEW + name.toLowerCase());
    assert.equal(r.page, "outline", name);
    assert.equal(r.ok, true, name);
    assert.equal(r.counts.title, 1, name);

    const data = parseOutline(document);
    assert.equal(r.counts.scheduleRows, data.schedule.length, name);
    const assessRows =
      data.schemes.reduce((n, s) => n + s.rows.length, 0) +
      data.tables
        .filter((t) => t.section === "assessments")
        .reduce((n, t) => n + t.rows.length, 0);
    assert.equal(r.counts.assessmentRows, assessRows, name);
    const assessTables =
      data.schemes.length + data.tables.filter((t) => t.section === "assessments").length;
    assert.equal(r.counts.assessmentTables, assessTables, name);
    assert.equal(
      r.counts.planTables,
      data.tables.filter((t) => t.section === "plan").length,
      name,
    );
  }
  const { document } = parseHTML(html("MATH117"));
  assert.ok(probe(document, VIEW + "math117").counts.instructorCells > 0);
});

test("probe: an SSO shell is a login page", () => {
  const { document } = parseHTML("<html><body>Sign in with your WatIAM</body></html>");
  const r = probe(document, "https://idp.uwaterloo.ca/x");
  assert.equal(r.page, "login");
  assert.equal(r.ok, false);
  assert.ok(r.hints.some((h) => /sign[- ]?in/i.test(h)));
});

test("probe: empty doc and garbage fail soft with hints", () => {
  const { document: empty } = parseHTML("<html><body></body></html>");
  const r = probe(empty, VIEW + "nope");
  assert.equal(r.ok, false);
  assert.ok(r.hints.length > 0);

  const g = probe(null, "not a url");
  assert.equal(g.page, "unknown");
  assert.equal(g.ok, false);
  assert.deepEqual(g.counts, {});
});

test("probe: results are counts only — no text, names or addresses", () => {
  for (const name of ["MATH117", "ECE190", "GENE119"]) {
    const r = probe(parseHTML(html(name)).document, VIEW + name.toLowerCase());
    for (const [k, v] of Object.entries(r.counts)) {
      assert.equal(typeof v, "number", `${name}.${k}`);
    }
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes("@"), name);
    assert.ok(!blob.includes("Calculus"), name); // a real title string
    assert.ok(!blob.includes("MATH"), name);
  }
});

test("probe CHECKLIST: unique ids, filled fields, known pages", () => {
  const ids = new Set();
  const pages = new Set(["outline", "login", "outline-other", "unknown"]);
  let essential = 0;
  for (const c of CHECKLIST) {
    assert.ok(!ids.has(c.id), c.id);
    ids.add(c.id);
    assert.ok(c.label.length > 0, c.id);
    assert.ok(c.how.length > 0, c.id);
    assert.ok(pages.has(c.page), c.id);
    if (c.url) {
      const u = new URL(c.url);
      assert.equal(u.protocol, "https:", c.id);
      assert.equal(u.hostname, "outline.uwaterloo.ca", c.id);
    }
    if (c.essential) essential++;
    if (c.refreshDays !== undefined) {
      assert.ok(Number.isInteger(c.refreshDays) && c.refreshDays > 0, c.id);
    }
  }
  assert.ok(essential <= 3, `essential count ${essential}`);
});
