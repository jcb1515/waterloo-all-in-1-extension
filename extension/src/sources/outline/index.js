// @ts-check
/*
  Course-outline adapter: outline.uwaterloo.ca pages (or offline .html files in
  settings) -> classes, exams, deadlines and office hours. All DOM work happens
  in the offscreen document via ctx.parseHtml(html, "outline/parseOutline");
  expansion is the pure buildOutline() in expand.js.
*/

import { normCourseCode } from "../../core/contract.js";
import { extractDates } from "../../lib/textdates/index.js";
import { buildOutline, readingWeeksOf } from "./expand.js";

/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */
/** @typedef {import("../../core/contract.js").Adapter} Adapter */

/** @type {Adapter} */
const adapter = {
  id: "outline",
  label: "Course outlines",
  origins: ["https://outline.uwaterloo.ca"],
  intervalMinutes: 1440,
  syncOnTabOpen: false,

  /**
   * @param {import("../../core/contract.js").SyncContext} ctx
   * @returns {Promise<SyncResult>}
   */
  async sync(ctx) {
    const settings = ctx.settings || {};
    const urls = new Set(
      [
        ...(settings.urls || []),
        ...(ctx.courses || []).map((c) => c.outlineUrl).filter(Boolean),
      ].map((u) => String(u).trim()).filter(Boolean),
    );
    const files = settings.files || [];

    /** Successfully parsed outlines, in URL-then-file order. */
    const parsed = [];
    let complete = true;

    for (const url of urls) {
      try {
        const res = await ctx.fetch(url, { headers: { Accept: "text/html" } });
        if (!(res.status >= 200 && res.status < 300) || !res.text) {
          complete = false;
          ctx.log(`outline: fetch ${url} -> ${res.status}`);
          continue;
        }
        const data = await ctx.parseHtml(res.text, "outline/parseOutline");
        if (!data) {
          complete = false;
          ctx.log(`outline: ${url} is not a course outline`);
          continue;
        }
        parsed.push({ data, url });
      } catch (e) {
        complete = false;
        ctx.log(`outline: fetch ${url} failed (${e && /** @type {any} */ (e).message})`);
      }
    }
    for (const file of files) {
      try {
        const data = await ctx.parseHtml(String(file.html || ""), "outline/parseOutline");
        if (!data) {
          complete = false;
          ctx.log(`outline: file ${file.name} is not a course outline`);
          continue;
        }
        parsed.push({ data, url: undefined });
      } catch (e) {
        complete = false;
        ctx.log(`outline: file ${file.name} failed to parse (${e && /** @type {any} */ (e).message})`);
      }
    }

    // Reading weeks: the union over all outlines, plus declared term breaks.
    const textDates = ctx.textDates || extractDates;
    const readingWeeks = [];
    const rwSeen = new Set();
    const pushWeek = (range) => {
      const [a, b] = range;
      const k = `${a}|${b}`;
      if (a && b && !rwSeen.has(k)) {
        rwSeen.add(k);
        readingWeeks.push([a.slice(0, 10), b.slice(0, 10)]);
      }
    };
    for (const { data } of parsed) for (const r of readingWeeksOf(data, { now: ctx.now, textDates })) pushWeek(r);
    for (const t of ctx.terms || []) {
      if (t.readingWeek && t.readingWeek.start && t.readingWeek.end) pushWeek([t.readingWeek.start, t.readingWeek.end]);
    }

    const items = [];
    const courses = [];
    const readOk = [];
    const seenCodes = new Set();
    for (const { data, url } of parsed) {
      const code = normCourseCode(data.code || "");
      if (!code || seenCodes.has(code)) continue; // first (URL) copy wins
      seenCodes.add(code);
      const ctxCourse = (ctx.courses || []).find((c) => normCourseCode(c.code) === code);
      const sections = [
        ...new Set([...((settings.sections || {})[code] || []), ...((ctxCourse && ctxCourse.sections) || [])]),
      ];
      if (!sections.length) ctx.log(`outline: ${code} has no selected sections; classes skipped`);
      try {
        const built = buildOutline(data, {
          now: ctx.now,
          url,
          sections,
          group: (settings.groups || {})[code] ?? null,
          officeHours: !!settings.officeHours,
          readingWeeks,
          textDates,
        });
        items.push(...built.items);
        courses.push(built.course);
        readOk.push(code);
      } catch (e) {
        complete = false;
        ctx.log(`outline: ${code} failed to expand (${e && /** @type {any} */ (e).message})`);
      }
    }
    return { items, courses, complete, readOk };
  },
};

export default adapter;
