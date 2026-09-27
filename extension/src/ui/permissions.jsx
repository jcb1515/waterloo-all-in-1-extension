// Shared optional-permission UI: a granted-state hook plus an "Allow"
// button that requests a source's host permissions on click.

import { useEffect, useState } from "preact/hooks";
import {
  OPTIONAL_PERMISSION_GROUPS,
  hasSourceAccess,
  requestSourceAccess,
} from "../core/permissions.js";
import { IS_PREVIEW, query } from "../panel/data.js";

/** Preview override: ?noperms=discord,outlook makes those sources ungranted. */
const previewDenied = (sourceId) =>
  IS_PREVIEW && (query.get("noperms") || "").split(",").includes(sourceId);

/**
 * Granted state for a source's optional host group.
 * @param {string} sourceId group key ("discord" | "outlook" | "gmail")
 * @returns {boolean|null} null while unknown; true when the source needs no
 *   optional grant or already has it.
 */
export function useSourceAccess(sourceId) {
  const [granted, setGranted] = useState(() =>
    !(OPTIONAL_PERMISSION_GROUPS /** @type {any} */)[sourceId] ? true : null,
  );
  useEffect(() => {
    if (!(OPTIONAL_PERMISSION_GROUPS /** @type {any} */)[sourceId]) {
      setGranted(true);
      return undefined;
    }
    if (IS_PREVIEW) {
      setGranted(!previewDenied(sourceId));
      return undefined;
    }
    let live = true;
    const refresh = () =>
      hasSourceAccess(sourceId).then((g) => {
        if (live) setGranted(g);
      });
    refresh();
    let onAdd;
    let onRem;
    try {
      onAdd = chrome.permissions.onAdded;
      onRem = chrome.permissions.onRemoved;
      onAdd.addListener(refresh);
      onRem.addListener(refresh);
    } catch {
      /* permissions API unavailable */
    }
    return () => {
      live = false;
      try {
        if (onAdd) onAdd.removeListener(refresh);
        if (onRem) onRem.removeListener(refresh);
      } catch {
        /* ignore */
      }
    };
  }, [sourceId]);
  return granted;
}

/**
 * Granted state for several groups at once — for cards that need per-group
 * checks without one hook per group (email's Outlook + Gmail).
 * @param {string[]} groupIds
 * @returns {Record<string, boolean|null>}
 */
export function useAccessMap(groupIds) {
  const key = (groupIds || []).slice().sort().join(",");
  const [map, setMap] = useState(/** @type {Record<string, boolean|null>} */ ({}));
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (!ids.length) {
      setMap({});
      return undefined;
    }
    if (IS_PREVIEW) {
      setMap(Object.fromEntries(ids.map((id) => [id, !previewDenied(id)])));
      return undefined;
    }
    let live = true;
    const refresh = () =>
      Promise.all(ids.map(async (id) => /** @type {const} */ ([id, await hasSourceAccess(id)]))).then(
        (entries) => {
          if (live) setMap(Object.fromEntries(entries));
        },
      );
    refresh();
    let onAdd;
    let onRem;
    try {
      onAdd = chrome.permissions.onAdded;
      onRem = chrome.permissions.onRemoved;
      onAdd.addListener(refresh);
      onRem.addListener(refresh);
    } catch {
      /* permissions API unavailable */
    }
    return () => {
      live = false;
      try {
        if (onAdd) onAdd.removeListener(refresh);
        if (onRem) onRem.removeListener(refresh);
      } catch {
        /* ignore */
      }
    };
  }, [key]);
  return map;
}

/**
 * "Allow" button: requests the source's optional host permissions inside the
 * click gesture. `onResult(granted)` fires with the outcome.
 * @param {{sourceId: string, onResult?: (granted: boolean) => void,
 *   label?: string, className?: string}} p
 */
export function AllowSourceButton({ sourceId, onResult, label, className }) {
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    setBusy(true);
    let ok = true;
    if (!IS_PREVIEW) ok = await requestSourceAccess(sourceId);
    setBusy(false);
    if (onResult) onResult(ok);
  };
  return (
    <button
      type="button"
      class={className || "btn btn-sm btn-primary"}
      disabled={busy}
      onClick={ask}
    >
      {busy ? "Asking…" : label || "Allow"}
    </button>
  );
}
