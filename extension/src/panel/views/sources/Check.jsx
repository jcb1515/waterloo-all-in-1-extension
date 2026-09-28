// @ts-check
// Sources > Check segment: this source's reader checklist (the shared cards
// from checkCards.jsx), its recent reads, Discord's sweep tools, the
// per-source actions and the check-report download.

import { useState } from "preact/hooks";
import { checklistFor, CHECK_SOURCES } from "../../../sources/probes.js";
import { adapterForSource, stageForAdapter } from "../../../core/registry.js";
import { fmtAgo } from "../../model/agenda.js";
import { sourceSiteUrl } from "../../model/sources.js";
import { lastGoodRead } from "../../model/onboarding.js";
import { IS_PREVIEW, send } from "../../data.js";
import { UI } from "../../../core/messages.js";
import { inventoryReport } from "../../../sources/discord/index.js";
import {
  SOURCE_META,
  SourceCheck,
  downloadCheckReport,
} from "./checkCards.jsx";
import { Section } from "../../../ui/Section.jsx";
import { CheckNowButton } from "../../../ui/CheckNowButton.jsx";
import {
  ClipboardCheckIcon,
  RefreshIcon,
  ExternalLinkIcon,
  TrashIcon,
  ArrowRightIcon,
} from "../../../ui/icons.jsx";

const DAY_MS = 86400000;
const RECENT_READS = 8;

/** Item sources that also count for the Outlook segment. */
const EMAIL_SOURCES = ["outlook", "gmail"];

/**
 * The source ids a segment's readStats/items can carry. `outlook` covers
 * both mailboxes — readStats record the concrete source ("gmail"/"outlook").
 * @param {string} sourceId
 */
const sourceIdsFor = (sourceId) =>
  sourceId === "outlook" ? EMAIL_SOURCES : [sourceId];

/**
 * A checklist row's last good read — W1's shared chain (probe ok at →
 * stat.scope → row.id → "sync", over scopeOkAt AND scopeReadAt). The meta id
 * drives the probe lookup while `st` is the segment adapter's sourceState
 * (gmail rows share the outlook adapter's scope maps).
 * @param {any} state @param {string} sourceId @param {any} row @param {any} st
 */
function rowLastOkAt(state, sourceId, row, st) {
  return lastGoodRead(
    { ...state, sourceState: { [sourceId]: st } },
    sourceId,
    row
  );
}

/**
 * A checklist row's "last checked N days ago" warning: only when refreshDays
 * is set and the last good read is older than that.
 * @param {any} state @param {string} sourceId @param {any} row @param {any} st
 * @param {Date} now
 */
function rowStaleText(state, sourceId, row, st, now) {
  if (!row.refreshDays) return null;
  const at = rowLastOkAt(state, sourceId, row, st);
  if (!at) return null;
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) return null;
  const age = now.getTime() - atMs;
  if (!(age > row.refreshDays * DAY_MS)) return null;
  const days = Math.floor(age / DAY_MS);
  return `Last checked ${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * @param {{sourceId: string, state: any, actions: any, now: Date}} props
 */
export function Check({ sourceId, state, actions, now }) {
  const probes = state.probes || {};
  const readStats = Array.isArray(state.readStats) ? state.readStats : [];
  const adapter = adapterForSource(sourceId);
  const st = adapter ? (state.sourceState || {})[adapter.id] || null : null;
  const siteUrl = adapter ? sourceSiteUrl(adapter) : null;
  // The checkable SourceIds this segment covers — the email segment runs
  // both mailboxes' checks (named buttons, like the Sources tiles).
  const checkIds = sourceIdsFor(sourceId).filter((s) => CHECK_SOURCES[s]);

  // The Outlook segment shows both mailboxes' cards — they share one
  // adapter but have separate checklists, probes and readStats.
  const metas = SOURCE_META.filter((m) =>
    sourceId === "outlook" ? m.id === "outlook" || m.id === "gmail" : m.id === sourceId
  );

  const reads = readStats
    .filter((s) => s && sourceIdsFor(sourceId).includes(s.source))
    .slice(-RECENT_READS)
    .reverse();

  const rowExtra = (metaId) => (r) => {
    const row = r && r.row;
    if (!row) return null;
    const stale = rowStaleText(state, metaId, row, st, now);
    if (!row.url && !stale) return null;
    return (
      <>
        {row.url ? (
          <button type="button" class="btn btn-sm" onClick={() => actions.open(row.url)}>
            <ExternalLinkIcon size={12} /> Open
          </button>
        ) : null}
        {stale ? <p class="help status-err">{stale}</p> : null}
      </>
    );
  };

  return (
    <div class="sources-list check-readers">
      {checkIds.length ? (
        <div class="src-page-check">
          {checkIds.map((sid) => (
            <CheckNowButton
              key={sid}
              source={sid}
              state={state}
              actions={actions}
              now={now}
              named={checkIds.length > 1}
            />
          ))}
        </div>
      ) : null}

      {metas.map((m) => (
        <SourceCheck
          key={m.id}
          meta={m}
          rows={checklistFor(
            m.id,
            probes[m.id] || {},
            readStats.filter((s) => s && s.source === m.id),
            now
          )}
          actions={actions}
          rowExtra={rowExtra(m.id)}
        />
      ))}

      <Section title="Recent reads">
        {reads.length ? (
          <ul class="check-rows">
            {reads.map((s, i) => (
              <li class="check-row check-none" key={`${s.at}-${i}`}>
                <div class="check-row-head">
                  <div class="check-row-body">
                    <p class="check-label">
                      {s.kind || "observe"} · {fmtAgo(s.at, now)}
                    </p>
                    <p class="check-status">
                      {s.path || "(no path)"}
                      {typeof s.items === "number"
                        ? ` · ${s.items} item${s.items === 1 ? "" : "s"}`
                        : ""}
                    </p>
                    {s.error ? <p class="check-status status-err">{s.error}</p> : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p class="help">
            No reads recorded yet — reads land here after a sync or a browse of
            the site.
          </p>
        )}
      </Section>

      {adapter && adapter.id === "discord" ? <DiscordCheck st={st} /> : null}

      {adapter ? (
        <div class="source-actions">
          {stageForAdapter(adapter.id) === "live" &&
          adapter.sync &&
          adapter.intervalMinutes > 0 ? (
            <button type="button" class="btn btn-sm" onClick={() => actions.sync(adapter.id)}>
              <RefreshIcon size={13} /> Sync now
            </button>
          ) : null}
          {siteUrl ? (
            <button
              type="button"
              class="btn btn-sm"
              onClick={() => actions.open(siteUrl, { newTab: true })}
            >
              <ExternalLinkIcon size={13} /> Open site
            </button>
          ) : null}
          {st ? (
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              onClick={() => {
                if (
                  window.confirm(
                    `Clear all ${adapter.label} data stored on this computer?`
                  )
                ) {
                  actions.clearSource(adapter.id);
                }
              }}
            >
              <TrashIcon size={13} /> Clear data
            </button>
          ) : null}
        </div>
      ) : null}

      <div class="source-actions">
        <button type="button" class="btn btn-sm" onClick={() => downloadCheckReport(send)}>
          <ClipboardCheckIcon size={13} /> Download check report
        </button>
      </div>
    </div>
  );
}

/**
 * Discord sweep controls + the unread watched-channel list. Everything is
 * click-driven — the adapter never navigates on its own. State lives in
 * sourceState.discord.state.
 * @param {{st: any}} p
 */
function DiscordCheck({ st }) {
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
