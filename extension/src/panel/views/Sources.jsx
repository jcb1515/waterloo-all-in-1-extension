// Sources view: one status card per adapter, with sync/open/clear actions and
// a footer link to the privacy & discovery settings.

import { useMemo, useState } from "preact/hooks";
import { ADAPTERS, stageForAdapter } from "../../core/registry.js";
import { sourceStatus } from "../model/sources.js";
import { fmtAgo } from "../model/agenda.js";
import { IS_PREVIEW, send } from "../data.js";
import { UI } from "../../core/messages.js";
import { OPTIONAL_PERMISSION_GROUPS } from "../../core/permissions.js";
import { AllowSourceButton, useSourceAccess } from "../../ui/permissions.jsx";
import { inventoryReport } from "../../sources/discord/index.js";
import {
  RefreshIcon,
  ExternalLinkIcon,
  TrashIcon,
  ShieldIcon,
  ArrowRightIcon,
  ClipboardCheckIcon,
} from "../../ui/icons.jsx";

const TONE_BADGE = { ok: "badge-ok", warn: "badge-warn", danger: "badge-danger", muted: "badge-muted" };

/** Monogram from a label: "Course outlines" -> "Co", "WaterlooWorks" -> "Wa". */
function monogram(label) {
  const words = String(label).replace(/\(.*\)/, "").trim().split(/\s+/);
  const first = words[0] || "?";
  const second = words.length > 1 ? words[1] : first.slice(1);
  return (first[0] + (second[0] || "")).toUpperCase();
}

/**
 * @param {{state: any, actions: any, now: Date}} props
 */
export function Sources({ state, actions, now }) {
  const cards = useMemo(
    () =>
      ADAPTERS.map((a) => {
        const stage = stageForAdapter(a.id);
        const st = (state.sourceState || {})[a.id] || null;
        return { adapter: a, stage, st, status: sourceStatus(a, st, stage, now) };
      }),
    [state.sourceState]
  );

  const openPrivacy = () => {
    const url = IS_PREVIEW
      ? "/src/options/options.html#privacy"
      : chrome.runtime.getURL("src/options/options.html#privacy");
    try {
      if (!IS_PREVIEW && chrome.tabs) {
        chrome.tabs.create({ url });
        return;
      }
    } catch {
      /* fall through to location */
    }
    window.open(url, "_blank");
  };

  return (
    <div class="sources-list">
      {cards.map(({ adapter, stage, st, status }) => (
        <SourceCard
          key={adapter.id}
          adapter={adapter}
          stage={stage}
          st={st}
          status={status}
          state={state}
          actions={actions}
          now={now}
        />
      ))}
      <button type="button" class="btn btn-ghost sources-privacy" onClick={openPrivacy}>
        <ShieldIcon size={14} /> Privacy &amp; discovery settings
      </button>
    </div>
  );
}

/**
 * One source card. When the source is enabled but its optional host
 * permission isn't granted, the badge reads "Needs permission" and an Allow
 * button requests it in-place.
 * @param {{adapter: any, stage: string, st: any, status: any, state: any,
 *   actions: any, now: Date}} p
 */
function SourceCard({ adapter, stage, st, status, state, actions, now }) {
  const optional = !!(OPTIONAL_PERMISSION_GROUPS /** @type {any} */)[adapter.id];
  const granted = useSourceAccess(adapter.id);
  const enabled = !(
    state.settings &&
    state.settings.sources &&
    state.settings.sources[adapter.id] &&
    state.settings.sources[adapter.id].enabled === false
  );
  const needsPerm = optional && enabled && granted === false;
  const shown = needsPerm
    ? { label: "Needs permission", tone: "warn", detail: `Allow access to ${adapter.origins[0].replace("https://", "")} so ${adapter.label} can read while you browse.` }
    : status;

  return (
    <section class="card source-card">
      <div class="source-head">
        <span class="mono-tile" aria-hidden="true">
          {monogram(adapter.label)}
        </span>
        <div class="source-title">
          <h3>{adapter.label}</h3>
          {st || stage !== "soon" ? (
            <span class="source-meta tabular">
              {st && st.lastOkAt
                ? `Synced ${fmtAgo(st.lastOkAt, now)}`
                : st && st.lastRunAt
                  ? `Tried ${fmtAgo(st.lastRunAt, now)}`
                  : "Not synced yet"}
              {st && typeof st.itemCount === "number" && st.itemCount > 0
                ? ` · ${st.itemCount} items`
                : ""}
            </span>
          ) : null}
        </div>
        <span class={`badge ${TONE_BADGE[shown.tone]}`}>{shown.label}</span>
      </div>
      {shown.detail ? <p class="source-detail">{shown.detail}</p> : null}
      {stage === "live" && !(adapter.intervalMinutes > 0) && !needsPerm ? (
        <p class="source-detail">Updates while you browse {adapter.label}.</p>
      ) : null}
      {adapter.id === "discord" && !needsPerm ? <DiscordControls st={st} /> : null}
      <div class="source-actions">
        {needsPerm ? (
          <AllowSourceButton sourceId={adapter.id} />
        ) : null}
        {stage === "live" && adapter.sync && adapter.intervalMinutes > 0 && !needsPerm ? (
          <button
            type="button"
            class="btn btn-sm"
            onClick={() => actions.sync(adapter.id)}
          >
            <RefreshIcon size={13} /> Sync now
          </button>
        ) : null}
        {adapter.origins && adapter.origins[0] && !needsPerm ? (
          <button
            type="button"
            class="btn btn-sm"
            onClick={() => actions.open(`${adapter.origins[0]}/`)}
          >
            <ExternalLinkIcon size={13} /> Open site
          </button>
        ) : null}
        {st && !needsPerm ? (
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            onClick={() => {
              if (window.confirm(`Clear all ${adapter.label} data stored on this computer?`)) {
                actions.clearSource(adapter.id);
              }
            }}
          >
            <TrashIcon size={13} /> Clear data
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Discord sweep controls. Everything is click-driven — the adapter never
 * navigates on its own. State lives in sourceState.discord.state.
 * @param {{st: any}} p
 */
function DiscordControls({ st }) {
  const [copied, setCopied] = useState(false);
  const state = (st && st.state) || {};
  const queue = Array.isArray(state.sweepQueue) ? state.sweepQueue : [];
  const unread = Array.isArray(state.unreadWatched) ? state.unreadWatched : [];
  const next = queue[0] || null;

  // Reuse an open Discord tab when there is one; otherwise open a new one.
  const openChannel = async (url) => {
    if (IS_PREVIEW) return;
    try {
      const tabs = await chrome.tabs.query({ url: "https://discord.com/*" });
      const tab = (tabs || []).find((t) => t.id != null && !t.discarded);
      if (tab) await chrome.tabs.update(tab.id, { url, active: true });
      else await chrome.tabs.create({ url });
    } catch {
      /* no tabs permission path — try a plain window open */
      window.open(url, "_blank");
    }
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(inventoryReport(state), null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div class="discord-controls">
      {unread.length ? (
        <div class="discord-unread">
          <p class="source-detail">
            {unread.length} watched channel{unread.length === 1 ? "" : "s"} have new messages
          </p>
          {unread.map((ch) => (
            <button
              key={ch.channelId}
              type="button"
              class="btn btn-sm btn-ghost discord-channel"
              onClick={() => openChannel(ch.url)}
            >
              #{ch.name} · {ch.guildName}
            </button>
          ))}
        </div>
      ) : null}
      <div class="source-actions">
        <button type="button" class="btn btn-sm" onClick={() => send({ type: UI.DISCORD_SWEEP })}>
          <RefreshIcon size={13} /> Start sweep
        </button>
        {next ? (
          <button
            type="button"
            class="btn btn-sm"
            title={`${next.url} · ${queue.length} left`}
            onClick={() => openChannel(next.url)}
          >
            <ArrowRightIcon size={13} /> #{next.name} · {next.guildName} ({queue.length} left)
          </button>
        ) : null}
        <button type="button" class="btn btn-sm btn-ghost" onClick={copyReport}>
          <ClipboardCheckIcon size={13} /> {copied ? "Copied" : "Copy Discord report"}
        </button>
      </div>
    </div>
  );
}
