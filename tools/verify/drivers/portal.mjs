// @ts-check
// Portal driver: JSON fixtures as observed net responses on the URLs the
// adapter test uses (test/portal/adapter.test.js).

import fs from "node:fs";
import path from "node:path";
import adapter from "../../../extension/src/sources/portal/index.js";

const NOW = new Date("2026-09-27T16:00:00.000Z");
const API = "https://portalapi2.uwaterloo.ca/v2";

/** Fixture filename -> the API URL its shape belongs to. */
const URLS = {
  "schedule.json": `${API}/student/CourseSchedule/`,
  "exams.json": `${API}/student/ExamSchedule/`,
  "enrollments.json": `${API}/student/CourseEnrollments/`,
  "enrollments-course.json": `${API}/student/CourseEnrollments/12345678/ECE-150`,
  "events.json": `${API}/Calendar/DailyEventsV2?start=2026-09-01&end=2026-12-31`,
};

export default {
  source: "portal",
  now: NOW,
  match: (p) => {
    const m = /[\\/]portal[\\/][^\\/]+\.json$/i.test(p);
    return m && Object.hasOwn(URLS, path.basename(p).toLowerCase());
  },
  /** @param {string} fixturePath @param {{now: Date, at: string, state: any}} env */
  async run(fixturePath, env) {
    const name = path.basename(fixturePath).toLowerCase();
    const ctx = {
      now: env.now,
      settings: {},
      state: env.state,
      courses: [],
      terms: [],
      log() {},
      textDates: () => [],
      fetch: async () => ({ status: 0 }),
      relay: async () => ({ status: 0 }),
    };
    const res = await adapter.observe.parse(
      {
        source: "portal",
        kind: /** @type {const} */ ("net"),
        url: URLS[name],
        status: 200,
        body: fs.readFileSync(fixturePath, "utf8"),
        at: env.at,
      },
      ctx,
    );
    env.state = res && res.state ? res.state : env.state;
    return res;
  },
};
