// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { orgColorIndex, orgStyle, ORG_COLOR_COUNT } from "../../extension/src/ui/colors.js";

test("orgColorIndex is stable, pure and in range", () => {
  for (const org of ["ECE 105", "MATH 117", "WATonomous", "Acme Analog", "ENGL 192"]) {
    const i = orgColorIndex(org);
    assert.equal(orgColorIndex(org), i, "deterministic");
    assert.ok(Number.isInteger(i) && i >= 0 && i < ORG_COLOR_COUNT, `in range for ${org}`);
  }
});

test("orgColorIndex normalises course codes before hashing", () => {
  assert.equal(orgColorIndex("ece105"), orgColorIndex("ECE 105"));
  assert.equal(orgColorIndex("ECE105"), orgColorIndex("ECE 105"));
});

test("orgColorIndex spreads across the palette", () => {
  const seen = new Set(
    ["ECE 105", "ECE 150", "ECE 190", "MATH 117", "MATH 115", "ENGL 192", "GENE 119", "WATonomous"].map(
      orgColorIndex
    )
  );
  assert.ok(seen.size >= 4, `only ${seen.size} distinct buckets`);
});

test("orgStyle exposes the three custom properties", () => {
  const s = orgStyle("ECE 105");
  assert.equal(s["--org"], `var(--org-${orgColorIndex("ECE 105")})`);
  assert.match(s["--org-soft"], /^var\(--org-\d-soft\)$/);
  assert.match(s["--org-ink"], /^var\(--org-\d-ink\)$/);
  assert.equal(orgStyle(""), undefined);
});
