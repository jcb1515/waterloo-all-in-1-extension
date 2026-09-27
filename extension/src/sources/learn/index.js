// @ts-check
/*
  Learn adapter on the shared contract. Wraps WATnow's LiveSource: the worker
  fetch (T1, ctx.fetch) is injected as its transport and the tab relay (T2,
  ctx.relay) as its relay, so session detection and every read keep their
  WATnow behaviour. On top of the deadline list it adds announcement text
  extraction (textdates), grade weights, the content TOC (outline/syllabus
  links), discussion-post and quiz-attempt checks.
*/

import { itemId, normCourseCode } from "../../core/contract.js";
import { extractDates, termCodeFor } from "../../lib/textdates/index.js";
import { classify, isDueish, TRIGGER_RE } from "./classify.js";
import { cleanEventTitle, LiveSource, liveBase } from "./live-source.js";

/** @typedef {import("../../core/contract.js").FetchResult} FetchResult */
/** @typedef {import("../../core/contract.js").Item} Item */
/** @typedef {import("../../core/contract.js").SyncContext} SyncContext */
/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */

/** Course plus the Learn extras the contract does not have yet (asked of W1). @see README */
/** @typedef {import("../../core/contract.js").Course & {grades?: object[], syllabusUrls?: {title: string, url: string}[]}} LearnCourse */

/** A short reason for a thrown WATnow error: its code, else its message. @param {unknown} e */
const errReason = (e) => {
  const x = /** @type {{code?: unknown, message?: unknown} | null} */ (e);
  return String((x && (x.code || x.message)) || e);
};

/** @param {unknown} e */
const isSignedOut = (e) => /** @type {{code?: string} | null} */ (e)?.code === "signed-out";

const DAY_MS = 24 * 60 * 60 * 1000;
const NEWS_WINDOW_MS = 60 * DAY_MS;
const POSTS_LOOKBACK_MS = 14 * DAY_MS;
const POSTS_LOOKAHEAD_MS = 30 * DAY_MS;
const TOOL_SCOPES = ["dropbox", "quizzes", "discussions", "feed", "calendar"];

/**
 * A contract FetchResult -> LiveSource's fetch result shape.
 * @param {FetchResult | undefined | null} r
 */
function toLive(r) {
  if (!r || typeof r !== "object") return { status: 0, error: "no response" };
  const out = {
    status: Number(r.status) || 0,
    loginRedirect: !!r.loginRedirect,
    type: String(r.contentType || ""),
  };
  if (r.noTab) out.noTab = true;
  if (r.url) out.url = r.url;
  if (r.error) out.error = String(r.error);
  if (out.status >= 200 && out.status < 300 && out.type.includes("json")) {
    try {
      out.json = JSON.parse(String(r.text || "null"));
    } catch (e) {
      out.parseError = String(e instanceof Error ? e.message : e);
    }
  } else if (!(out.status >= 200 && out.status < 300) && !out.loginRedirect) {
    out.body = String(r.text || "").slice(0, 2000);
  }
  return out;
}

/** The sentence a date hit sits in: text up to the nearest . ! ? or newline on each side. */
function sentenceOf(text, index, length) {
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (".!?\n".includes(text[i])) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = index + length; i < text.length; i++) {
    if (".!?\n".includes(text[i])) {
      end = i + 1;
      break;
    }
  }
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** A normalised title for grade matching: case/spacing-insensitive, Learn decorations off. */
function normName(title) {
  return cleanEventTitle(String(title || "")).toLowerCase().replace(/\s+/g, " ").trim();
}

/** @param {import("../../core/contract.js").Adapter} adapter */
const _typecheck = (adapter) => adapter;

/** @type {import("../../core/contract.js").Adapter} */
const adapter = {
  id: "learn",
  label: "Learn",
  origins: ["https://learn.uwaterloo.ca"],
  intervalMinutes: 30,
  syncOnTabOpen: true,

  /** @param {SyncContext} ctx @returns {Promise<SyncResult>} */
  async sync(ctx) {
    const now = ctx.now instanceof Date ? ctx.now : new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const base = liveBase(ctx.settings || {});
    const textDates = ctx.textDates || extractDates;
    const headers = { Accept: "application/json" };
    const transport = async (path) => toLive(await ctx.fetch(base + path, { headers }));
    const relay = async (_base, path) => toLive(await ctx.relay(base, path, { headers }));
    const src = new LiveSource(ctx.settings || {}, { transport, relay, now });
    if (ctx.state && ctx.state.versions) src.versions = ctx.state.versions;

    /** @type {Item[]} */
    const items = [];
    /** @type {LearnCourse[]} */
    const courses = [];
    const readOk = [];
    let complete = true;

    const inWindow = (iso) => {
      const t = Date.parse(iso || "");
      return !Number.isNaN(t) && t >= nowMs - POSTS_LOOKBACK_MS && t <= nowMs + POSTS_LOOKAHEAD_MS;
    };

    try {
      const session = await src.checkSession();
      if (!session.signedIn) {
        const reason = session.reason || "unreachable";
        return {
          items: [],
          complete: false,
          session: /** @type {"signed-out"|"no-tab"|"unreachable"} */ (reason),
          error: { code: reason, message: `Learn session check failed: ${reason}` },
        };
      }

      for (const course of await src.listCourses()) {
        const ou = course.orgUnitId;
        /** @type {any[]} */
        let rows;
        try {
          rows = await src.listDeadlines(course);
        } catch (e) {
          if (isSignedOut(e)) throw e;
          complete = false;
          ctx.log(`learn: ${course.code}: ${errReason(e)}`);
          continue;
        }
        if (course.current === false) {
          const kept = src.keepTermless(course, rows);
          if (!kept) {
            ctx.log(`learn: ${course.code}: dropped (no term, nothing upcoming)`);
            continue;
          }
          rows = kept;
        }

        const okSet = src.readOk.get(course.id) || new Set();
        for (const scope of okSet) readOk.push(`${ou}:${scope}`);
        if (!TOOL_SCOPES.every((scope) => okSet.has(scope))) complete = false;
        const termCode = course.term ?? termCodeFor(now);

        // WATnow deadlines -> contract items.
        /** @type {{row: any, item: Item}[]} */
        const pairs = [];
        for (const row of rows) {
          const cls = classify({ title: row.title, kind: row.kind, category: row.category });
          /** @type {Item} */
          const item = {
            id: itemId("learn", row.id),
            source: "learn",
            type: /** @type {Item["type"]} */ (cls.type),
            title: row.title,
            org: course.code,
            status: row.status === "submitted" ? "submitted" : "open",
            confidence: "exact",
            review: "auto",
            seenIn: (row.seenIn || []).map((scope) => ({
              source: "learn",
              key: row.id,
              scope: `${ou}:${scope}`,
              at: nowIso,
            })),
            meta: {
              orgUnitId: ou,
              kind: row.kind,
              dueField: row.dueField,
              listUrl: row.listUrl,
              completedAt: row.completedAt || undefined,
              groupFolder: row.groupFolder || undefined,
            },
          };
          if (cls.category) item.category = cls.category;
          if (row.url) item.url = row.url;
          if (row.opensAt) item.opensAt = row.opensAt;
          if (row.startAt) {
            item.startAt = row.startAt;
            if (row.endAt) item.endAt = row.endAt;
            item.allDay = !!row.allDay;
          }
          // A plain calendar event (no tool behind it) that reads like an exam
          // or presentation is a timed thing, not a deadline: start/end only.
          const plainEvent = row.dueField === "event" && row.startAt;
          if (!(plainEvent && (item.type === "exam" || item.type === "presentation"))) item.dueAt = row.dueAt;
          pairs.push({ row, item });
          items.push(item);
        }

        // Discussion posts: an open topic the student already posted in counts
        // as submitted. Quiz attempts: same for a finished quiz. Both fail soft
        // (Learn often answers 403 for attempts; readQuizAttempts stops asking
        // after the first one).
        for (const { row, item } of pairs) {
          if (item.status !== "open" || !inWindow(row.dueAt)) continue;
          const sourceId = String(row.id).split(":").slice(2).join(":");
          try {
            if (row.kind === "discussion" && row.forumId && src.userId) {
              if (await src.readTopicPosts(course, row.forumId, sourceId, src.userId)) item.status = "submitted";
            } else if (row.kind === "quiz") {
              const at = await src.readQuizAttempts(course, sourceId);
              if (at) {
                item.status = "submitted";
                item.meta = { ...item.meta, completedAt: at };
              }
            }
          } catch (e) {
            if (isSignedOut(e)) throw e;
            ctx.log(`learn: ${course.code} ${row.kind} check: ${errReason(e)}`);
          }
        }

        // Announcements: run the shared text-date pass over "title. text" and
        // keep confident hits in trigger sentences as pending-review items.
        try {
          const news = await src.readNews(course);
          readOk.push(`${ou}:news`);
          for (const n of news) {
            const atMs = Date.parse(n.at || "");
            if (Number.isNaN(atMs) || atMs < nowMs - NEWS_WINDOW_MS) continue;
            const full = `${n.title}. ${n.text}`;
            for (const hit of textDates(full, { now, termCode })) {
              if (hit.confidence < 0.5 || Date.parse(hit.startAt) < nowMs - DAY_MS) continue;
              const sentence = sentenceOf(full, hit.index, hit.text.length);
              if (!TRIGGER_RE.test(sentence)) continue;
              const cls = classify({ title: sentence });
              const type = cls.type === "deadline" ? (isDueish(sentence) ? "deadline" : "event") : cls.type;
              /** @type {Item} */
              const item = {
                // VERIFY: Learn news deep-link shape (the per-item view URL).
                id: itemId("learn", `${ou}:news:${n.id}:${hit.startAt}`),
                source: "learn",
                type: /** @type {Item["type"]} */ (type),
                title: String(n.title).slice(0, 120),
                org: course.code,
                status: "open",
                confidence: "tentative",
                review: "pending",
                seenIn: [{ source: "learn", key: `${ou}:news:${n.id}:${hit.startAt}`, scope: `${ou}:news`, at: nowIso }],
                evidence: {
                  snippet: sentence,
                  url: `${base}/d2l/le/news/${ou}/${n.id}/view`,
                  method: "text",
                },
                meta: { orgUnitId: ou, newsId: n.id, weekdayMismatch: hit.weekdayMismatch || undefined },
              };
              if (cls.category) item.category = cls.category;
              if (type === "deadline") {
                item.dueAt = hit.startAt;
                item.allDay = hit.allDay;
              } else {
                item.startAt = hit.startAt;
                if (hit.endAt) item.endAt = hit.endAt;
                item.allDay = hit.allDay;
              }
              items.push(item);
              pairs.push({ row: { kind: "news" }, item });
            }
          }
        } catch (e) {
          if (isSignedOut(e)) throw e;
          complete = false;
          ctx.log(`learn: ${course.code} news: ${errReason(e)}`);
        }

        // Grades: objects + categories + the student's own values. Each read is
        // fail-soft inside readGrades; ok is true only when all three answered.
        let grades = /** @type {{objects: any[], categories: any[], values: any[], ok: boolean}} */ ({
          objects: [],
          categories: [],
          values: [],
          ok: false,
        });
        try {
          grades = await src.readGrades(course);
          if (!grades.ok) complete = false;
          else readOk.push(`${ou}:grades`);
        } catch (e) {
          if (isSignedOut(e)) throw e;
          complete = false;
          ctx.log(`learn: ${course.code} grades: ${errReason(e)}`);
        }

        // Content TOC: outline links and syllabus PDFs, walked recursively.
        let toc = { outlineUrls: /** @type {string[]} */ ([]), syllabusUrls: /** @type {{title: string, url: string}[]} */ ([]) };
        try {
          toc = await src.readToc(course);
          readOk.push(`${ou}:toc`);
        } catch (e) {
          if (isSignedOut(e)) throw e;
          complete = false;
          ctx.log(`learn: ${course.code} toc: ${errReason(e)}`);
        }

        const objectById = new Map();
        for (const o of grades.objects) if (o && o.Id != null) objectById.set(String(o.Id), o);
        const catNameById = new Map();
        for (const c of grades.categories) {
          if (c && (c.CategoryId ?? c.Id) != null) catNameById.set(String(c.CategoryId ?? c.Id), String(c.Name || ""));
        }

        const courseGrades = [];
        for (const v of grades.values) {
          if (!v) continue;
          const obj = objectById.get(String(v.GradeObjectId ?? v.GradeItemId ?? ""));
          const component = String((obj && obj.Name) || v.GradeObjectName || v.Name || "");
          const entry = { component };
          const catName = obj && catNameById.get(String(obj.CategoryId));
          if (catName) entry.category = catName;
          if (typeof v.PointsNumerator === "number") entry.points = v.PointsNumerator;
          if (typeof v.PointsDenominator === "number") entry.max = v.PointsDenominator;
          if (typeof v.WeightedDenominator === "number") entry.weight = v.WeightedDenominator;
          if (v.DisplayedGrade != null) entry.display = String(v.DisplayedGrade);
          courseGrades.push(entry);
          if (typeof v.WeightedDenominator !== "number" || v.WeightedDenominator <= 0) continue;
          // VERIFY: whether folders/quizzes carry the grade object id as
          // GradeItemId, and objects link back via AssociatedToolItemId.
          const toolId = obj && (obj.AssociatedToolItemId ?? obj.GradeItemId);
          let target = toolId != null
            ? pairs.find((p) => String(p.item.id).split(":").slice(3).join(":") === String(toolId))
            : null;
          if (!target && component) {
            const want = normName(component);
            target = pairs.find((p) => normName(p.item.title) === want);
          }
          if (target) target.item.weight = v.WeightedDenominator;
        }

        let weights = grades.categories
          .filter((c) => c && typeof c.Weight === "number" && c.Weight > 0)
          .map((c) => ({ component: String(c.Name || ""), weight: c.Weight }));
        if (!weights.length) {
          weights = grades.objects
            .filter((o) => o && typeof o.Weight === "number" && o.Weight > 0)
            .map((o) => ({ component: String(o.Name || ""), weight: o.Weight }));
        }

        courses.push({
          code: normCourseCode(course.code),
          name: course.name || undefined,
          term: course.term ?? termCodeFor(now),
          learnOrgUnitId: ou,
          outlineUrl: toc.outlineUrls[0],
          weights,
          grades: courseGrades,
          syllabusUrls: toc.syllabusUrls,
        });
      }
    } catch (e) {
      if (isSignedOut(e)) {
        return { items: [], complete: false, session: "signed-out", error: { code: "signed-out", message: errReason(e) } };
      }
      return {
        items,
        courses,
        complete: false,
        readOk,
        session: "signed-in",
        state: { versions: src.versions },
        error: { code: (/** @type {{code?: string} | null} */ (e) || {}).code || "error", message: errReason(e) },
      };
    }

    return { items, courses, complete, readOk, session: "signed-in", state: { versions: src.versions } };
  },
};

export default _typecheck(adapter);
