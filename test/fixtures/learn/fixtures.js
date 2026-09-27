// @ts-check
/*
  Synthetic Learn fixture. A fake route map keyed by API path (with the lp/le
  version normalised to "V") plus a makeCtx() that builds a SyncContext whose
  fetch/relay answer contract FetchResults from the map. All values are fake.
*/

import { extractDates } from "../../../extension/src/lib/textdates/index.js";

export const NOW = new Date("2026-09-26T16:00:00.000Z");
export const BASE = "https://learn.uwaterloo.ca";

export const WHOAMI = {
  Identifier: "8001",
  FirstName: "Samplefirst",
  LastName: "Samplelast",
  UniqueName: "samplesample",
};

const OU = { ECE: 1001, MATH: 1002, OLD: 1003, COMMUNITY: 1004 };

const enrollment = (Id, Name, Code) => ({
  OrgUnit: { Id, Name, Code, Type: { Id: 3 }, HomeUrl: `/d2l/home/${Id}` },
  Access: { CanAccess: true, IsActive: true, ClasslistRoleName: "Student" },
});

function emptyCourseRoutes(routes, ou) {
  routes.set(`/d2l/api/le/V/${ou}/dropbox/folders/`, { json: [] });
  routes.set(`/d2l/api/le/V/${ou}/quizzes/`, { json: [] });
  routes.set(`/d2l/api/le/V/${ou}/discussions/forums/`, { json: [] });
  routes.set(`/d2l/api/le/V/${ou}/news/`, { json: [] });
  routes.set(`/d2l/api/le/V/${ou}/grades/`, { json: [] });
  routes.set(`/d2l/api/le/V/${ou}/grades/categories/`, { json: [] });
  routes.set(`/d2l/api/le/V/${ou}/grades/values/myGradeValues/`, { json: [] });
  routes.set(`/d2l/api/le/V/${ou}/content/toc`, { json: { Modules: [] } });
}

/** The happy-path route map. Pass overrides to makeCtx to break single routes. */
export function learnRoutes() {
  const routes = new Map();

  routes.set("/d2l/api/versions/", {
    json: [
      { ProductCode: "lp", LatestVersion: "1.30" },
      { ProductCode: "le", LatestVersion: "1.60" },
    ],
  });
  routes.set("/d2l/api/lp/V/users/whoami", { json: WHOAMI });
  routes.set("/d2l/api/lp/V/enrollments/myenrollments/", {
    json: {
      Items: [
        enrollment(OU.ECE, "ECE 105 - Fall 2026", "ECE105_xx_1269"),
        enrollment(OU.MATH, "MATH 117 - Fall 2026", "MATH117_xx_1269"),
        enrollment(OU.OLD, "CHE 102 - Spring 2026", "CHE102_xx_1259"),
        enrollment(OU.COMMUNITY, "Learn Community", "LEARN101_community"),
      ],
    },
  });

  /* ---- ECE 105 (1001) ---- */
  routes.set(`/d2l/api/le/V/${OU.ECE}/dropbox/folders/`, {
    json: [
      {
        Id: 42,
        Name: "Assignment 1",
        DueDate: "2026-10-01T03:59:00.000Z",
        Availability: { StartDate: "2026-09-20T04:00:00.000Z", EndDate: "2026-10-01T03:59:00.000Z" },
      },
      {
        Id: 43,
        Name: "Lab 2 Report",
        CategoryId: 7,
        Availability: { StartDate: "2026-09-28T04:00:00.000Z", EndDate: "2026-10-09T03:59:00.000Z" },
      },
    ],
  });
  routes.set(`/d2l/api/le/V/${OU.ECE}/dropbox/categories/`, { json: [{ Id: 7, Name: "Labs" }] });
  routes.set(`/d2l/api/le/V/${OU.ECE}/dropbox/folders/42/submissions/mysubmissions/`, {
    json: [{ Submissions: [{ SubmissionDate: "2026-09-20T15:04:00.000Z" }] }],
  });
  routes.set(`/d2l/api/le/V/${OU.ECE}/dropbox/folders/43/submissions/mysubmissions/`, { json: [] });
  routes.set(`/d2l/api/le/V/${OU.ECE}/quizzes/`, {
    json: [
      { QuizId: 55, Name: "Midterm Exam", EndDate: "2026-10-22T20:00:00.000Z", IsActive: true },
      { QuizId: 56, Name: "Quiz 2", EndDate: "2026-10-15T20:00:00.000Z", IsActive: true },
    ],
  });
  // Learn answers 403 to students on the attempts route.
  routes.set(`/d2l/api/le/V/${OU.ECE}/quizzes/55/attempts/`, { status: 403, json: {} });
  routes.set(`/d2l/api/le/V/${OU.ECE}/quizzes/56/attempts/`, { status: 403, json: {} });
  routes.set(`/d2l/api/le/V/${OU.ECE}/discussions/forums/`, { json: [{ ForumId: 9, Name: "Course questions" }] });
  routes.set(`/d2l/api/le/V/${OU.ECE}/discussions/forums/9/topics/`, {
    json: [{ TopicId: 77, Name: "Week 3 discussion", DueDate: "2026-10-03T03:59:00.000Z" }],
  });
  routes.set(`/d2l/api/le/V/${OU.ECE}/discussions/forums/9/topics/77/posts/`, {
    json: [{ PostingUserId: 8001, PostedDate: "2026-09-25T18:00:00.000Z" }],
  });
  routes.set(`/d2l/api/le/V/${OU.ECE}/news/`, {
    json: [
      {
        Id: 301,
        Title: "Midterm moved",
        Body: { Text: "Midterm moved to Thursday, October 29, 4:30 - 6:20 pm in STC 1012." },
        StartDate: "2026-09-25T12:00:00.000Z",
        IsPublished: true,
      },
      {
        Id: 302,
        Title: "Library hours",
        Body: { Html: "<p>The library is <b>closed</b> Oct&nbsp;12.</p>" },
        StartDate: "2026-09-24T12:00:00.000Z",
        IsPublished: true,
      },
      { Id: 303, Title: "Hidden note", Body: { Text: "Quiz on Oct 3." }, StartDate: "2026-09-24T12:00:00.000Z", IsPublished: true, IsHidden: true },
    ],
  });
  routes.set(`/d2l/api/le/V/${OU.ECE}/grades/`, {
    json: [
      { Id: 88, Name: "Midterm Exam", Weight: 25, CategoryId: 5 },
      { Id: 89, Name: "Assignment 1", Weight: 15, CategoryId: 6 },
    ],
  });
  routes.set(`/d2l/api/le/V/${OU.ECE}/grades/categories/`, {
    json: [
      { CategoryId: 5, Name: "Exams", Weight: 40 },
      { CategoryId: 6, Name: "Assignments", Weight: 60 },
    ],
  });
  routes.set(`/d2l/api/le/V/${OU.ECE}/grades/values/myGradeValues/`, {
    json: [
      {
        GradeObjectId: 88,
        GradeObjectName: "Midterm Exam",
        PointsNumerator: 20,
        PointsDenominator: 25,
        WeightedDenominator: 25,
        DisplayedGrade: "80 %",
      },
    ],
  });
  routes.set(`/d2l/api/le/V/${OU.ECE}/content/toc`, {
    json: {
      Modules: [
        {
          Title: "Course",
          Topics: [{ Title: "Course Outline", Url: "https://outline.uwaterloo.ca/viewer/view/abc123" }],
          Modules: [
            {
              Title: "Week 1",
              Topics: [
                { Title: "Syllabus", Url: `/d2l/le/content/${OU.ECE}/Syllabus.pdf` },
                { Title: "Welcome slides", Url: `/d2l/le/content/${OU.ECE}/Welcome.pdf` },
              ],
            },
          ],
        },
      ],
    },
  });

  /* ---- MATH 117 (1002): one deadline, everything else empty ---- */
  routes.set(`/d2l/api/le/V/${OU.MATH}/dropbox/folders/`, {
    json: [{ Id: 44, Name: "Assignment 2", DueDate: "2026-10-05T03:59:00.000Z" }],
  });
  routes.set(`/d2l/api/le/V/${OU.MATH}/dropbox/folders/44/submissions/mysubmissions/`, { json: [] });
  routes.set(`/d2l/api/le/V/${OU.MATH}/quizzes/`, { json: [] });
  routes.set(`/d2l/api/le/V/${OU.MATH}/discussions/forums/`, { json: [] });
  routes.set(`/d2l/api/le/V/${OU.MATH}/news/`, { json: [] });
  routes.set(`/d2l/api/le/V/${OU.MATH}/grades/`, { json: [] });
  routes.set(`/d2l/api/le/V/${OU.MATH}/grades/categories/`, { json: [] });
  routes.set(`/d2l/api/le/V/${OU.MATH}/grades/values/myGradeValues/`, { json: [] });
  routes.set(`/d2l/api/le/V/${OU.MATH}/content/toc`, { json: { Modules: [] } });

  /* ---- Termless unit (1004): reads fine, has nothing upcoming ---- */
  emptyCourseRoutes(routes, OU.COMMUNITY);

  /* ---- Cross-course feed and calendar ---- */
  routes.set("/d2l/api/le/V/content/myItems/due/", {
    json: {
      Objects: [
        {
          OrgUnitId: OU.ECE,
          ItemId: 9001,
          ItemName: "Assignment 1",
          ItemUrl: "https://learn.uwaterloo.ca/d2l/lms/dropbox/user/folder_submit_files.d2l?db=42&ou=1001",
          ActivityType: 3,
          DueDate: "2026-10-01T03:59:00.000Z",
        },
      ],
    },
  });
  routes.set("/d2l/api/le/V/content/myItems/", { json: { Objects: [] } });
  routes.set("/d2l/api/le/V/content/myItems/completions/due/", { json: { Objects: [] } });
  routes.set("/d2l/api/le/V/content/myItems/completions/", { json: { Objects: [] } });
  routes.set("/d2l/api/le/V/calendar/events/myEvents/", {
    json: {
      Objects: [
        {
          CalendarEventId: 500,
          OrgUnitId: OU.ECE,
          Title: "ECE 105 Midterm",
          StartDateTime: "2026-10-27T20:30:00.000Z",
          EndDateTime: "2026-10-27T22:20:00.000Z",
          IsAllDayEvent: false,
          IsRecurring: false,
          IsAssociatedWithEntity: false,
          EventType: 6,
        },
      ],
    },
  });

  return routes;
}

/** Normalise a url/path to its route-map key: strip query, fold api versions to V. */
export function keyOf(urlOrPath) {
  const u = new URL(urlOrPath, BASE);
  return u.pathname.replace(/\/(lp|le)\/[\d.]+\//, "/$1/V/");
}

function toResult(route, url) {
  if (!route) return { status: 404, url, contentType: "application/json", text: "{}" };
  const r = typeof route === "function" ? route(url) : route;
  return {
    status: r.status ?? 200,
    url,
    contentType: r.contentType || "application/json",
    text: typeof r.text === "string" ? r.text : JSON.stringify(r.json ?? null),
  };
}

/**
 * A SyncContext whose fetch/relay answer from the route map.
 * workerSignedOut: every T1 fetch answers 401. noTab: the relay answers noTab.
 * Returns { ctx, calls } where calls.fetch/calls.relay record the route keys.
 */
export function makeCtx(routes, { now = NOW, workerSignedOut = false, noTab = false } = {}) {
  const calls = { fetch: [], relay: [] };
  const ctx = {
    now,
    settings: {},
    state: { versions: { lp: "1.30", le: "1.60" } },
    courses: [],
    terms: [],
    fetch: async (url) => {
      const key = keyOf(url);
      calls.fetch.push(key);
      return workerSignedOut ? { status: 401, url, contentType: "application/json", text: "{}" } : toResult(routes.get(key), url);
    },
    relay: async (_origin, path) => {
      const key = keyOf(path);
      calls.relay.push(key);
      if (noTab) return { status: 0, noTab: true };
      return toResult(routes.get(key), BASE + path);
    },
    parseHtml: async () => ({}),
    textDates: extractDates,
    log: () => {},
  };
  return { ctx, calls };
}
