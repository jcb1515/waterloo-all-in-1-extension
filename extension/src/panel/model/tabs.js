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
