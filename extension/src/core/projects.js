// @ts-check
/*
  Projects: user-defined endeavours (a hackathon, a tapeout, a batch of
  co-op applications) stored under the `projects` storage key as an array:

    {id: "proj_<uuid>", name, color (org palette index 0-7), description?,
     dueAt?, allDay?, status: "active"|"done"|"archived", calendar: true,
     createdAt}

  A project's contents are ordinary manual items carrying meta.projectId and
  org = the project name, so the merge, agenda, calendar, reminders and the
  to-do list see them without special handling. Everything here is pure —
  the scheduler's projectUpsert/projectDelete apply the folds inside the
  manual ingest queue.
*/

import { manualItemFrom } from "./quickadd.js";

const DAY = 86400000;

export const PROJECT_STATUSES = ["active", "done", "archived"];

/** @returns {string} "proj_<uuid>" */
export function newProjectId() {
  return `proj_${crypto.randomUUID()}`;
}

/**
 * Normalise a project record for storage. Returns null without a name.
 * @param {any} input
 * @param {Date} [now]
 */
export function normalizeProject(input, now = new Date()) {
  if (!input || typeof input.name !== "string" || !input.name.trim()) return null;
  /** @type {any} */
  const p = {
    id: typeof input.id === "string" && input.id ? input.id : newProjectId(),
    name: input.name.trim(),
    color: Number.isInteger(input.color) ? ((input.color % 8) + 8) % 8 : 0,
    status: PROJECT_STATUSES.includes(input.status) ? input.status : "active",
    calendar: input.calendar !== false,
    createdAt: input.createdAt || now.toISOString(),
  };
  if (typeof input.description === "string" && input.description.trim()) {
    p.description = input.description.trim();
  }
  if (input.dueAt && !Number.isNaN(Date.parse(input.dueAt))) {
    p.dueAt = input.dueAt;
    if (input.allDay) p.allDay = true;
  }
  return p;
}

/** @param {any[]|null|undefined} projects @param {string} id */
export function projectById(projects, id) {
  return (Array.isArray(projects) ? projects : []).find((p) => p && p.id === id) || null;
}

/** Case-insensitive exact name match. @param {any[]|null|undefined} projects @param {unknown} name */
export function projectByName(projects, name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  return (
    (Array.isArray(projects) ? projects : []).find(
      (p) => p && typeof p.name === "string" && p.name.trim().toLowerCase() === n
    ) || null
  );
}

/**
 * Quick-add "#project" prefix: "#communihacks draft slides" or a first-word
 * prefix ("#comm draft slides" -> "CommuniHacks (MLH)") both match. The
 * matched text is stripped so the title stays clean.
 * @param {string} text @param {any[]|null|undefined} projects
 * @returns {{project: any|null, text: string}}
 */
export function stripProjectPrefix(text, projects) {
  const t = String(text || "");
  if (!t.startsWith("#") || !Array.isArray(projects) || !projects.length) {
    return { project: null, text: t };
  }
  const rest = t.slice(1).replace(/^\s+/, "");
  const low = rest.toLowerCase();
  const sorted = [...projects]
    .filter((p) => p && typeof p.name === "string" && p.name)
    .sort((a, b) => b.name.length - a.name.length);
  // The full project name as a prefix of the text wins ("#co-op applications …").
  for (const p of sorted) {
    const n = p.name.toLowerCase();
    if (low === n || low.startsWith(`${n} `) || low.startsWith(`${n}-`)) {
      return { project: p, text: rest.slice(p.name.length).replace(/^[\s\-–—]+/, "") };
    }
  }
  // Otherwise the first word is a prefix of a project name ("#comm …").
  const word = (rest.split(/\s+/)[0] || "").toLowerCase();
  if (word.length >= 2) {
    const p = sorted.find((p) => p.name.toLowerCase().startsWith(word));
    if (p) return { project: p, text: rest.slice(word.length).replace(/^\s+/, "") };
  }
  return { project: null, text: t };
}

/** The synced "<name> due" item id for a project. */
export const projectDueItemId = (/** @type {string} */ id) => `manual:project:${id}:due`;

/**
 * The manual deadline item a project's dueAt keeps in sync, or null when the
 * project has no due date.
 * @param {any} project @param {Date} [now]
 */
export function projectDueItem(project, now = new Date()) {
  if (!project || !project.id || !project.dueAt) return null;
  return manualItemFrom(
    {
      title: `${project.name} due`,
      org: project.name,
      type: "deadline",
      dueAt: project.dueAt,
      allDay: !!project.allDay,
      meta: { projectId: project.id, projectDue: true },
    },
    { id: projectDueItemId(project.id), now }
  );
}

/**
 * Fold a project upsert into {projects, items}: replace/append the record,
 * rewrite `org` on its items after a rename, and sync the due item (created
 * when dueAt is set, deleted when cleared).
 * @param {any[]} projects @param {any[]} items raw manual items
 * @param {any} project a normalizeProject()-ed record
 * @returns {{projects: any[], items: any[]}}
 */
export function upsertProjectFold(projects, items, project, { now = new Date() } = {}) {
  const list = Array.isArray(projects) ? projects : [];
  const idx = list.findIndex((p) => p && p.id === project.id);
  const prev = idx >= 0 ? list[idx] : null;
  const nextProjects = idx >= 0 ? list.map((p, i) => (i === idx ? project : p)) : [...list, project];
  let nextItems = Array.isArray(items) ? items : [];
  if (prev && prev.name !== project.name) {
    nextItems = nextItems.map((i) =>
      i && i.meta && i.meta.projectId === project.id ? { ...i, org: project.name } : i
    );
  }
  const dueId = projectDueItemId(project.id);
  const due = projectDueItem(project, now);
  // Keep the user's own state on a re-synced due item (notes, subtasks).
  const prevDue = nextItems.find((i) => i && i.id === dueId);
  nextItems = nextItems.filter((i) => i && i.id !== dueId);
  if (due) {
    nextItems = [...nextItems, prevDue ? { ...due, seenIn: prevDue.seenIn || due.seenIn } : due];
  }
  return { projects: nextProjects, items: nextItems };
}

/**
 * Fold a project delete into {projects, items}: drop the record and every
 * item carrying its meta.projectId (the due item included).
 * @param {any[]} projects @param {any[]} items @param {string} id
 * @returns {{projects: any[], items: any[]}}
 */
export function deleteProjectFold(projects, items, id) {
  return {
    projects: (Array.isArray(projects) ? projects : []).filter((p) => p && p.id !== id),
    items: (Array.isArray(items) ? items : []).filter(
      (i) => !(i && i.meta && i.meta.projectId === id)
    ),
  };
}

/**
 * The items belonging to a project, from a merged items map or a raw list.
 * @param {Record<string, any> | any[]} items @param {string} projectId
 */
export function projectItemList(items, projectId) {
  const src = Array.isArray(items) ? items : Object.values(items || {});
  return src.filter((i) => i && i.meta && i.meta.projectId === projectId);
}

/**
 * Card/detail stats: counts, the soonest open anchor ("next"), and how many
 * days the project's own due date is past (0 when not late or no dueAt).
 * @param {any} project
 * @param {Record<string, any> | any[]} items
 * @param {Record<string, any>} [userState]
 * @param {Date} [now]
 * @returns {{total: number, done: number, next: any|null, nextAt: string|null,
 *   dueAt: string|null, lateDays: number}}
 */
export function projectProgress(project, items, userState = {}, now = new Date()) {
  const list = project ? projectItemList(items, project.id) : [];
  let done = 0;
  /** @type {any} */
  let next = null;
  let nextMs = Infinity;
  for (const i of list) {
    const us = (userState && userState[i.id]) || {};
    if (us.done || i.status === "done" || i.status === "submitted") {
      done++;
      continue;
    }
    const a = i.dueAt || i.startAt;
    const ms = a ? Date.parse(a) : NaN;
    if (!Number.isNaN(ms) && ms < nextMs) {
      nextMs = ms;
      next = i;
    }
  }
  const dueMs = project && project.dueAt ? Date.parse(project.dueAt) : NaN;
  const lateDays =
    Number.isNaN(dueMs) ? 0 : Math.max(0, Math.floor((now.getTime() - dueMs) / DAY));
  return {
    total: list.length,
    done,
    next,
    nextAt: next ? next.dueAt || next.startAt : null,
    dueAt: (project && project.dueAt) || null,
    lateDays,
  };
}
