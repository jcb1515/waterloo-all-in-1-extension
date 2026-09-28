// @ts-check
/*
  Pure to-do tab model: buildTodos() folds deadline-like source items and the
  derived `todos` map into grouped, filterable rows; each row carries its
  auto-completion rule for the "Auto" badge and done-reason line.
  No DOM, no chrome.*.
*/

import { effectiveItem, isVisible } from "../../core/effective.js";
import { autoDoneRule, todoSourceItem } from "../../core/todos.js";
import { normCourseCode } from "../../core/contract.js";
import { projectById } from "../../core/projects.js";
import { startOfDay, fmtAgo, fmtDay, fmtTime } from "./agenda.js";

const DAY = 86400000;
const DONE_KEEP_MS = 7 * DAY;
/** Study to-dos opening within this window earn a "Starting soon" line. */
const SOON_OPEN_MS = 3 * DAY;

const anchorOf = (/** @type {any} */ i) => i.dueAt || i.startAt || null;

const COURSE_CODE_RE = /^[A-Z]{2,8} ?\d{3}[A-Z]{0,2}$/;

/** meta.action values that belong to the co-op pipeline. */
const COOP_ACTIONS = new Set([
  "book-interview",
  "respond-offer",
  "submit-rankings",
  "apply",
]);

/** Row kind for the filter chips. */
function kindOf(/** @type {any} */ item) {
  const meta = item.meta || {};
  if (meta.auto === "study") return "study";
  if (meta.auto === "offer" || meta.auto === "rank") return "coop";
  if (meta.auto === "project" || meta.projectId || item.source === "projects") return "project";
  // Adapter action to-dos: replies are their own chip; co-op actions with an
  // employer live under Co-op; anything else falls through to the old rules
  // (a course-coded org still reads as a deadline).
  if (typeof meta.action === "string" && meta.action) {
    if (meta.action === "reply") return "reply";
    if (COOP_ACTIONS.has(meta.action) && meta.employer) return "coop";
  }
  if (item.category === "reply" || item.category === "book-call") return "reply";
  if (
    item.type === "application-deadline" ||
    item.type === "offer-deadline" ||
    item.category === "interview-timeslot"
  ) {
    return "coop";
  }
  if (item.source === "manual") return "task";
  if (item.source === "discord") return "team";
  return "deadline";
}

/** The "Auto" badge tooltip: "Completes when submitted on Learn". */
function autoTip(/** @type {any} */ item, /** @type {any} */ rule) {
  const cw = item.meta && item.meta.completesWhen;
  if (cw) return `Completes ${cw}`;
  if (rule && rule.reason) {
    const r = rule.reason;
    return `Completes when ${r[0].toLowerCase()}${r.slice(1)}`;
  }
  return null;
}

/**
 * @param {Object} p
 * @param {Record<string, any>} p.items  merged items map (state.items)
 * @param {Record<string, any>} p.todos  derived to-dos map (state.todos)
 * @param {Record<string, any>} p.applications
 * @param {Record<string, any>} p.userState
 * @param {any} p.settings
 * @param {any[]} [p.projects]          user projects (state.projects)
 * @param {Date} p.now
 * @param {string} [p.filter] all|school|coop|teams|projects|replies|mine
 * @returns {{groups: {id: string, label: string, rows: any[], done?: boolean,
 *   collapsedByDefault?: boolean, tone?: string}[],
 *   startingSoon: {id: string, title: string, opensAt: string}[],
 *   counts: Record<string, number>}}
 */
export function buildTodos({ items = {}, todos = {}, applications = {}, userState = {}, settings = {}, projects = [], now = new Date(), filter = "all" }) {
  const acceptPending = !!(settings.review && settings.review.showPending);
  const today = startOfDay(now);
  const tomorrow = today.getTime() + DAY;
  const weekEnd = today.getTime() + (7 - today.getDay()) * DAY; // Sun, next week
  const nowMs = now.getTime();

  /** @type {any[]} */
  const rows = [];
  /** @type {any[]} */
  const startingSoon = [];
  /** @type {Record<string, number>} */
  const counts = {};

  /* A derived to-do supersedes the source row it links — e.g. an offer
     to-do already carries the linked offer-deadline's due date, so listing
     both would show the same thing twice. Study to-dos never suppress:
     their parents (exams/quizzes) are their own deliverable. */
  const suppressed = new Set();
  for (const t of Object.values(todos)) {
    const m = t && t.meta;
    if (!m || m.auto === "study") continue;
    if (m.linkedItemId) suppressed.add(m.linkedItemId);
    if (m.parentId) suppressed.add(m.parentId);
  }

  // One rankings to-do per work term: an emailed/other-source
  // "submit-rankings" task within a week of a derived rank to-do's date is
  // the same ask — the derived row carries it.
  const rankDues = Object.values(todos)
    .filter((t) => t && t.meta && t.meta.auto === "rank")
    .map((t) => {
      const a = anchorOf(t);
      const ms = a ? Date.parse(a) : NaN;
      return Number.isNaN(ms) ? null : ms;
    })
    .filter((ms) => ms != null);
  const suppressedByRank = (/** @type {any} */ raw) => {
    if (!raw.meta || raw.meta.action !== "submit-rankings") return false;
    const a = anchorOf(raw);
    const ms = a ? Date.parse(a) : NaN;
    if (Number.isNaN(ms)) return false;
    return rankDues.some((d) => Math.abs(/** @type {number} */ (d) - ms) <= 7 * DAY);
  };

  const collect = (/** @type {any} */ raw, /** @type {boolean} */ isDerived) => {
    if (!raw || !raw.id) return;
    if (!isDerived && (suppressed.has(raw.id) || suppressedByRank(raw))) return;
    const project = raw.meta && raw.meta.projectId ? projectById(projects, raw.meta.projectId) : null;
    if (project && project.status !== "active") return; // done/archived projects hide their items
    const us = userState[raw.id];
    const eff = effectiveItem(raw, us, { acceptPending });
    const auto = eff.meta && eff.meta.auto;
    // Study to-dos stay hidden until their opensAt (user-overridable).
    const opensAt = auto === "study" ? eff.opensAt || raw.opensAt : null;
    const openMs = opensAt ? Date.parse(opensAt) : null;
    if (openMs && openMs > nowMs) {
      if (openMs - nowMs <= SOON_OPEN_MS && isVisible(eff, nowMs) && eff.status !== "cancelled") {
        startingSoon.push({ id: eff.id, title: eff.title, opensAt });
      }
      return;
    }
    if (!todoSourceItem(eff, settings)) return;
    if (!isVisible(eff, nowMs)) return;
    if (eff.status === "cancelled") return;

    const rule = autoDoneRule(raw, {
      applications,
      items,
      now,
      userState: us,
    });
    const done =
      !!eff.status && (eff.status === "done" || eff.status === "submitted") ||
      (rule ? rule.done : false);
    const a = anchorOf(eff);
    const aMs = a ? Date.parse(a) : null;
    const doneAt =
      (us && us.doneAt) ||
      (done && aMs ? a : (eff.meta && eff.meta.doneAt) || null);
    const kind = kindOf(eff);
    counts[kind === "study" ? "school" : kind] = (counts[kind === "study" ? "school" : kind] || 0) + 1;
    rows.push({
      item: eff,
      kind,
      done: !!done,
      doneReason: done
        ? us && us.done
          ? "Checked off"
          : (rule && rule.reason) || (eff.status === "submitted" ? "Submitted" : "Done")
        : null,
      doneAt: done ? doneAt : null,
      auto: rule ? autoTip(eff, rule) : null,
      opensAt,
      subtasks: us && Array.isArray(us.subtasks) ? us.subtasks.length : 0,
    });
  };

  for (const raw of Object.values(items)) collect(raw, false);
  for (const raw of Object.values(todos)) collect(raw, true);

  const inFilter = (/** @type {any} */ r) => {
    const it = r.item;
    switch (filter) {
      case "school":
        return r.kind === "study" || r.kind === "deadline" ||
          (r.kind === "task" && !!it.org && COURSE_CODE_RE.test(normCourseCode(it.org)));
      case "coop":
        return r.kind === "coop";
      case "teams":
        return it.source === "discord" || r.kind === "team";
      case "projects":
        return r.kind === "project";
      case "replies":
        return r.kind === "reply";
      case "mine":
        return it.source === "manual" && !(it.meta && it.meta.auto);
      default:
        return true;
    }
  };

  const shown = rows.filter(inFilter);
  const byAnchor = (a, b) => {
    const am = a.anchorMs || Infinity;
    const bm = b.anchorMs || Infinity;
    return am - bm || String(a.item.title).localeCompare(String(b.item.title));
  };
  for (const r of shown) r.anchorMs = anchorOf(r.item) ? Date.parse(anchorOf(r.item)) : null;

  const open = shown.filter((r) => !r.done).sort(byAnchor);
  const done = shown
    .filter((r) => r.done && (!r.doneAt || nowMs - Date.parse(r.doneAt) <= DONE_KEEP_MS))
    .sort((a, b) => Date.parse(b.doneAt || 0) - Date.parse(a.doneAt || 0));

  /** @type {any[]} */
  const groups = [];
  const bucket = (id, label, pred, opts = {}) => {
    const rs = open.filter(pred);
    if (!rs.length && !opts.always) return;
    groups.push({ id, label, rows: rs, tone: opts.tone || null, collapsedByDefault: !!opts.collapsed });
  };

  bucket("overdue", "Overdue", (r) => r.anchorMs != null && r.anchorMs < today.getTime(), { tone: "danger" });
  bucket("today", "Today", (r) => r.anchorMs != null && r.anchorMs >= today.getTime() && r.anchorMs < tomorrow);
  bucket("week", "This week", (r) => r.anchorMs != null && r.anchorMs >= tomorrow && r.anchorMs < weekEnd);
  bucket("later", "Later", (r) => r.anchorMs != null && r.anchorMs >= weekEnd);
  bucket("nodate", "No date", (r) => r.anchorMs == null);
  if (done.length) {
    groups.push({ id: "done", label: "Done", rows: done, done: true, collapsedByDefault: true });
  }

  startingSoon.sort((a, b) => Date.parse(a.opensAt) - Date.parse(b.opensAt));
  return { groups, startingSoon, counts };
}

/**
 * Done-row line: "Submitted on Learn · 2h ago".
 * @param {any} row @param {Date} now
 */
export function doneLine(row, now) {
  const reason = row.doneReason || "Done";
  const at = row.doneAt ? fmtAgo(row.doneAt, now) : null;
  return at ? `${reason} · ${at}` : reason;
}

/**
 * Due cell text for an open row: "Due Fri · 11:59 PM" or "2d late". An
 * item stamped meta.undated keeps its suggested-date bucket but the label
 * says the date is a guess, not a deadline.
 * @param {any} row @param {Date} now
 */
export function dueLabel(row, now) {
  const a = anchorOf(row.item);
  if (!a) return "No date";
  const ms = Date.parse(a);
  if (row.item.meta && row.item.meta.undated) {
    return `No due date · by ${fmtDay(ms)}`;
  }
  if (ms < now.getTime()) {
    const d = Math.round((now.getTime() - ms) / DAY);
    return d >= 1 ? `${d}d late` : "Due today";
  }
  return `${fmtDay(ms)} · ${row.item.allDay ? "All day" : fmtTime(ms)}`;
}
