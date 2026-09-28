// @ts-check
/*
  Storage client for the panel and options UI. useStore() reads the merged
  view from chrome.storage.local and re-renders on storage changes; it also
  applies theme/density to <html>. When `?preview=1` is in the URL — or
  chrome.storage simply isn't there (the preview server over plain http) —
  it serves src/panel/preview-fixtures.js instead.
*/

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { resolveSettings, SETTINGS_KEY, setLocal } from "../core/store.js";
import { UI } from "../core/messages.js";
import { previewState } from "./preview-fixtures.js";

const KEYS = [
  "items",
  "todos",
  "userState",
  "sourceState",
  "courses",
  "applications",
  "terms",
  "calendarFeed",
  "outlineFiles",
  "updates",
  "updatesSeenAt",
  "projects",
  "lastAudit",
  SETTINGS_KEY,
];

export const query = new URLSearchParams(location.search);

/** Preview mode: ?preview=1, or the chrome.* APIs simply aren't here. */
export const IS_PREVIEW =
  query.has("preview") || typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local;

/** ?preview=empty renders an empty-ish first-run state (blank settings, no source status). */
const PREVIEW_EMPTY = query.get("preview") === "empty";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Stored settings resolved over DEFAULT_SETTINGS + the baked-in dev profile. */
export function mergeSettings(saved) {
  return resolveSettings(saved);
}

/** Push theme/density onto <html>. ?theme= and ?density= override for previews. */
export function applyChromeAttributes(settings) {
  const el = document.documentElement;
  const theme = query.get("theme") || (settings.theme === "system" ? "" : settings.theme);
  if (theme === "light" || theme === "dark") el.dataset.theme = theme;
  else delete el.dataset.theme;
  el.dataset.density = query.get("density") || settings.density || "comfortable";
}

async function readAll() {
  const all = /** @type {Record<string, any>} */ (await chrome.storage.local.get(KEYS));
  return {
    items: isObj(all.items) ? all.items : {},
    todos: isObj(all.todos) ? all.todos : {},
    userState: isObj(all.userState) ? all.userState : {},
    sourceState: isObj(all.sourceState) ? all.sourceState : {},
    courses: isObj(all.courses) ? all.courses : {},
    applications: isObj(all.applications) ? all.applications : {},
    terms: isObj(all.terms) ? all.terms : {},
    calendarFeed: isObj(all.calendarFeed) ? all.calendarFeed : null,
    outlineFiles: Array.isArray(all.outlineFiles) ? all.outlineFiles : [],
    updates: Array.isArray(all.updates) ? all.updates : [],
    updatesSeenAt: typeof all.updatesSeenAt === "string" ? all.updatesSeenAt : null,
    projects: Array.isArray(all.projects) ? all.projects : [],
    lastAudit: isObj(all.lastAudit) ? all.lastAudit : null,
    settings: mergeSettings(all[SETTINGS_KEY]),
  };
}

function blank() {
  return /** @type {any} */ ({
    items: {},
    todos: {},
    userState: {},
    sourceState: {},
    courses: {},
    applications: {},
    terms: {},
    calendarFeed: null,
    outlineFiles: [],
    updates: [],
    updatesSeenAt: null,
    projects: [],
    lastAudit: null,
    settings: mergeSettings(null),
  });
}

/**
 * @returns {{ready: boolean} & ReturnType<typeof blank> & {actions: any}}
 */
export function useStore() {
  const [state, setState] = useState(() => ({ ready: false, ...blank() }));
  const reloadTimer = useRef(/** @type {any} */ (null));

  useEffect(() => {
    if (IS_PREVIEW) {
      const fx = PREVIEW_EMPTY
        ? emptyPreviewState()
        : previewState(new Date(), {
            cal: query.get("cal"),
            imports: query.has("imports"),
            mailscan: query.get("mailscan") === "1" || query.get("mailscan") === "panel",
          });
      setState({
        ready: true,
        items: fx.items,
        todos: fx.todos || {},
        userState: fx.userState,
        sourceState: fx.sourceState,
        courses: fx.courses,
        applications: fx.applications,
        terms: fx.terms,
        calendarFeed: fx.calendarFeed || null,
        outlineFiles: Array.isArray(fx.outlineFiles) ? fx.outlineFiles : [],
        updates: Array.isArray(fx.updates) ? fx.updates : [],
        updatesSeenAt: fx.updatesSeenAt || null,
        projects: Array.isArray(fx.projects) ? fx.projects : [],
        lastAudit: fx.lastAudit || null,
        settings: mergeSettings(fx.settings),
      });
      return;
    }
    let alive = true;
    const load = () =>
      readAll()
        .then((s) => alive && setState({ ready: true, ...s }))
        .catch(() => alive && setState((s) => ({ ...s, ready: true })));
    load();
    const onChange = (/** @type {any} */ _c, /** @type {string} */ area) => {
      if (area !== "local") return;
      // Storage can flap a lot during a sync — collapse to one read per 150 ms.
      if (reloadTimer.current) return;
      reloadTimer.current = setTimeout(() => {
        reloadTimer.current = null;
        load();
      }, 150);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    };
  }, []);

  useEffect(() => {
    applyChromeAttributes(state.settings);
  }, [state.settings]);

  const actions = useMemo(
    () => ({
      /** Optimistic done toggle; the real write goes through the background. */
      toggleDone(item, doneAt) {
        const us = state.userState[item.id] || {};
        const done = !(us.done || item.status === "done" || item.status === "submitted");
        const patch = done ? { done: true, doneAt: doneAt || new Date().toISOString() } : { done: false, doneAt: null };
        setState((s) => ({
          ...s,
          userState: { ...s.userState, [item.id]: { ...(s.userState[item.id] || {}), ...patch } },
        }));
        send({ type: UI.SET_USER_STATE, id: item.id, patch });
      },
      sync(source) {
        return send({ type: UI.SYNC, source });
      },
      open(url) {
        return send({ type: UI.OPEN, url });
      },
      clearSource(source) {
        return send({ type: UI.CLEAR_SOURCE, source });
      },
      setUserState(id, patch) {
        setState((s) => ({
          ...s,
          userState: { ...s.userState, [id]: { ...(s.userState[id] || {}), ...patch } },
        }));
        return send({ type: UI.SET_USER_STATE, id, patch });
      },
      /** Stamp updatesSeenAt = now (drives the bell's unread badge). */
      markUpdatesSeen() {
        const at = new Date().toISOString();
        setState((s) => ({ ...s, updatesSeenAt: at }));
        if (!IS_PREVIEW) setLocal("updatesSeenAt", at).catch(() => {});
      },
      /** "Clear all" on the updates feed. */
      clearUpdates() {
        setState((s) => ({ ...s, updates: [] }));
        if (!IS_PREVIEW) setLocal("updates", []).catch(() => {});
      },
      /** Quick add / edit: upsert a manual item through the background. */
      manualUpsert(item) {
        return send({ type: UI.MANUAL_UPSERT, item });
      },
      manualDelete(id) {
        return send({ type: UI.MANUAL_DELETE, id });
      },
      projectUpsert(project) {
        return send({ type: UI.PROJECT_UPSERT, project });
      },
      projectDelete(id) {
        return send({ type: UI.PROJECT_DELETE, id });
      },
    }),
    [state.userState]
  );

  return { ...state, actions };
}

/** Empty-ish state for first-run screenshots: blank tables, no source status. */
function emptyPreviewState() {
  return {
    items: {},
    todos: {},
    userState: {},
    sourceState: {},
    courses: {},
    applications: {},
    terms: {},
    calendarFeed: null,
    outlineFiles: [],
    updates: [],
    updatesSeenAt: null,
    projects: [],
    settings: null,
  };
}

/**
 * Send a UI message to the background; resolves null in preview/headless.
 * @param {Record<string, any>} msg
 */
export function send(msg) {
  try {
    if (IS_PREVIEW) return Promise.resolve(null);
    return chrome.runtime.sendMessage(msg).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * The URL to open for a site's "Open site" button.
 * @param {string[]} origins
 */
export const siteUrl = (origins) => (origins && origins[0]) || null;
