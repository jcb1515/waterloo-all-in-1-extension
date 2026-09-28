// @ts-check
// The shared top of every source's Setup page: the Enabled toggle, the
// "what we read" paragraph, missing-permission Allow buttons, and the
// Sync/Open actions. Ported from SourceCard in panel/views/Sources.jsx —
// W1's Sources page mounts SETUP[sourceId] and this is its header.

import { useState } from "preact/hooks";
import { ADAPTERS } from "../../../core/registry.js";
import {
  GROUP_LABELS,
  neededGroups,
  requestSourceAccess,
} from "../../../core/permissions.js";
import { AllowSourceButton, useAccessMap } from "../../../ui/permissions.jsx";
import { Toggle } from "../../../options/bits.jsx";
import { IS_PREVIEW } from "../../data.js";
import { RefreshIcon, ExternalLinkIcon } from "../../../ui/icons.jsx";

/** One "what we read" paragraph per adapter. */
const WHAT_WE_READ = {
  learn: "Reads your courses, assignments, quizzes, grades and announcements while you use Learn. Nothing leaves your browser except your own calendar feed.",
  portal: "Reads your class schedule, sections, final exams (date, time, room and seat) and term dates while you browse Portal.",
  outline: "Reads course outline pages and outline files you add: classes for your section, assessments and weights, and deadlines.",
  outlook: "Reads calendar invites and dated emails in Outlook and Gmail tabs you open. Only the matched sentence is kept — never whole emails or addresses.",
  gcal: "Reads event titles and times from your own Google calendars so nothing is published twice. Subscribed calendars, including this extension's feed, never hide anything.",
  waterlooworks: "Reads your applications, interviews and ranking dates while you browse WaterlooWorks.",
  discord: "Reads messages, events and mentions in the servers and channels you watch, only while Discord is open. Nothing is ever sent to Discord.",
};

/**
 * @param {{sourceId: string, state: any, actions: any, children?: any}} p
 */
export function SourceBasics({ sourceId, state, actions, children }) {
  const adapter =
    ADAPTERS.find((a) => a.id === sourceId) ||
    /** @type {any} */ ({ id: sourceId, label: sourceId, origins: [] });
  const src =
    (state.settings &&
      state.settings.sources &&
      state.settings.sources[adapter.id]) ||
    {};
  // gcal is the one source that's off until the user turns it on — nothing
  // reads Google Calendar unless the toggle (and its permission) is on.
  const enabled =
    adapter.id === "gcal" ? src.enabled === true : src.enabled !== false;
  const [denied, setDenied] = useState(false);

  const needed = neededGroups(adapter.id, src);
  const access = useAccessMap(needed);
  const missing = needed.filter((g) => access[g] === false);

  /** @param {boolean} v */
  const onToggle = async (v) => {
    if (v && !IS_PREVIEW && (adapter.id === "discord" || adapter.id === "gcal")) {
      // The request must start inside the click — no await before it.
      const ok = await requestSourceAccess(adapter.id);
      if (!ok) {
        setDenied(true);
        return;
      }
    }
    setDenied(false);
    actions.saveSettings({
      sources: { [adapter.id]: { ...src, enabled: v } },
    });
  };

  return (
    <div class="src-sub">
      <Toggle label="Enabled" checked={enabled} onChange={onToggle} />
      {WHAT_WE_READ[adapter.id] ? (
        <p class="help">{WHAT_WE_READ[adapter.id]}</p>
      ) : null}
      {denied ? (
        <p class="help status-err">
          Permission wasn't granted — {adapter.label} stays off. The browser
          prompt asks for access to{" "}
          {adapter.origins[0] ? adapter.origins[0].replace("https://", "") : "the site"};
          allow it, then toggle again.
        </p>
      ) : null}
      {!enabled ? null : (
        <>
          {missing.map((g) => (
            <AllowSourceButton
              key={g}
              sourceId={g}
              label={`Allow ${GROUP_LABELS[g] || g}`}
            />
          ))}
          <div class="source-actions">
            {adapter.intervalMinutes > 0 ? (
              <button
                type="button"
                class="btn btn-sm"
                onClick={() => actions.sync(adapter.id)}
              >
                <RefreshIcon size={13} /> Sync now
              </button>
            ) : (
              <span class="help">Updates while you browse {adapter.label}.</span>
            )}
            {adapter.origins && adapter.origins[0] ? (
              <button
                type="button"
                class="btn btn-sm"
                onClick={() => actions.open(`${adapter.origins[0]}/`)}
              >
                <ExternalLinkIcon size={13} /> Open site
              </button>
            ) : null}
          </div>
          {children}
        </>
      )}
    </div>
  );
}
