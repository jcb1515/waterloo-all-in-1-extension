// @ts-check
/*
  Pure to-do tab model: buildTodos() folds deadline-like source items and the
  derived `todos` map into grouped, filterable rows; each row carries its
  auto-completion rule for the "Auto" badge and done-reason line.
  No DOM, no chrome.*.
*/

import { effectiveItem, isVisible } from "../../core/effective.js";
import { autoDoneRule, todoSourceItem } from "../../core/todos.js";
import { orgsCompatible, titleSimilarity } from "../../core/merge.js";
import { normCourseCode } from "../../core/contract.js";
import { projectById } from "../../core/projects.js";
import { startOfDay, fmtAgo, fmtDay, fmtTime } from "./agenda.js";

const DAY = 86400000;
const DONE_KEEP_MS = 7 * DAY;
/** Study to-dos opening within this window earn a "Starting soon" line. */
const SOON_OPEN_MS = 3 * DAY;

/** A pinned event/meeting anchors on its start time, not a due guess. */
const anchorOf = (/** @type {any} */ i) =>
  i && i.todoPin === true && i.startAt ? i.startAt : (i && (i.dueAt || i.startAt)) || null;

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
 * The shared per-item listing decision for the To-do tab — buildTodos and
 * the item sheet's todoState both run it so they can never disagree.
 *
 * Returns a gate object:
 *   check(raw, isDerived, usOverride?) -> row descriptor or null:
 *     {eff, us, opensAt}                 a listed row
 *     {eff, us, opensAt, soon, openMs}   a study to-do that hasn't opened yet
 *     null                               not on the to-do list
 *
 * Gate order: an explicit pin (us.todo === true, carried as eff.todoPin)
 * bypasses the derived-row suppression and the pending/dismissed
 * visibility check — hidden and snooze still apply. Then the usual gates:
 * suppression by a linked derived row or a same-action derived to-do,
 * archived projects, study opensAt, todoSourceItem, visibility, cancelled.
 * Last, a listed source row without meta.action is suppressed when a
 * listed action row covers the same thing — same evidence.url, or anchors
 * within a day plus a matching title (>= 0.5) or compatible employer/org.
 * The action row wins; a pin beats suppression.
 * @param {Object} p
 * @param {Record<string, any>} [p.items]   merged items map
 * @param {Record<string, any>} [p.todos]   derived to-dos map
 * @param {Record<string, any>} [p.userState]
 * @param {any} [p.settings]
 * @param {any[]} [p.projects]
 * @param {Date} [p.now]
 */
export function todoRowGate({ items = {}, todos = {}, userState = {}, settings = {}, projects = [], now = new Date() } = {}) {
  const acceptPending = !!(settings.review && settings.review.showPending);
  const nowMs = now.getTime();

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

  // A source item with meta.action X is suppressed when a derived to-do
  // carries the same action for a compatible employer/org (meta.employer ||
  // org, both sides) and a due date within a week — the derived row owns
  // the done logic. If either side has no date, action + employer suffice;
  // if either side has no employer, action + date suffice.
  const derivedActions = Object.values(todos)
    .filter((t) => t && t.meta && t.meta.auto && typeof t.meta.action === "string")
    .map((t) => {
      const a = anchorOf(t);
      const ms = a ? Date.parse(a) : NaN;
      return {
        action: /** @type {string} */ (t.meta.action),
        who: (t.meta && t.meta.employer) || t.org || null,
        ms: Number.isNaN(ms) ? null : ms,
      };
    });
  const suppressedByAction = (/** @type {any} */ raw) => {
    const m = raw.meta;
    if (!m || typeof m.action !== "string" || !m.action) return false;
    const who = m.employer || raw.org || null;
    const a = anchorOf(raw);
    const ms = a ? Date.parse(a) : NaN;
    const rawMs = Number.isNaN(ms) ? null : ms;
    return derivedActions.some((d) => {
      if (d.action !== m.action) return false;
      if (d.who && who && !orgsCompatible(who, d.who)) return false;
      if (d.ms != null && rawMs != null && Math.abs(d.ms - rawMs) > 7 * DAY) return false;
      return true;
    });
  };

  /* Phase 1: every gate except the action-row-vs-plain-row seam below.
     Returns {eff, us, opensAt} | {…, soon: true, openMs} | null. */
  const phase1 = (/** @type {any} */ raw, /** @type {boolean} */ isDerived, /** @type {any} */ usO = undefined) => {
    if (!raw || !raw.id) return null;
    const us = usO !== undefined ? usO : userState[raw.id];
    const pinned = !!(us && us.todo === true);
    if (!isDerived && !pinned && (suppressed.has(raw.id) || suppressedByAction(raw))) return null;
    const project =
      raw.meta && raw.meta.projectId ? projectById(projects, raw.meta.projectId) : null;
    if (project && project.status !== "active") return null; // done/archived projects hide their items
    const eff = effectiveItem(raw, us, { acceptPending });
    const auto = eff.meta && eff.meta.auto;
    // Study to-dos stay hidden until their opensAt (user-overridable).
    const opensAt = auto === "study" ? eff.opensAt || raw.opensAt : null;
    const openMs = opensAt ? Date.parse(opensAt) : null;
    if (openMs && openMs > nowMs) return { eff, us, opensAt, openMs, soon: true };
    if (!todoSourceItem(eff, settings)) return null;
    if (pinned) {
      // A pin skips the review pending/dismissed gate; hidden and snooze
      // still apply.
      if (eff.hidden) return null;
      const sn = eff.snoozedUntil;
      if (sn && Date.parse(sn) > nowMs) return null;
    } else if (!isVisible(eff, nowMs)) {
      return null;
    }
    if (eff.status === "cancelled") return null;
    return { eff, us, opensAt };
  };

  /* The action rows that made the list — meta.action seams like an
     email's "fill in this form" task or a WW apply/book to-do. They shadow
     a plain sibling row that describes the same thing. */
  /** @type {any[]} */
  const actionRows = [];
  const collectAction = (/** @type {any} */ raw, /** @type {boolean} */ isDerived) => {
    const r = phase1(raw, isDerived);
    if (r && !r.soon && r.eff.meta && r.eff.meta.action) actionRows.push(r.eff);
  };
  for (const raw of Object.values(items)) collectAction(raw, false);
  for (const raw of Object.values(todos)) collectAction(raw, true);

  const srcSet = (/** @type {any} */ it) => {
    const s = new Set();
    if (it.source) s.add(it.source);
    for (const e of Array.isArray(it.seenIn) ? it.seenIn : []) {
      const id = e && typeof e === "object" ? e.source : e;
      if (id) s.add(id);
    }
    return s;
  };

  /** Does a listed action row cover this non-action row? */
  const coveredByActionRow = (/** @type {any} */ eff) => {
    const srcs = srcSet(eff);
    const evUrl = eff.evidence && eff.evidence.url;
    const a = anchorOf(eff);
    const aMs = a ? Date.parse(a) : NaN;
    const who = (eff.meta && eff.meta.employer) || eff.org || null;
    return actionRows.some((ar) => {
      let overlap = false;
      for (const s of srcSet(ar)) {
        if (srcs.has(s)) {
          overlap = true;
          break;
        }
      }
      if (!overlap) return false;
      const aUrl = ar.evidence && ar.evidence.url;
      if (evUrl && aUrl && evUrl === aUrl) return true;
      const b = anchorOf(ar);
      const bMs = b ? Date.parse(b) : NaN;
      if (Number.isNaN(aMs) || Number.isNaN(bMs)) return false;
      if (Math.abs(aMs - bMs) > DAY) return false;
      const aWho = (ar.meta && ar.meta.employer) || ar.org || null;
      return (
        titleSimilarity(eff.title, eff.org, ar.title, ar.org) >= 0.5 ||
        orgsCompatible(who, aWho)
      );
    });
  };

  const check = (/** @type {any} */ raw, /** @type {boolean} */ isDerived, /** @type {any} */ usO = undefined) => {
    const r = phase1(raw, isDerived, usO);
    if (!r || r.soon) return r;
    const pinned = r.eff.todoPin === true;
    const hasAction = !!(r.eff.meta && r.eff.meta.action);
    if (!isDerived && !pinned && !hasAction && coveredByActionRow(r.eff)) return null;
    return r;
  };
  return { check, phase1 };
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

  const gate = todoRowGate({ items, todos, userState, settings, projects, now });

  const collect = (/** @type {any} */ raw, /** @type {boolean} */ isDerived) => {
    const r = gate.check(raw, isDerived);
    if (!r) return;
    const { eff, us, opensAt } = r;
    if (r.soon) {
      // A study to-do opening soon still earns a "Starting soon" line.
      if (r.openMs - nowMs <= SOON_OPEN_MS && isVisible(eff, nowMs) && eff.status !== "cancelled") {
        startingSoon.push({ id: eff.id, title: eff.title, opensAt });
      }
      return;
    }

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
