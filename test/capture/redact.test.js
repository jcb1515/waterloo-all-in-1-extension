// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { redactText, normalizePath, shapeOf, htmlOutline, datePattern } from "../../extension/src/capture/redact.js";

test("redactText strips emails, 8+ digit numbers and extra words", () => {
  assert.equal(redactText("mail jsmith@uwaterloo.ca"), "mail <email>");
  assert.equal(redactText("student 20812345 due"), "student <number> due");
  assert.equal(redactText("posted by jane smith", ["Jane Smith"]), "posted by <redacted>");
  // Extra words are case-insensitive; one-letter words are ignored.
  assert.equal(redactText("JANE Smith", ["jane"]), "<redacted> Smith");
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
    FirstName: "Jane",
    email: "j@x.ca",
    status: "Not Selected",
    applicationStatus: "Not Selected",
    nested: { username: "jdoe", name: "Jane" },
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
  assert.deepEqual(out.tables, [
    {
      headers: ["Job", "Status"],
      rows: 1,
      sample: [
        [
          { cls: "", text: "<text 1>" }, // "Job" is not a label column
          { cls: "", text: "y" },        // "Status" is
        ],
      ],
    },
  ]);
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

// The policy recorder.content.js applies on discord.com.
const DISCORD_POLICY = {
  textMode: "structural",
  excludeSelectors: ["aside", '[class*="members"]', '[data-list-id="chat-messages"]'],
};

test("htmlOutline structural mode leaks no usernames (Discord-like page)", () => {
  const { document } = parseHTML(`<!doctype html><html><body>
    <nav class="channel-nav"><a>general</a><a>ece-105-help</a></nav>
    <aside><ul><li class="member">Alice Wonder</li><li class="member">Bob User</li></ul></aside>
    <ol data-list-id="chat-messages">
      <li><h3>Alice Wonder</h3><div>hello world</div></li>
      <li><h3>Bob User</h3><div>see you Tuesday</div></li>
    </ol>
    <h3>3 Text Channels</h3>
    <table><tr><th>Member</th><th>Role</th></tr><tr><td>Alice Wonder</td><td>Admin</td></tr></table>
  </body></html>`);
  const out = htmlOutline(document, DISCORD_POLICY);
  const json = JSON.stringify(out);
  assert.ok(!json.includes("Alice"), `username leaked: ${json}`);
  assert.ok(!json.includes("Bob"), `username leaked: ${json}`);
  // Channel names inside a real <nav> are structural and survive.
  assert.ok(out.nav.includes("general"));
  assert.ok(out.nav.includes("ece-105-help"));
  // Headings outside excluded regions are tag + length only.
  assert.ok(out.headings.length > 0);
  assert.ok(out.headings.every((h) => /^h\d: <text \d+>$/.test(h)));
  assert.ok(out.headings.includes(`h3: <text ${"3 Text Channels".length}>`));
  // Table headers are kept; excluded tables are skipped entirely.
  assert.equal(out.tables.length, 1);
  assert.deepEqual(out.tables[0].headers, ["Member", "Role"]);
  assert.deepEqual(out.tables[0].sample, []);
  // Counts still cover everything, including excluded subtrees.
  assert.equal(out.counts.li, 4);
});

test("htmlOutline structural mode can suppress nav entirely (Discord DM list)", () => {
  const { document } = parseHTML(`<!doctype html><html><body>
    <nav><a>Alice Wonder</a><a>Bob User</a></nav>
    <h2>Direct Messages</h2>
  </body></html>`);
  const out = htmlOutline(document, { ...DISCORD_POLICY, navSelectors: "" });
  assert.deepEqual(out.nav, []);
  const json = JSON.stringify(out);
  assert.ok(!json.includes("Alice") && !json.includes("Bob"));
});

test("htmlOutline structural mode keeps aside out of nav", () => {
  const { document } = parseHTML(`<!doctype html><html><body>
    <aside><a>should not appear</a></aside>
    <div role="tree"><div role="treeitem">channel-one</div></div>
  </body></html>`);
  const out = htmlOutline(document, { textMode: "structural" });
  assert.deepEqual(out.nav, ["channel-one"]);
});

test("htmlOutline full mode samples table cells (WaterlooWorks-like)", () => {
  const { document } = parseHTML(`<!doctype html><html><body>
    <table>
      <tr><th>Job Title</th><th>Status</th><th>Applied On</th></tr>
      <tr><td class="cell job">Software Developer, Contoso Ltd</td><td class="cell">Not Selected</td><td class="cell">Oct 5, 2026</td></tr>
      <tr><td class="cell job">Data Analyst, Initech Corp</td><td class="cell">Selected</td><td class="cell">Sep 29, 2026</td></tr>
      <tr><td class="cell">QA Tester</td><td class="cell">Applied</td><td class="cell">Sep 20, 2026</td></tr>
    </table>
  </body></html>`);
  const out = htmlOutline(document, { textMode: "full" });
  assert.equal(out.tables.length, 1);
  const t = out.tables[0];
  assert.deepEqual(t.headers, ["Job Title", "Status", "Applied On"]);
  assert.equal(t.rows, 3);
  assert.equal(t.sample.length, 2); // only the first 2 body rows
  // Company names are lengths only; status values survive; dates are patterns.
  assert.deepEqual(t.sample[0][0], { cls: "cell", text: `<text ${"Software Developer, Contoso Ltd".length}>` });
  assert.deepEqual(t.sample[0][1], { cls: "cell", text: "Not Selected" });
  assert.deepEqual(t.sample[0][2], { cls: "cell", text: "Oct 9, 9999" });
  assert.equal(t.sample[1][1].text, "Selected");
  const json = JSON.stringify(out);
  assert.ok(!json.includes("Contoso") && !json.includes("Initech"));
});

test("htmlOutline aligns cells when a body row opens with a th", () => {
  // WaterlooWorks' grid puts the job title in a row <th>. Pairing only <td>
  // samples with header indexes used to shift every column left by one —
  // employer names landed under the allow-listed "Term" header unredacted.
  const { document } = parseHTML(`<!doctype html><html><body>
    <table>
      <tr><th>Term</th><th>Employer</th><th>Status</th></tr>
      <tr><th class="job">Software Developer</th><td class="co">Contoso Ltd</td><td>Not Selected</td></tr>
      <tr><th class="job">Data Analyst</th><td class="co">Initech Corp</td><td>Selected</td></tr>
    </table>
  </body></html>`);
  const out = htmlOutline(document, { textMode: "full" });
  const t = out.tables[0];
  assert.deepEqual(t.headers, ["Term", "Employer", "Status"]);
  // Column 0 is the row <th> under "Term" (allow-listed label), column 1 is
  // the employer — now under a non-allow-listed header, so it stays a length.
  assert.deepEqual(t.sample[0][0], { cls: "job", text: "Software Developer" });
  assert.equal(t.sample[0][1].text, `<text ${"Contoso Ltd".length}>`);
  assert.equal(t.sample[0][2].text, "Not Selected");
  const json = JSON.stringify(out);
  assert.ok(!json.includes("Contoso") && !json.includes("Initech"), "employer names stay redacted");
});

test("normalizePath replaces path segments holding an email address", () => {
  assert.equal(
    normalizePath("https://mail.x/d2l/m/SMTP:jdoe@uwaterloo.ca"),
    "mail.x/d2l/m/{email}"
  );
  // %40 must be decoded before the email check.
  assert.equal(
    normalizePath("https://outlook.office.com/users/careers%40uwaterloo.ca"),
    "outlook.office.com/users/{email}"
  );
  assert.equal(
    normalizePath("https://outlook.office.com/users('OID:abc@tenant.example')"),
    "outlook.office.com/{email}"
  );
  // Email inside a query KEY is collapsed too (values are dropped anyway).
  assert.equal(
    normalizePath("https://x/find?jdoe@uwaterloo.ca=1&kind=mail"),
    "x/find?kind&{email}"
  );
});

test("normalizePath redacts the configured words inside paths", () => {
  assert.equal(
    normalizePath("https://discord.com/u/JSmith87/files", ["jsmith87"]),
    "discord.com/u/<redacted>/files"
  );
});

test("normalizePath treats %-encoded opaque tokens as ids", () => {
  // An Outlook message id ends in %3D (an encoded '=') — the token class
  // accepts % and = so the whole segment becomes {id}.
  assert.equal(
    normalizePath("https://outlook.office.com/mail/inbox/id/AAQkAGI1NjAwZjY4LWEzN2ItNGY0Mi1hOWVl%3D"),
    "outlook.office.com/mail/inbox/id/{id}"
  );
});

test("a query-string-shaped hash keeps sorted keys only", () => {
  assert.equal(
    normalizePath("https://outlook.office.com/mail/#parent=xyz&rpctoken=123"),
    "outlook.office.com/mail/#parent&rpctoken"
  );
});

test("shapeOf collapses id-looking object keys into {id}", () => {
  const shape = shapeOf({
    "123456789012345678": { text: "hello there", pinned: false },
    "987654321098765432": { text: "another message body", pinned: true, extra: 1 },
    "550e8400-e29b-41d4-a716-446655440000": { text: "uuid keyed" },
    channel: { name: "general" },
  });
  assert.equal(shape["123456789012345678"], undefined, "raw snowflake key is gone");
  assert.equal(shape["{id}#count"], 3);
  const merged = shape["{id}"];
  assert.equal(merged.text, "<string 11>", "values are still shaped (first sample wins)");
  assert.equal(merged["pinned?"], false, "not on every sampled entry -> ? marker");
  assert.equal(merged["extra?"], "<number>", "non-shared keys get the ? marker");
  assert.deepEqual(shape.channel, { name: "<string 7>" });
});
