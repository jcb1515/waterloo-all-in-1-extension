// @ts-check
/*
  Panel tab order and visibility. settings.panel.tabs is [{id, visible}] in
  the user's order; null/absent/unknown entries fall back to the defaults.
  "agenda" can never be hidden. Pure: no DOM, no chrome.*.
*/

export const DEFAULT_TABS = /** @type {{id: string, label: string}[]} */ ([
  { id: "agenda", label: "Agenda" },
  { id: "todo", label: "To-do" },
  { id: "calendar", label: "Calendar" },
  { id: "projects", label: "Projects" },
  { id: "coop", label: "Co-op" },
  { id: "courses", label: "Courses" },
  { id: "teams", label: "Teams" },
]);

const KNOWN = new Map(DEFAULT_TABS.map((t) => [t.id, t]));

/**
 * The full tab list (in display order) for a settings object — saved order
 * first (unknown ids dropped, agenda forced visible), then any tabs the
 * saved list predates, appended visible.
 * @param {any} settings resolved wa1Settings
 * @returns {{id: string, label: string, visible: boolean}[]}
 */
export function tabsFor(settings) {
  const saved = settings && settings.panel && settings.panel.tabs;
  /** @type {{id: string, label: string, visible: boolean}[]} */
  const out = [];
  const seen = new Set();
  if (Array.isArray(saved)) {
    for (const s of saved) {
      const d = s && KNOWN.get(s.id);
      if (!d || seen.has(d.id)) continue;
      seen.add(d.id);
      out.push({ id: d.id, label: d.label, visible: d.id === "agenda" ? true : !!s.visible });
    }
  }
  for (const d of DEFAULT_TABS) {
    if (!seen.has(d.id)) out.push({ id: d.id, label: d.label, visible: true });
  }
  return out;
}

/** Just the visible tabs — what the strip and the 1–7 keys use. */
export function visibleTabs(settings) {
  return tabsFor(settings).filter((t) => t.visible);
}

/**
 * Persist a tab edit: `fn` gets the full ordered list and returns it
 * reordered/toggled. Writes settings.panel.tabs via the save callback.
 * @param {any} settings
 * @param {(tabs: {id:string,label:string,visible:boolean}[]) => {id:string,label:string,visible:boolean}[]} fn
 * @param {(patch: any) => void} save
 */
export function editTabs(settings, fn, save) {
  const next = fn(tabsFor(settings).map((t) => ({ ...t })));
  if (!Array.isArray(next)) return;
  // Agenda is pinned visible.
  for (const t of next) if (t.id === "agenda") t.visible = true;
  save({ panel: { ...(settings.panel || {}), tabs: next.map((t) => ({ id: t.id, visible: !!t.visible })) } });
}
