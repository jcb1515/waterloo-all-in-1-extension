// @ts-check
/*
  LearnReader unit tests: pure helpers (term codes, suffix stripping, course
  name/code splitting) plus request plumbing (paging, session reasons) and the
  per-course merge rules (echo fold, calendar rank, deep/list links) exercised
  through a route-map transport.
*/

import test from "node:test";
import assert from "node:assert/strict";
import {
  LearnReader,
  LEARN_ORIGIN,
  learnOrigin,
  stripLearnSuffix,
  termFromText,
} from "../../extension/src/sources/learn/reader.js";

const NOW = new Date("2026-09-26T16:00:00.000Z");
const WHOAMI = { Identifier: "8001", FirstName: "Samplefirst", UniqueName: "samplesample" };

/** Normalise a request path for route lookup (fold lp/le versions to V, drop query). */
const keyOf = (path) => {
  const u = new URL(path, LEARN_ORIGIN);
  return u.pathname.replace(/\/(lp|le)\/[\d.]+\//, "/$1/V/");
};

/**
 * A reader whose transport answers from a path→{status,json}|fn(url) map.
 * Returns { reader, calls, relayCalls }.
 */
function makeReader(routes, { now = NOW, relay = null } = {}) {
  const calls = [];
  const relayCalls = [];
  const transport = async (path) => {
    calls.push(path);
    const route = routes.get(keyOf(path));
    if (!route) return { status: 404, json: {} };
    const r = typeof route === "function" ? route(new URL(path, LEARN_ORIGIN)) : route;
    return { status: r.status ?? 200, json: r.json };
  };
  const reader = new LearnReader({}, { transport, relay, now });
  reader.versions = { lp: "1.30", le: "1.60" };
  return { reader, calls, relayCalls };
}

const enrollment = (Id, Name, Code, access = {}) => ({
  OrgUnit: { Id, Name, Code, Type: { Id: 3 } },
  Access: { CanAccess: true, IsActive: true, ...access },
});

/** Route map with an enrollments page and empty everything else for ou 1001. */
function courseRoutes(enrollments) {
  const routes = new Map();
  routes.set("/d2l/api/lp/V/enrollments/myenrollments/", { json: { Items: enrollments } });
  for (const p of [
    "/d2l/api/le/V/1001/dropbox/folders/",
    "/d2l/api/le/V/1001/quizzes/",
    "/d2l/api/le/V/1001/discussions/forums/",
    "/d2l/api/le/V/content/myItems/due/",
    "/d2l/api/le/V/content/myItems/",
    "/d2l/api/le/V/content/myItems/completions/due/",
    "/d2l/api/le/V/content/myItems/completions/",
    "/d2l/api/le/V/calendar/events/myEvents/",
  ]) {
    routes.set(p, { json: { Objects: [] } });
  }
  return routes;
}

/* ------------------------------ pure helpers ------------------------------ */

test("termFromText: standalone 1YYS code wins", () => {
  assert.equal(termFromText("ECE203_x_1269"), 1269);
  assert.equal(termFromText("CHE102_xx_1259"), 1259);
  assert.equal(termFromText("abc1269def"), 1269);
  assert.equal(termFromText("x_12699"), null); // 5-digit run isn't a term code
  assert.equal(termFromText("LEARN101_community"), null);
});

test("termFromText: season + year phrases", () => {
  assert.equal(termFromText("Fall 2026"), 1269);
  assert.equal(termFromText("winter 2027"), 1271);
  assert.equal(termFromText("Spring_2027"), 1275);
  assert.equal(termFromText("SUMMER 2027"), 1275);
  assert.equal(termFromText("autumn 2025"), 1259);
  assert.equal(termFromText("no term here"), null);
});

test("stripLearnSuffix: drops status suffixes after a separator", () => {
  assert.equal(stripLearnSuffix("Lab 2 Report - Due"), "Lab 2 Report");
  assert.equal(stripLearnSuffix("Essay - Due Date"), "Essay");
  assert.equal(stripLearnSuffix("Quiz : Available"), "Quiz");
  assert.equal(stripLearnSuffix("Lab – Ends"), "Lab");
  assert.equal(stripLearnSuffix("Topic — Unlock Starts"), "Topic");
  assert.equal(stripLearnSuffix("Thing - Availability Ends"), "Thing");
});

test("stripLearnSuffix: keeps titles without a separator or a known suffix", () => {
  assert.equal(stripLearnSuffix("Due"), "Due");
  assert.equal(stripLearnSuffix("Past due soon"), "Past due soon");
  assert.equal(stripLearnSuffix("Report - Section 2"), "Report - Section 2");
  assert.equal(stripLearnSuffix("  Spaced   "), "Spaced");
});

test("learnOrigin: only localhost overrides are honoured", () => {
  assert.equal(learnOrigin({}), LEARN_ORIGIN);
  assert.equal(learnOrigin({ liveBaseOverride: "http://localhost:8787/x" }), "http://localhost:8787");
  assert.equal(learnOrigin({ liveBaseOverride: "http://127.0.0.1:9" }), "http://127.0.0.1:9");
  assert.equal(learnOrigin({ liveBaseOverride: "https://example.com" }), LEARN_ORIGIN);
  assert.equal(learnOrigin({ liveBaseOverride: "not a url" }), LEARN_ORIGIN);
});

/* ---------------------------- course name parsing -------------------------- */

test("listCourses: name/code parsing covers the three shapes", async () => {
  const { reader } = makeReader(
    courseRoutes([
      enrollment(1001, "ECE 105 - Fall 2026", "ECE105_xx_1269"),
      enrollment(1002, "MATH 117 LEC 001 - Fall 2026", "MATH117_xx_1269"),
      enrollment(1003, "CS 136 - Designing Programs (Fall 2026)", "CS136_xx_1269"),
      enrollment(1004, "BIOL 130 / CHEM 120 - Cell Biology - Fall 2026", "BIOL130_xx_1269"),
      enrollment(1005, "Co-op work term", "COOP_101_term"),
      enrollment(1006, "Engineering Ready", "ENGREADY_x"),
      enrollment(1007, "MTHEL 99 - Fall 2026", "MTHEL99_x"),
    ]),
  );
  const courses = await reader.listCourses();
  const byId = Object.fromEntries(courses.map((c) => [c.orgUnitId, c]));

  // Pattern 1: code from the name, term phrase and section tokens dropped.
  assert.equal(byId[1001].code, "ECE 105");
  assert.equal(byId[1001].name, "");
  assert.equal(byId[1002].code, "MATH 117");
  assert.equal(byId[1002].name, "");
  assert.equal(byId[1003].code, "CS 136");
  assert.equal(byId[1003].name, "Designing Programs");
  assert.equal(byId[1004].code, "BIOL 130"); // cross-listed part dropped
  assert.equal(byId[1004].name, "Cell Biology");

  // Pattern 2: name isn't course-shaped; code comes from OrgUnit.Code.
  assert.equal(byId[1005].code, "COOP 101");
  assert.equal(byId[1005].name, "Co-op work term");

  // Pattern 3: not a course — code is the ≤18-char whole-word run of the name.
  assert.equal(byId[1006].code, "Engineering Ready");
  assert.equal(byId[1006].name, "Engineering Ready");
  assert.equal(byId[1007].code, "MTHEL 99 - Fall");
  assert.equal(byId[1007].name, "MTHEL 99 - Fall 2026");
});

test("listCourses: term filter keeps current-term and termless courses", async () => {
  const { reader } = makeReader(
    courseRoutes([
      enrollment(1001, "ECE 105 - Fall 2026", "ECE105_xx_1269"), // current term
      enrollment(1002, "CHE 102 - Spring 2026", "CHE102_xx_1259"), // old term: dropped
      enrollment(1003, "Community", "COMM_x"), // termless: kept, not current
    ]),
  );
  const courses = await reader.listCourses();
  assert.deepEqual(courses.map((c) => c.orgUnitId).sort(), [1001, 1003]);
  assert.equal(courses.find((c) => c.orgUnitId === 1001).current, true);
  assert.equal(courses.find((c) => c.orgUnitId === 1003).current, false);
});

test("listCourses: nothing matched falls back to every candidate", async () => {
  const { reader } = makeReader(
    courseRoutes([enrollment(1001, "CHE 102 - Spring 2026", "CHE102_xx_1259")]),
  );
  const courses = await reader.listCourses();
  assert.equal(courses.length, 1);
  assert.equal(courses[0].current, true); // fallback marks them current
});

/* --------------------------------- session --------------------------------- */

test("checkSession: worker signed in -> via worker", async () => {
  const routes = new Map([["/d2l/api/lp/V/users/whoami", { json: WHOAMI }]]);
  const { reader } = makeReader(routes);
  const res = await reader.checkSession();
  assert.deepEqual(res, { signedIn: true, via: "worker" });
  assert.equal(reader.userId, "8001");
});

test("checkSession: worker 401 + no relay -> no-tab", async () => {
  const routes = new Map([["/d2l/api/lp/V/users/whoami", { status: 401, json: {} }]]);
  const { reader } = makeReader(routes);
  const res = await reader.checkSession();
  assert.deepEqual(res, { signedIn: false, reason: "no-tab" });
});

test("checkSession: worker 401 + tab 401 -> signed-out", async () => {
  const routes = new Map([["/d2l/api/lp/V/users/whoami", { status: 401, json: {} }]]);
  const { reader } = makeReader(routes, {
    relay: async () => ({ status: 401 }),
  });
  const res = await reader.checkSession();
  assert.deepEqual(res, { signedIn: false, reason: "signed-out" });
});

test("checkSession: worker 401 + tab network error -> unreachable", async () => {
  const routes = new Map([["/d2l/api/lp/V/users/whoami", { status: 401, json: {} }]]);
  const { reader } = makeReader(routes, {
    relay: async () => ({ status: 0, error: "net" }),
  });
  const res = await reader.checkSession();
  assert.deepEqual(res, { signedIn: false, reason: "unreachable" });
});

test("checkSession: a working tab takes over the route", async () => {
  const routes = new Map();
  routes.set("/d2l/api/lp/V/users/whoami", { status: 401, json: {} });
  routes.set("/d2l/api/lp/V/enrollments/myenrollments/", { json: { Items: [] } });
  const relayCalls = [];
  const { reader, calls } = makeReader(routes, {
    relay: async (_o, path) => {
      relayCalls.push(path);
      return keyOf(path).endsWith("whoami") ? { status: 200, json: WHOAMI } : { status: 200, json: { Items: [] } };
    },
  });
  const res = await reader.checkSession();
  assert.deepEqual(res, { signedIn: true, via: "tab" });
  await reader.listCourses();
  assert.ok(relayCalls.some((p) => p.includes("myenrollments")), "enrollments went through the tab");
  assert.ok(!calls.some((p) => p.includes("myenrollments")), "worker not used after the switch");
});

/* --------------------------------- paging ---------------------------------- */

test("paging: PagingInfo bookmarks stay on the original path", async () => {
  const routes = new Map();
  routes.set("/d2l/api/lp/V/enrollments/myenrollments/", (url) => {
    const bm = url.searchParams.get("bookmark");
    if (!bm) {
      return {
        json: {
          Items: [enrollment(1001, "ECE 105 - Fall 2026", "ECE105_xx_1269")],
          PagingInfo: { HasMoreItems: true, Bookmark: "tok en" },
        },
      };
    }
    assert.equal(bm, "tok en");
    return { json: { Items: [enrollment(1002, "MATH 117 - Fall 2026", "MATH117_xx_1269")] } };
  });
  const { reader, calls } = makeReader(routes);
  const courses = await reader.listCourses();
  assert.equal(courses.length, 2);
  const page2 = calls.find((p) => p.includes("bookmark="));
  assert.ok(page2 && page2.includes("bookmark=tok%20en"), page2);
  assert.ok(page2.includes("orgUnitTypeId=3"), "bookmark rides on the original path");
});

test("paging: a Next link is followed via pathname+search", async () => {
  const routes = new Map();
  routes.set("/d2l/api/lp/V/enrollments/myenrollments/", (url) => {
    if (!url.searchParams.get("page")) {
      return {
        json: {
          Items: [enrollment(1001, "ECE 105 - Fall 2026", "ECE105_xx_1269")],
          Next: "https://learn.uwaterloo.ca/d2l/api/lp/1.30/enrollments/myenrollments/?page=2",
        },
      };
    }
    assert.equal(url.searchParams.get("page"), "2");
    return { json: { Items: [] } };
  });
  const { reader, calls } = makeReader(routes);
  await reader.listCourses();
  assert.ok(calls.some((p) => p.includes("page=2")));
});

/* ------------------------------ merge basics ------------------------------- */

/** A route map with one course's tool/feed/calendar payloads filled in. */
function deadlineRoutes({ folders = [], quizzes = [], forums = [], feedItems = [], events = [] } = {}) {
  const routes = courseRoutes([enrollment(1001, "ECE 105 - Fall 2026", "ECE105_xx_1269")]);
  routes.set("/d2l/api/le/V/1001/dropbox/folders/", { json: folders });
  routes.set("/d2l/api/le/V/1001/quizzes/", { json: quizzes });
  routes.set("/d2l/api/le/V/1001/discussions/forums/", { json: forums });
  routes.set("/d2l/api/le/V/content/myItems/due/", { json: { Objects: feedItems } });
  routes.set("/d2l/api/le/V/calendar/events/myEvents/", { json: { Objects: events } });
  return routes;
}

async function deadlinesOf(routes) {
  const { reader } = makeReader(routes);
  const [course] = await reader.listCourses();
  return reader.listDeadlines(course);
}

test("merge: deep links, list pages and tool categories", async () => {
  const routes = deadlineRoutes({
    folders: [
      { Id: 9, Name: "Assignment", DueDate: "2026-10-01T03:59:00.000Z" },
      { Id: 10, Name: "Lab report", DueDate: "2026-10-02T03:59:00.000Z", CategoryId: 3 },
    ],
    quizzes: [{ QuizId: 8, Name: "Quiz", EndDate: "2026-10-03T03:59:00.000Z", IsActive: true }],
  });
  routes.set("/d2l/api/le/V/1001/dropbox/categories/", { json: [{ Id: 3, Name: "Labs" }] });
  const rows = await deadlinesOf(routes);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(
    byId["1001:dropbox:9"].url,
    `${LEARN_ORIGIN}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=9&ou=1001`,
  );
  assert.equal(byId["1001:dropbox:9"].listUrl, `${LEARN_ORIGIN}/d2l/lms/dropbox/user/folders_list.d2l?ou=1001`);
  assert.equal(byId["1001:dropbox:9"].category, "assignment");
  assert.equal(byId["1001:dropbox:10"].category, "lab", "Labs category name");
  assert.equal(byId["1001:quiz:8"].url, `${LEARN_ORIGIN}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=8&ou=1001`);
  assert.equal(byId["1001:quiz:8"].category, "quiz");
});

test("merge: a calendar echo folds into the tool item; two tool rows never fold", async () => {
  const dueAt = "2026-10-01T03:59:00.000Z";
  const rows = await deadlinesOf(
    deadlineRoutes({
      folders: [
        { Id: 9, Name: "Report", DueDate: dueAt },
        { Id: 11, Name: "Twin", DueDate: "2026-10-04T03:59:00.000Z" },
      ],
      quizzes: [{ QuizId: 8, Name: "Twin", EndDate: "2026-10-04T03:59:00.000Z", IsActive: true }],
      events: [
        {
          CalendarEventId: 900,
          OrgUnitId: 1001,
          Title: "Report - Due",
          StartDateTime: dueAt,
          EventType: 6,
          IsAssociatedWithEntity: false,
        },
      ],
    }),
  );
  const report = rows.filter((r) => r.title === "Report");
  assert.equal(report.length, 1, "calendar echo folded into the dropbox row");
  assert.deepEqual(report[0].seenIn, ["dropbox", "calendar"]);
  const twins = rows.filter((r) => r.title === "Twin");
  assert.equal(twins.length, 2, "two tool-origin rows with the same echo key stay separate");
});

test("calendar: associated events rank due > ends > event, later wins on ties", async () => {
  const mk = (id, type, end, start) => ({
    CalendarEventId: id,
    OrgUnitId: 1001,
    Title: `Ev ${id}`,
    EventType: type,
    IsAssociatedWithEntity: true,
    AssociatedEntity: { AssociatedEntityId: 77, AssociatedEntityType: "D2L.LE.Content.Dropbox" },
    EndDateTime: end,
    StartDateTime: start,
  });
  const rows = await deadlinesOf(
    deadlineRoutes({
      events: [
        mk(1, 4, null, "2026-10-01T00:00:00.000Z"), // opens: recorded, no row
        mk(2, 3, "2026-10-05T00:00:00.000Z"), // ends: rank 2
        mk(3, 6, "2026-10-06T00:00:00.000Z"), // due: rank 3 wins
        mk(4, 6, "2026-10-07T00:00:00.000Z"), // due, later date replaces
      ],
    }),
  );
  const row = rows.find((r) => r.id === "1001:dropbox:77");
  assert.ok(row, "associated dropbox row exists");
  assert.equal(row.dueAt, "2026-10-07T00:00:00.000Z");
  assert.equal(row.dueField, "due");
  assert.equal(row.opensAt, "2026-10-01T00:00:00.000Z", "opens event applied");
});

test("calendar: a non-associated deadline-word event becomes a timed row", async () => {
  const rows = await deadlinesOf(
    deadlineRoutes({
      events: [
        {
          CalendarEventId: 500,
          OrgUnitId: 1001,
          Title: "Midterm sitting",
          StartDateTime: "2026-10-27T20:30:00.000Z",
          EndDateTime: "2026-10-27T22:20:00.000Z",
          EventType: 6,
          IsAssociatedWithEntity: false,
        },
        {
          CalendarEventId: 501,
          OrgUnitId: 1001,
          Title: "Club social", // no deadline word -> skipped
          StartDateTime: "2026-10-27T20:30:00.000Z",
          IsAssociatedWithEntity: false,
        },
      ],
    }),
  );
  const row = rows.find((r) => r.id === "1001:content:cal500");
  assert.ok(row);
  assert.equal(row.startAt, "2026-10-27T20:30:00.000Z");
  assert.equal(row.endAt, "2026-10-27T22:20:00.000Z");
  assert.equal(row.url, `${LEARN_ORIGIN}/d2l/le/content/1001/Home`, "no deep link for cal ids");
  assert.ok(!rows.some((r) => r.id === "1001:content:cal501"));
});

test("merge: feed row merges into the tool item by url tool id", async () => {
  const rows = await deadlinesOf(
    deadlineRoutes({
      folders: [{ Id: 42, Name: "Assignment 1", DueDate: "2026-10-01T03:59:00.000Z" }],
      feedItems: [
        {
          OrgUnitId: 1001,
          ItemId: 9001,
          ItemName: "Assignment 1",
          ItemUrl: `${LEARN_ORIGIN}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=42&ou=1001`,
          ActivityType: 3,
          DueDate: "2026-10-01T03:59:00.000Z",
        },
      ],
    }),
  );
  const a1 = rows.filter((r) => r.title === "Assignment 1");
  assert.equal(a1.length, 1);
  assert.deepEqual(a1[0].seenIn, ["dropbox", "feed"]);
});

test("group folder: url deep-links with grpid once the submission names it", async () => {
  const routes = deadlineRoutes({
    folders: [
      { Id: 60, Name: "Team report", DueDate: "2026-10-01T03:59:00.000Z", GroupTypeId: 4 },
    ],
  });
  routes.set("/d2l/api/le/V/1001/dropbox/folders/60/submissions/mysubmissions/", {
    json: [{ Entity: { EntityId: 321 }, Submissions: [] }],
  });
  const rows = await deadlinesOf(routes);
  const row = rows.find((r) => r.id === "1001:dropbox:60");
  assert.ok(row);
  assert.equal(row.groupFolder, true);
  assert.equal(
    row.url,
    `${LEARN_ORIGIN}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=60&grpid=321&isprv=0&bp=0&ou=1001`,
  );
});

test("group folder: unknown group falls back to the list page", async () => {
  const routes = deadlineRoutes({
    folders: [
      { Id: 61, Name: "Team charter", DueDate: "2026-10-01T03:59:00.000Z", GroupTypeId: 4 },
    ],
  });
  routes.set("/d2l/api/le/V/1001/dropbox/folders/61/submissions/mysubmissions/", { json: [] });
  const rows = await deadlinesOf(routes);
  const row = rows.find((r) => r.id === "1001:dropbox:61");
  assert.ok(row);
  assert.equal(row.groupFolder, true);
  assert.equal(row.url, `${LEARN_ORIGIN}/d2l/lms/dropbox/user/folders_list.d2l?ou=1001`);
});

/* --------------------------------- news ----------------------------------- */

test("readNews: html bodies flatten to text, hidden/unpublished skipped", async () => {
  const routes = new Map();
  routes.set("/d2l/api/le/V/1001/news/", {
    json: [
      {
        Id: 1,
        Title: "Moved",
        Body: { Html: "<p>Exam <b>moved</b>&nbsp;to Friday.<script>bad()</script></p>" },
        StartDate: "2026-09-25T12:00:00.000Z",
        IsPublished: true,
      },
      { Id: 2, Title: "Hidden", Body: { Text: "x" }, IsPublished: true, IsHidden: true },
      { Id: 3, Title: "Draft", Body: { Text: "x" }, IsPublished: false },
    ],
  });
  const { reader } = makeReader(routes);
  const news = await reader.readNews({ orgUnitId: 1001 });
  assert.equal(news.length, 1);
  assert.equal(news[0].text, "Exam moved to Friday.");
  assert.equal(news[0].id, "1");
  assert.equal(news[0].at, "2026-09-25T12:00:00.000Z");
});
