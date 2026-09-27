// @ts-check
/*
  Course-outline adapter: outline.uwaterloo.ca pages (or offline files in
  settings) -> classes, exams, deadlines and office hours. All DOM work happens
  in the offscreen document via ctx.parseHtml(html, "outline/parseOutline");
  expansion is the pure buildOutline() in expand.js.

  outline.uwaterloo.ca sits behind UW SSO, so reads use two tiers: T1 ctx.fetch
  (works while the SSO cookie is valid), then T2 ctx.relay through an open
  outline tab. The content script also sends passive DOM snapshots (T3 observe).
*/

import { normCourseCode } from "../../core/contract.js";
import { extractDates } from "../../lib/textdates/index.js";
import { buildOutline, readingWeeksOf } from "./expand.js";
import { parseSyllabusText } from "./syllabus.js";

/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */
/** @typedef {import("../../core/contract.js").FetchResult} FetchResult */
/** @typedef {import("../../core/contract.js").SyncContext} SyncContext */
/** @typedef {import("../../core/contract.js").Adapter} Adapter */

const ORIGIN = "https://outline.uwaterloo.ca";
const LOGIN_WORDS = /duo|shibboleth|saml|oidc|adfs|idp\.uwaterloo|sign[ -]?in|log[ -]?in/i;

/** True when a FetchResult looks like an SSO login shell, not an outline. */
export function isLoginShell(res) {
  if (!res) return false;
  if (res.loginRedirect) return true;
  try {
    if (res.url && new URL(res.url).hostname !== "outline.uwaterloo.ca") return true;
  } catch {
    /* odd URL — judge by body */
  }
  return res.status >= 200 && res.status < 300 && !!res.text && LOGIN_WORDS.test(res.text);
}

const urlOf = (u) => {
  try {
    return new URL(u);
  } catch {
    return null;
  }
};

const errMsg = (e) => (e && /** @type {any} */ (e).message) || e;

/** Reading-week union: every parsed outline's own marks, plus term breaks. */
function readingWeeksFor(ctx, datas) {
  const textDates = ctx.textDates || extractDates;
  /** @type {[string, string][]} */
  const out = [];
  const seen = new Set();
  const push = (r) => {
    const k = `${r[0]}|${r[1]}`;
    if (r[0] && r[1] && !seen.has(k)) {
      seen.add(k);
      out.push([String(r[0]).slice(0, 10), String(r[1]).slice(0, 10)]);
    }
  };
  for (const data of datas) for (const r of readingWeeksOf(data, { now: ctx.now, textDates })) push(r);
  for (const t of ctx.terms || []) {
    if (t.readingWeek && t.readingWeek.start && t.readingWeek.end) push([t.readingWeek.start, t.readingWeek.end]);
  }
  return out;
}

/** Settings ∪ ctx.courses section/group/OH choice, then expand. Shared by sync and observe. */
function buildFor(ctx, data, url, readingWeeks) {
  const settings = ctx.settings || {};
  const code = normCourseCode(data.code || "");
  const ctxCourse = (ctx.courses || []).find((c) => normCourseCode(c.code) === code);
  const sections = [
    ...new Set([...((settings.sections || {})[code] || []), ...((ctxCourse && ctxCourse.sections) || [])]),
  ];
  if (!sections.length) ctx.log(`outline: ${code} has no selected sections; classes skipped`);
  return buildOutline(data, {
    now: ctx.now,
    url,
    sections,
    group: (settings.groups || {})[code] ?? null,
    officeHours: !!settings.officeHours,
    readingWeeks,
    textDates: ctx.textDates || extractDates,
  });
}

/** 2xx + body + parseOutline returning data with a code. */
async function readResult(ctx, res) {
  if (!res || !(res.status >= 200 && res.status < 300) || !res.text) return null;
  const data = await ctx.parseHtml(res.text, "outline/parseOutline");
  return data && data.code ? data : null;
}

/** @type {Adapter} */
const adapter = {
  id: "outline",
  label: "Course outlines",
  origins: [ORIGIN],
  intervalMinutes: 1440,
  syncOnTabOpen: false,

  observe: {
    urlPatterns: ["^https://outline\\.uwaterloo\\.ca/viewer/view/"],
    /**
     * @param {import("../../core/contract.js").ObservedPayload} payload
     * @param {SyncContext} ctx
     */
    async parse(payload, ctx) {
      const state = ctx.state || {};
      const data = await ctx.parseHtml(payload.body, "outline/parseOutline");
      if (!data || !data.code) return { items: [], complete: false, scope: "outline:none", state };
      // A partial snapshot (mid-render body, truncated DOM) has a header but
      // no schedule/schemes/tables — don't expand it.
      if (!(data.schedule?.length || data.schemes?.length || data.tables?.length)) {
        return { items: [], complete: false, scope: "outline:none", state };
      }
      const code = normCourseCode(data.code);
      const { items, course } = buildFor(ctx, data, payload.url, readingWeeksFor(ctx, [data]));
      // Scope-mode merges replace `courses` wholesale — carry every outline
      // course seen so far, not just this one.
      const courseMap = { ...(state.courses || {}), [code]: course };
      return {
        items,
        courses: Object.values(courseMap),
        complete: true,
        readOk: [code],
        scope: code,
        session: "signed-in",
        state: { ...state, seenUrls: { ...(state.seenUrls || {}), [code]: payload.url }, courses: courseMap },
      };
    },
  },

  /**
   * @param {SyncContext} ctx
   * @returns {Promise<SyncResult>}
   */
  async sync(ctx) {
    const settings = ctx.settings || {};
    const state = ctx.state || {};
    const urls = new Set(
      [
        ...(settings.urls || []),
        ...(ctx.courses || []).map((c) => c.outlineUrl).filter(Boolean),
        ...Object.values(state.seenUrls || {}),
      ].map((u) => String(u).trim()).filter(Boolean),
    );
    const files = settings.files || [];

    /** Successfully parsed outlines, in URL-then-file order. */
    const parsed = [];
    let complete = true;
    let sawShell = false;
    let urlOk = false;

    for (const url of urls) {
      let data = null;
      try {
        const res = await ctx.fetch(url, { headers: { Accept: "text/html" } });
        if (res && isLoginShell(res)) sawShell = true;
        data = await readResult(ctx, res);
      } catch (e) {
        ctx.log(`outline: fetch ${url} failed (${errMsg(e)})`);
      }
      const u = urlOf(url);
      if (!data && u && u.hostname === "outline.uwaterloo.ca" && typeof ctx.relay === "function") {
        try {
          const res = await ctx.relay(ORIGIN, u.pathname + u.search);
          if (res && isLoginShell(res)) sawShell = true;
          data = await readResult(ctx, res);
        } catch (e) {
          ctx.log(`outline: relay ${url} failed (${errMsg(e)})`);
        }
      }
      if (!data) {
        complete = false;
        ctx.log(`outline: ${url} unreadable`);
        continue;
      }
      urlOk = true;
      parsed.push({ data, url });
    }
    /** Syllabus ({name, text}) results — already expanded, bypass buildFor. */
    const direct = [];
    for (const file of files) {
      try {
        if (typeof file.text === "string") {
          const probe = parseSyllabusText(file.text, { now: ctx.now });
          if (!probe) {
            complete = false;
            ctx.log(`outline: file ${file.name} is not a syllabus text`);
            continue;
          }
          const sections = (settings.sections || {})[probe.code] || [];
          const r =
            (sections.length &&
              parseSyllabusText(file.text, { now: ctx.now, sections, officeHours: !!settings.officeHours })) ||
            probe;
          if (r.skippedClasses) ctx.log(`outline: ${r.code} syllabus classes skipped (section not selected)`);
          direct.push({ ...r, code: normCourseCode(r.code) });
          continue;
        }
        const data = await ctx.parseHtml(String(file.html || ""), "outline/parseOutline");
        if (!data || !data.code) {
          complete = false;
          ctx.log(`outline: file ${file.name} is not a course outline`);
          continue;
        }
        parsed.push({ data, url: undefined });
      } catch (e) {
        complete = false;
        ctx.log(`outline: file ${file.name} failed to parse (${errMsg(e)})`);
      }
    }

    const readingWeeks = readingWeeksFor(ctx, parsed.map((p) => p.data));

    const items = [];
    /** @type {Record<string, any>} — sync owns the whole map, observe patches it. */
    const courseMap = {};
    const readOk = [];
    const seenCodes = new Set();
    const seenUrls = { ...(state.seenUrls || {}) };
    for (const { data, url } of parsed) {
      const code = normCourseCode(data.code || "");
      if (!code || seenCodes.has(code)) continue; // first (URL) copy wins
      seenCodes.add(code);
      try {
        const built = buildFor(ctx, data, url, readingWeeks);
        items.push(...built.items);
        courseMap[code] = built.course;
        readOk.push(code);
        if (url) seenUrls[code] = url;
      } catch (e) {
        complete = false;
        ctx.log(`outline: ${code} failed to expand (${errMsg(e)})`);
      }
    }
    for (const r of direct) {
      if (!r.code || seenCodes.has(r.code)) continue;
      seenCodes.add(r.code);
      items.push(...r.items);
      courseMap[r.code] = r.course;
      readOk.push(r.code);
    }
    const courses = Object.values(courseMap);
    /** @type {SyncResult} */
    const result = { items, courses, complete, readOk, state: { ...state, seenUrls, courses: courseMap } };
    if (urlOk) result.session = "signed-in";
    else if (sawShell) result.session = "signed-out";
    return result;
  },
};

export default adapter;
