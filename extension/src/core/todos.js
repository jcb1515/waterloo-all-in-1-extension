// @ts-check
/*
  Derived to-dos: contract-shaped task items the core creates and completes
  on its own — study prep for assessments, co-op offer/rankings actions.
  They are stored under the `todos` key (outside the merge engine's raws)
  and recomputed inside recomputeAll. Pure: no storage, no chrome.*.
*/

import { effectiveItem, isVisible } from "./effective.js";
import { titleSimilarity } from "./merge.js";

const DAY = 86400000;
/** A finished study to-do is kept (as done) this long, then dropped. */
const DONE_KEEP_MS = 2 * DAY;

const STUDY_TYPES = new Set(["quiz", "exam", "presentation"]);

/** Statuses where an application is mid-pipeline: interviewing or offered. */
const APP_IN_FLIGHT = new Set([
  "selected-for-interview",
  "interview-scheduled",
  "alternate",
  "offer",
]);

/** "Past offer" — WaterlooWorks has the student's answer. */
const APP_ANSWERED = new Set(["ranked", "matched", "declined", "withdrawn", "accepted"]);

const anchorMs = (item) => {
  const a = item && (item.dueAt || item.startAt);
  const ms = a ? Date.parse(a) : NaN;
  return Number.isNaN(ms) ? null : ms;
};

const todosSettings = (settings) => (settings && settings.todos) || {};

/**
 * Study lead days for a parent item: exam category (midterm/final) first,
 * then type; the "exam" key is the generic fallback.
 */
function leadDaysFor(parent, leads) {
  const l = leads || {};
  if (parent.type === "exam" && parent.category && l[parent.category] != null) {
    return l[parent.category];
  }
  return l[parent.type] != null ? l[parent.type] : l.exam != null ? l.exam : 5;
}

const examLabel = (p) =>
  p.type === "exam" ? (p.category === "midterm" ? "midterm" : p.category === "final" ? "final exam" : "exam") : p.type;

/**
 * A derived to-do item skeleton.
 * @returns {any} contract Item
 */
function todoItem(id, fields) {
  return {
    id,
    source: "manual",
    type: "task",
    status: "open",
    confidence: "exact",
    review: "auto",
    evidence: { method: "manual" },
    ...fields,
  };
}

/**
 * Recompute all derived to-dos.
 * @param {{items: Record<string, any>, applications: Record<string, any>,
 *   userState: Record<string, any>, settings: any, now: Date,
 *   prev?: Record<string, any>}} p   prev = previous todos map (keeps createdAt)
 * @returns {Record<string, any>} map id -> Item
 */
export function deriveTodos({ items = {}, applications = {}, userState = {}, settings = {}, now = new Date(), prev = {} }) {
  const cfg = todosSettings(settings);
  const t = now.getTime();
  /** @type {Record<string, any>} */
  const out = {};
  const firstAt = (id) => (prev && prev[id] && prev[id].meta && prev[id].meta.createdAt) || now.toISOString();

  /* ------------------------------- study ------------------------------- */
  const study = cfg.study || {};
  if (study.enabled !== false) {
    for (const raw of Object.values(items)) {
      if (!raw || !raw.id || !STUDY_TYPES.has(raw.type)) continue;
      const eff = effectiveItem(raw, userState[raw.id]);
      if (eff.status === "cancelled" || !isVisible(eff, now)) continue;
      const due = anchorMs(eff);
      if (!due) continue;
      const lead = Math.max(0, Number(leadDaysFor(raw, study.leadDays)) || 0) * DAY;
      const id = `todo:study:${raw.id}`;
      const label = examLabel(raw);
      const done = due <= t;
      if (done && due < t - DONE_KEEP_MS) continue; // keep done for 2 days, then drop
      const orgPre =
        raw.org && !String(raw.title).toLowerCase().startsWith(String(raw.org).toLowerCase())
          ? `${raw.org} `
          : "";
      out[id] = todoItem(id, {
        title:
          raw.type === "presentation"
            ? `Prepare ${orgPre}${raw.title}`
            : `Study for ${orgPre}${raw.title}`,
        org: raw.org,
        dueAt: eff.dueAt || eff.startAt,
        opensAt: new Date(due - lead).toISOString(),
        status: done ? "done" : "open",
        meta: {
          auto: "study",
          parentId: raw.id,
          parentLabel: label,
          leadDays: Math.round(lead / DAY),
          completesWhen: `after the ${label}`,
          createdAt: firstAt(id),
        },
      });
    }
  }

  /* -------------------------------- co-op ------------------------------ */
  if (cfg.coop !== false) {
    const apps = Object.values(applications || {}).filter((a) => a && a.id);

    // Offers: respond before the linked offer deadline.
    for (const app of apps) {
      if (app.status !== "offer" && !APP_ANSWERED.has(app.status)) continue;
      const id = `todo:offer:${app.id}`;
      if (APP_ANSWERED.has(app.status)) {
        const p = prev && prev[id];
        if (!p) continue; // answered before the to-do ever existed
        const at = appLastAt(app);
        if (at != null && at < t - DONE_KEEP_MS) continue;
        out[id] = { ...p, status: "done" };
        continue;
      }
      const deadlineItem = offerDeadlineItem(app, items);
      out[id] = todoItem(id, {
        title: `Respond to offer — ${app.employer}${app.jobTitle ? ` (${app.jobTitle})` : ""}`,
        org: app.employer || "Co-op",
        dueAt: deadlineItem ? deadlineItem.dueAt || deadlineItem.startAt : undefined,
        meta: {
          auto: "offer",
          applicationId: app.id,
          // The linked offer-deadline row is suppressed in the to-do list —
          // this derived row carries the deadline itself.
          ...(deadlineItem ? { linkedItemId: deadlineItem.id } : {}),
          completesWhen: "when WaterlooWorks shows your response",
          createdAt: firstAt(id),
        },
      });
    }

    // Rankings: a closing cycle date while applications are in flight.
    const dueRankings = Object.values(items).filter(
      (i) =>
        i &&
        i.type === "cycle-date" &&
        i.category === "rankings-due" &&
        anchorMs(i) != null &&
        /** @type {number} */ (anchorMs(i)) > t
    );
    const rankingsOpenAt = rankingsOpenMs(items);
    const anyInFlight = apps.some((a) => APP_IN_FLIGHT.has(a.status));
    const rankedAfter = (ms) =>
      apps.some(
        (a) =>
          (a.status === "ranked" || a.status === "matched") &&
          (ms == null ? true : (appLastAt(a) ?? 0) >= ms)
      );
    for (const c of dueRankings) {
      const id = `todo:rank:${c.id}`;
      const since = rankingsOpenAt != null ? rankingsOpenAt : Date.parse(firstAt(id));
      const done = rankedAfter(since);
      if (!anyInFlight && !done) continue;
      if (done && appLastAtLatest(apps) < t - DONE_KEEP_MS) continue;
      out[id] = todoItem(id, {
        title: "Submit your rankings",
        org: "Co-op",
        dueAt: c.dueAt || c.startAt,
        status: done ? "done" : "open",
        meta: {
          auto: "rank",
          parentId: c.id,
          completesWhen: "when WaterlooWorks shows your rankings",
          createdAt: firstAt(id),
        },
      });
    }
  }

  return out;
}

/** The application's last status-change instant, or null. */
function appLastAt(app) {
  const h = app && app.history;
  if (Array.isArray(h) && h.length) {
    const ms = Date.parse(h[h.length - 1] && h[h.length - 1].at);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}
const appLastAtLatest = (apps) =>
  apps.reduce((m, a) => Math.max(m, appLastAt(a) ?? 0), 0);

/**
 * The offer-deadline item linked to an application — by meta.jobId /
 * meta.applicationId, else an employer fuzzy match (≥0.6). Earliest wins.
 */
function offerDeadlineItem(app, items) {
  /** @type {number | null} */
  let best = null;
  /** @type {any} */
  let bestItem = null;
  for (const i of Object.values(items || {})) {
    if (!i || i.type !== "offer-deadline") continue;
    const linked =
      (app.jobId && i.meta && i.meta.jobId === app.jobId) ||
      (i.meta && i.meta.applicationId === app.id) ||
      (app.employer && i.org && titleSimilarity(app.employer, undefined, i.org, undefined) >= 0.6);
    if (!linked) continue;
    const ms = anchorMs(i);
    if (ms == null) continue;
    if (best == null || ms < best) {
      best = ms;
      bestItem = i;
    }
  }
  return bestItem;
}

/** The earliest upcoming rankings-open cycle item's anchor, or null. */
function rankingsOpenMs(items) {
  /** @type {number | null} */
  let best = null;
  for (const i of Object.values(items || {})) {
    if (!i || i.type !== "cycle-date" || i.category !== "rankings-open") continue;
    const ms = anchorMs(i);
    if (ms != null && (best == null || ms < best)) best = ms;
  }
  return best;
}

/**
 * Whether a *source* item (not a derived to-do) belongs on the to-do list,
 * under the settings toggles. Derived to-dos (meta.auto) always qualify.
 * @param {any} item effective item
 * @param {any} settings resolved wa1Settings
 */
export function todoSourceItem(item, settings = {}) {
  if (!item) return false;
  const cfg = todosSettings(settings);
  const auto = item.meta && item.meta.auto;
  if (auto === "study") return !(cfg.study && cfg.study.enabled === false);
  if (auto === "offer" || auto === "rank") return cfg.coop !== false;
  if (auto) return true; // project and future derived rules always list
  if (item.type === "task") {
    if (item.category === "reply") return cfg.replies !== false;
    return true; // manual + future project tasks always list
  }
  if (item.category === "reply") return cfg.replies !== false;
  // WaterlooWorks timeslot picks and co-op deadlines.
  if (
    item.type === "application-deadline" ||
    item.type === "offer-deadline" ||
    item.category === "interview-timeslot"
  ) {
    return cfg.coop !== false;
  }
  // School deadlines: deadlines, quizzes, labs with a due date.
  if (item.type === "deadline" || item.type === "quiz" || (item.type === "lab" && !!item.dueAt)) {
    return cfg.deadlines !== false;
  }
  return false;
}

/**
 * The auto-completion rule for a to-do row: does it finish on its own, and
 * what should the UI say? Returns null when the item has no rule — manual
 * check-off only.
 * @param {any} item  the to-do row's item (derived or source item)
 * @param {{applications?: Record<string, any>, items?: Record<string, any>,
 *   now?: Date, userState?: any}} p
 *   userState is the per-item userState record (userState[item.id])
 * @returns {{done: boolean, reason: string} | null}
 */
export function autoDoneRule(item, { applications = {}, items = {}, now = new Date(), userState } = {}) {
  if (!item) return null;
  if (userState && userState.done) return { done: true, reason: "Checked off" };

  const meta = item.meta || {};
  switch (meta.auto) {
    case "study": {
      const parentDone = item.status === "done" || (anchorMs(item) ?? 0) <= now.getTime();
      return {
        done: !!parentDone,
        reason: `After the ${meta.parentLabel || "assessment"}`,
      };
    }
    case "offer": {
      const app = meta.applicationId ? applications[meta.applicationId] : null;
      const done = app && APP_ANSWERED.has(app.status);
      return { done: !!done, reason: "WaterlooWorks shows your response" };
    }
    case "rank": {
      const apps = Object.values(applications || {});
      const done = item.status === "done" ||
        apps.some((a) => a && (a.status === "ranked" || a.status === "matched"));
      return { done: !!done, reason: "WaterlooWorks shows your rankings" };
    }
    default:
      break;
  }

  if (item.source === "learn" && (item.type === "deadline" || item.type === "quiz")) {
    return { done: item.status === "submitted", reason: "Submitted on Learn" };
  }
  if (item.type === "application-deadline") {
    const jobId = meta.jobId;
    const done = jobId
      ? Object.values(applications || {}).some((a) => a && a.jobId === jobId)
      : false;
    return { done: !!done, reason: "Applied on WaterlooWorks" };
  }
  if (item.category === "reply") {
    return { done: item.status === "done", reason: "You replied" };
  }
  if (item.category === "interview-timeslot") {
    // Booking is detected when a real interview item exists for the job.
    const jobId = meta.jobId;
    const done = jobId
      ? Object.values(items || {}).some(
          (i) =>
            i &&
            i.type === "interview" &&
            i.meta &&
            i.meta.jobId === jobId &&
            i.status !== "cancelled"
        )
      : false;
    return { done: !!done, reason: "Interview slot booked" };
  }
  return null;
}
