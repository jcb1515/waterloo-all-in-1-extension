// @ts-check
/*
  Storage client for the panel and options UI. useStore() reads the merged
  view from chrome.storage.local and re-renders on storage changes; it also
  applies theme/density to <html>. When `?preview=1` is in the URL — or
  chrome.storage simply isn't there (the preview server over plain http) —
  it serves src/panel/preview-fixtures.js instead.
*/

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../core/store.js";
import { UI } from "../core/messages.js";
import { previewState } from "./preview-fixtures.js";

const KEYS = [
  "items",
  "userState",
  "sourceState",
  "courses",
  "applications",
  "terms",
  SETTINGS_KEY,
];

export const query = new URLSearchParams(location.search);

/** Preview mode: ?preview=1, or the chrome.* APIs simply aren't here. */
export const IS_PREVIEW =
  query.has("preview") || typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Settings deep-merged over DEFAULT_SETTINGS (one level is enough here). */
export function mergeSettings(saved) {
  const s = isObj(saved) ? saved : {};
  const out = { ...DEFAULT_SETTINGS, ...s };
  out.profile = { ...DEFAULT_SETTINGS.profile, ...(isObj(s.profile) ? s.profile : {}) };
  out.profile.sections = {
    ...DEFAULT_SETTINGS.profile.sections,
    ...(isObj(s.profile) && isObj(s.profile.sections) ? s.profile.sections : {}),
  };
  out.profile.groups = {
    ...DEFAULT_SETTINGS.profile.groups,
    ...(isObj(s.profile) && isObj(s.profile.groups) ? s.profile.groups : {}),
  };
  out.agenda = { ...DEFAULT_SETTINGS.agenda, ...(isObj(s.agenda) ? s.agenda : {}) };
  out.sources = { ...DEFAULT_SETTINGS.sources, ...(isObj(s.sources) ? s.sources : {}) };
  return out;
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
    userState: isObj(all.userState) ? all.userState : {},
    sourceState: isObj(all.sourceState) ? all.sourceState : {},
    courses: isObj(all.courses) ? all.courses : {},
    applications: isObj(all.applications) ? all.applications : {},
    terms: isObj(all.terms) ? all.terms : {},
    settings: mergeSettings(all[SETTINGS_KEY]),
  };
}

function blank() {
  return {
    items: {},
    userState: {},
    sourceState: {},
    courses: {},
    applications: {},
    terms: {},
    settings: mergeSettings(null),
  };
}

/**
 * @returns {{ready: boolean} & ReturnType<typeof blank> & {actions: any}}
 */
export function useStore() {
  const [state, setState] = useState(() => ({ ready: false, ...blank() }));
  const reloadTimer = useRef(/** @type {any} */ (null));

  useEffect(() => {
    if (IS_PREVIEW) {
      const fx = previewState(new Date());
      setState({
        ready: true,
        items: fx.items,
        userState: fx.userState,
        sourceState: fx.sourceState,
        courses: fx.courses,
        applications: fx.applications,
        terms: fx.terms,
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
    }),
    [state.userState]
  );

  return { ...state, actions };
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
