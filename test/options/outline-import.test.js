// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { sanitizeOutlineHtml } from "../../extension/src/options/outline-import.js";

const html = (body) => parseHTML(`<html><body>${body}</body></html>`).window.document;

test("sanitizeOutlineHtml strips script/style/noscript/iframe/link/svg", () => {
  const doc = html(`
    <h1>ECE 105</h1>
    <script>alert(1)</script>
    <style>body{color:red}</style>
    <noscript>no js</noscript>
    <iframe src="https://evil.example"></iframe>
    <link rel="stylesheet" href="x.css">
    <svg><circle r="4"/></svg>
    <table class="assessments"><tr><td>Midterm</td><td>Oct 20</td></tr></table>
  `);
  const out = sanitizeOutlineHtml(doc);
  assert.ok(!/<script/i.test(out));
  assert.ok(!/<style/i.test(out));
  assert.ok(!/<noscript/i.test(out));
  assert.ok(!/<iframe/i.test(out));
  assert.ok(!/<link/i.test(out));
  assert.ok(!/<svg/i.test(out));
  assert.ok(out.includes("ECE 105"));
  assert.ok(out.includes("Midterm"));
});

test("sanitizeOutlineHtml removes inline on* handlers", () => {
  const doc = html(`<a href="https://x" onclick="steal()" onmouseover="x()">link</a><button ONCLICK="y()">b</button>`);
  const out = sanitizeOutlineHtml(doc);
  assert.ok(!/onclick/i.test(out));
  assert.ok(!/onmouseover/i.test(out));
  assert.ok(out.includes("link"));
});

test("sanitizeOutlineHtml keeps the document shell", () => {
  const doc = html(`<p>outline</p>`);
  const out = sanitizeOutlineHtml(doc);
  assert.ok(/^<html[\s>]/i.test(out), "serializes from documentElement");
  assert.ok(out.includes("outline"));
});
