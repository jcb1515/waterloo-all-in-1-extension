// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { redactText, normalizePath, shapeOf, htmlOutline, datePattern } from "../../extension/src/capture/redact.js";

test("redactText strips emails, 8+ digit numbers and extra words", () => {
  assert.equal(redactText("mail jsmith@uwaterloo.ca"), "mail <email>");
  assert.equal(redactText("student 20812345 due"), "student <number> due");
  assert.equal(redactText("posted by james smith", ["James Smith"]), "posted by <redacted>");
  // Extra words are case-insensitive; one-letter words are ignored.
  assert.equal(redactText("JAMES Smith", ["james"]), "<redacted> Smith");
  assert.equal(redactText("a b c", ["b"]), "a b c");
});

test("redactText strips markup and phone numbers, truncates long text", () => {
  assert.equal(redactText("<p>Hi <b>there</b></p>"), "Hi there");
  assert.equal(redactText("call 519-555-1234 now"), "call <phone> now");
  const long = "x".repeat(500);
  const out = redactText(long);
  assert.equal(out.length, 403);
  assert.ok(out.endsWith("..."));
});

test("normalizePath replaces numeric ids, snowflakes and UUIDs, drops query values", () => {
  assert.equal(
    normalizePath("https://discord.com/api/v9/channels/123456789012345678/messages?limit=50&before=999"),
    "discord.com/api/v9/channels/{id}/messages?before&limit"
  );
  assert.equal(
    normalizePath("https://portal.uwaterloo.ca/records/550e8400-e29b-41d4-a716-446655440000/view?x=1"),
    "portal.uwaterloo.ca/records/{id}/view?x"
  );
  assert.equal(normalizePath("https://learn.uwaterloo.ca/d2l/le/12345/home"), "learn.uwaterloo.ca/d2l/le/{id}/home");
  // Hash routes get the same treatment.
  assert.equal(
    normalizePath("https://discord.com/app#/channels/111111111111111111/222"),
    "discord.com/app#/channels/{id}/{id}"
  );
  // Ordinary path segments survive.
  assert.equal(normalizePath("https://a.b/calendar/week?view=month"), "a.b/calendar/week?view");
});

test("shapeOf redacts identity keys but keeps short status labels", () => {
  const shape = shapeOf({
    FirstName: "James",
    email: "j@x.ca",
    status: "Not Selected",
    applicationStatus: "Not Selected",
    nested: { username: "jdoe", name: "James" },
    course: { name: "ECE 105" },
    count: 7,
    active: true,
    missing: null,
  });
  assert.equal(shape.FirstName, "<redacted>");
  assert.equal(shape.email, "<redacted>");
  assert.equal(shape.status, "Not Selected");
  assert.equal(shape.applicationStatus, "Not Selected");
  // "name" is redacted next to a username, kept on a bare course object.
  assert.equal(shape.nested.username, "<redacted>");
  assert.equal(shape.nested.name, "<redacted>");
  assert.equal(shape.course.name, "<string 7>");
  assert.equal(shape.count, "<number>");
  assert.equal(shape.active, true);
  assert.equal(shape.missing, null);
});

test("shapeOf maps datetimes, ISO strings and plain strings", () => {
  const shape = shapeOf({
    when: "Oct 5, 2026 3:30 PM",
    iso: "2026-10-05T15:30:00Z",
    link: "https://discord.com/channels/123456789012345678/987654321",
    long: "word ".repeat(30).trim(),
  });
  assert.equal(shape.when, "Oct 9, 9999 9:99 PM");
  assert.equal(shape.iso, "<iso-datetime>");
  assert.equal(shape.link, "<url discord.com/channels/{id}/{id}>");
  assert.match(shape.long, /^<string \d+>$/);
});

test("shapeOf summarises arrays", () => {
  const shape = shapeOf({ items: [{ a: 1, b: "x" }, { a: 2 }, { a: 3 }, { a: 4 }] });
  assert.equal(shape.items["<array>"], 4);
  assert.equal(shape.items.items.a, "<number>");
  assert.equal(shape.items.items["b?"], "<string 1>");
});

test("datePattern keeps month names and AM/PM, masks digits", () => {
  assert.equal(datePattern("Oct 5, 2026 3:30 PM"), "Oct 9, 9999 9:99 PM");
  assert.equal(datePattern("Thursday, October 22"), "Thursday, October 99");
});

test("htmlOutline collects headers, headings, classes and counts", () => {
  const { document } = parseHTML(`<!doctype html><html><body>
    <nav><a href="/home">Home</a><a href="/jobs">Jobs for jane@x.ca</a></nav>
    <h1>Applications</h1><h2>Fall 2026</h2>
    <table><tr><th>Job</th><th>Status</th></tr><tr><td>x</td><td>y</td></tr></table>
    <form action="/apply/123"><input name="title"><input name="resume"></form>
    <iframe src="https://portal.uwaterloo.ca/embed/999"></iframe>
    <ul><li class="row a">x</li><li class="row a">y</li><li class="row b">z</li></ul>
    <time datetime="2026-10-05T15:30:00Z">Oct 5</time>
    <div data-testid="panel" data-track="click"></div>
  </body></html>`);
  const out = htmlOutline(document);
  assert.deepEqual(out.tables, [["Job", "Status"]]);
  assert.ok(out.headings.includes("h1: Applications"));
  assert.ok(out.headings.includes("h2: Fall 2026"));
  assert.deepEqual(out.forms[0], { action: "/apply/{id}", fields: ["title", "resume"] });
  assert.equal(out.iframes[0], "portal.uwaterloo.ca/embed/{id}");
  assert.ok(out.nav.includes("Jobs for <email>"));
  assert.equal(out.classes[0], "row"); // most frequent first
  assert.ok(out.classes.includes("a") && out.classes.includes("b"));
  assert.ok(out.dataAttrs.includes("data-testid") && out.dataAttrs.includes("data-track"));
  assert.deepEqual(out.timeSamples, ["9999-99-99T99:99:99Z"]);
  assert.equal(out.counts.table, 1);
  assert.equal(out.counts.tr, 2);
  assert.equal(out.counts.li, 3);
  assert.equal(out.counts.form, 1);
});
