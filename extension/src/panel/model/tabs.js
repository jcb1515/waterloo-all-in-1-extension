// @ts-check
/*
  Panel tab model (v2): four primary tabs in the strip — Upcoming, To-do,
  Calendar, Sources — and the rest under "More ▾". Saved settings.panel.tabs
  from the old model are migrated: "agenda" -> "upcoming", and the views that
  moved under More keep their saved visibility. Pure: no DOM, no chrome.*.
*/

export const PRIMARY_TABS = /** @type {{id: string, label: string}[]} */ ([
  { id: "upcoming", label: "Upcoming" },
  { id: "todo", label: "To-do" },
  { id: "calendar", label: "Calendar" },
  { id: "sources", label: "Sources" },
]);

export const MORE_TABS = /** @type {{id: string, label: string}[]} */ ([
  { id: "courses", label: "Courses" },
  { id: "coop", label: "Co-op" },
  { id: "teams", label: "Teams" },
  { id: "projects", label: "Projects" },
]);

export const DEFAULT_TABS = [...PRIMARY_TABS, ...MORE_TABS];

const KNOWN = new Map(DEFAULT_TABS.map((t) => [t.id, t]));
const PRIMARY_IDS = new Set(PRIMARY_TABS.map((t) => t.id));
const MORE_IDS = new Set(MORE_TABS.map((t) => t.id));

/** Old saved ids that map onto the v2 set. */
const ID_MIGRATION = /** @type {Record<string, string>} */ ({ agenda: "upcoming" });

/** @param {string} id */
export function migrateTabId(id) {
  return ID_MIGRATION[id] || id;
}

/**
 * The full tab list: the four primary tabs (always visible, fixed order),
 * then the More views — ordered by the saved list when one exists, else the
 * default order, each honoring its saved visibility.
 * @param {any} settings resolved wa1Settings
 * @returns {{id: string, label: string, visible: boolean, primary: boolean}[]}
 */
export function tabsFor(settings) {
  const saved = settings && settings.panel && settings.panel.tabs;
  /** @type {Map<string, boolean>} */
  const savedVis = new Map();
  /** @type {string[]} */
  const savedOrder = [];
  if (Array.isArray(saved)) {
    for (const s of saved) {
      const id = s && migrateTabId(s.id);
      if (!id || !KNOWN.has(id) || savedVis.has(id)) continue;
      savedVis.set(id, s.visible !== false);
      savedOrder.push(id);
    }
  }
  const moreIds = MORE_IDS;
  const orderedMore = [
    ...savedOrder.filter((id) => moreIds.has(id)),
    ...MORE_TABS.map((t) => t.id).filter((id) => !savedOrder.includes(id)),
  ];
  return [
    ...PRIMARY_TABS.map((t) => ({ ...t, visible: true, primary: true })),
    ...orderedMore.map((id) => {
      const d = /** @type {{id:string,label:string}} */ (KNOWN.get(id));
      return { ...d, visible: savedVis.has(id) ? /** @type {boolean} */ (savedVis.get(id)) : true, primary: false };
    }),
  ];
}

/** The visible primary tabs — what the strip and the 1–4 keys use. */
export function primaryTabs(settings) {
  return tabsFor(settings).filter((t) => t.primary && t.visible);
}

/** The visible More views, for the dropdown. */
export function moreTabs(settings) {
  return tabsFor(settings).filter((t) => !t.primary && t.visible);
}

/* ------------------------------- More sheet ------------------------------- */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Application statuses still in the pipeline (before an answer/outcome). */
const APP_OPEN = new Set([
  "applied",
  "selected-for-interview",
  "interview-scheduled",
  "alternate",
  "offer",
]);

/** Static row copy; app.jsx maps the icon keys to icons.jsx components. */
const MORE_ROW_META = /** @type {Record<string, {icon: string, description: string}>} */ ({
  courses: {
    icon: "courses",
    description: "Outlines, grades and sections for each course",
  },
  coop: {
    icon: "coop",
    description: "Applications, interviews and co-op dates",
  },
  teams: {
    icon: "teams",
    description: "Discord teams, meetings and tasks",
  },
  projects: {
    icon: "projects",
    description: "Your personal projects and their tasks",
  },
});

const plural = (n, word, words) => `${n} ${n === 1 ? word : words || `${word}s`}`;

/**
 * The More sheet's rows: one per visible More view, in the saved order, each
 * with an icon key, a one-line description and a live count where useful.
 * @param {any} settings resolved wa1Settings
 * @param {any} state panel state (items, applications, courses, projects)
 * @param {Date|number} [now]
 * @returns {{id: string, label: string, icon: string, description: string,
 *   count: string | null}[]}
 */
export function moreSheetRows(settings, state, now = new Date()) {
  const items = (state && state.items) || {};
  const apps = (state && state.applications) || {};
  const courses = (state && state.courses) || {};
  const projects = Array.isArray(state && state.projects) ? state.projects : [];
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const weekEnd = nowMs + WEEK_MS;

  /** @type {Record<string, string | null>} */
  const counts = {};

  const nCourses = Object.keys(courses).length;
  counts.courses = plural(nCourses, "course");

  let nInterviews = 0;
  let nTeams = 0;
  for (const it of Object.values(items)) {
    if (!it || it.status === "cancelled") continue;
    const a = it.dueAt || it.startAt;
    const ms = a ? Date.parse(a) : NaN;
    if (Number.isNaN(ms) || ms < nowMs) continue;
    if (it.type === "interview") nInterviews++;
    const discord =
      it.source === "discord" ||
      (Array.isArray(it.seenIn) && it.seenIn.some((s) => s && s.source === "discord"));
    if (discord && ms < weekEnd) nTeams++;
  }
  if (nInterviews) {
    counts.coop = plural(nInterviews, "interview");
  } else {
    const nApps = Object.values(apps).filter((a) => a && APP_OPEN.has(a.status)).length;
    counts.coop = nApps ? plural(nApps, "active application") : null;
  }

  counts.teams = nTeams ? `${nTeams} this week` : null;

  const nProjects = projects.filter((p) => p && (!p.status || p.status === "active")).length;
  counts.projects = nProjects ? `${nProjects} active` : null;

  return moreTabs(settings).map((t) => ({
    id: t.id,
    label: t.label,
    icon: (MORE_ROW_META[t.id] || {}).icon || "projects",
    description: (MORE_ROW_META[t.id] || {}).description || "",
    count: counts[t.id] || null,
  }));
}

/** Every visible tab id (primary + More) — used to validate `tab` state. */
export function visibleTabs(settings) {
  return tabsFor(settings).filter((t) => t.visible);
}

/**
 * Persist a tab edit: `fn` gets the full ordered list and returns it
 * reordered/toggled. Writes settings.panel.tabs via the save callback.
 * Primary tabs are pinned visible.
 * @param {any} settings
 * @param {(tabs: {id:string,label:string,visible:boolean,primary:boolean}[]) => {id:string,label:string,visible:boolean,primary:boolean}[]} fn
 * @param {(patch: any) => void} save
 */
export function editTabs(settings, fn, save) {
  const next = fn(tabsFor(settings).map((t) => ({ ...t })));
  if (!Array.isArray(next)) return;
  for (const t of next) if (PRIMARY_IDS.has(t.id)) t.visible = true;
  save({ panel: { ...(settings.panel || {}), tabs: next.map((t) => ({ id: t.id, visible: !!t.visible })) } });
}
