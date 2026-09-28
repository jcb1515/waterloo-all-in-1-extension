// Sources view: one setup card per adapter — enabled toggle, status badge,
// a one-line description, and the per-source setup blocks (outline -> the
// Courses tab, email providers + guided scan, Discord servers/channels,
// Google Calendar duplicate check). Disabled cards collapse to the header.

import { useMemo, useState } from "preact/hooks";
import { ADAPTERS, stageForAdapter } from "../../core/registry.js";
import { sourceStatus } from "../model/sources.js";
import { fmtAgo } from "../model/agenda.js";
import { IS_PREVIEW, send } from "../data.js";
import { UI } from "../../core/messages.js";
import {
  GROUP_LABELS,
  neededGroups,
  OPTIONAL_PERMISSION_GROUPS,
  requestSourceAccess,
} from "../../core/permissions.js";
import { AllowSourceButton, useAccessMap } from "../../ui/permissions.jsx";
import { Toggle } from "../../options/bits.jsx";
import { inventoryReport } from "../../sources/discord/index.js";
import { EmailProviders, MailScan } from "../components/EmailSetup.jsx";
import { DiscordChannels, DiscordWatched } from "../components/DiscordSetup.jsx";
import {
  RefreshIcon,
  ExternalLinkIcon,
  TrashIcon,
  ShieldIcon,
  ArrowRightIcon,
  ClipboardCheckIcon,
  SettingsIcon,
} from "../../ui/icons.jsx";

const TONE_BADGE = { ok: "badge-ok", warn: "badge-warn", danger: "badge-danger", muted: "badge-muted" };

/** One-line "what does this source do" text per adapter. */
const SOURCE_HELP = {
  learn: "Reads classes, deadlines and announcements while you browse Learn.",
  outline: "Course outline pages, plus imported outline pages and PDFs.",
  portal: "Reads your course sections while you browse Portal.",
  outlook: "Calendar invites and dated mail in Outlook/Gmail tabs you open.",
  waterlooworks: "Applications, interviews and deadlines while you browse.",
  discord: "Dated messages in servers you read — passive, never posts.",
  gcal: "Skip events already on my calendar — reads event titles and times from your own calendars only, so nothing is published twice. Subscribed calendars (including this extension's own feed) never suppress anything, and nothing it reads leaves your browser.",
};

/** Monogram from a label: "Course outlines" -> "Co", "WaterlooWorks" -> "Wa". */
function monogram(label) {
  const words = String(label).replace(/\(.*\)/, "").trim().split(/\s+/);
  const first = words[0] || "?";
  const second = words.length > 1 ? words[1] : first.slice(1);
  return (first[0] + (second[0] || "")).toUpperCase();
}

/**
 * @param {{state: any, actions: any, now: Date, onGoCourses?: () => void}} props
 */
export function Sources({ state, actions, now, onGoCourses }) {
  const cards = useMemo(
    () =>
      ADAPTERS.map((a) => {
        const stage = stageForAdapter(a.id);
        const st = (state.sourceState || {})[a.id] || null;
        return { adapter: a, stage, st, status: sourceStatus(a, st, stage, now) };
      }),
    [state.sourceState]
  );

  const openOptions = (hash) => {
    const url = IS_PREVIEW
      ? `/src/options/options.html${hash}`
      : chrome.runtime.getURL(`src/options/options.html${hash}`);
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
          onGoCourses={onGoCourses}
        />
      ))}
      <button
        type="button"
        class="btn btn-ghost sources-privacy"
        onClick={() => openOptions("#privacy")}
      >
        <ShieldIcon size={14} /> Privacy &amp; discovery settings
      </button>
      <button
        type="button"
        class="btn btn-ghost sources-privacy"
        onClick={() => openOptions("#advanced")}
      >
        <SettingsIcon size={14} /> Advanced settings
      </button>
    </div>
  );
}

/**
 * One source card. The Enabled toggle drives sources.<id>.enabled through
 * actions.saveSettings; enabling discord/gcal asks for its host group inside
 * the click (denied -> stays off with a note). When the source is enabled
 * but its optional host permission isn't granted, the badge reads "Needs
 * permission" and an Allow button requests it in-place.
 * @param {{adapter: any, stage: string, st: any, status: any, state: any,
 *   actions: any, now: Date, onGoCourses?: () => void}} p
 */
function SourceCard({ adapter, stage, st, status, state, actions, now, onGoCourses }) {
  const src = (state.settings && state.settings.sources && state.settings.sources[adapter.id]) || {};
  // gcal is the one source that's off until the user turns it on — nothing
  // reads Google Calendar unless the toggle (and its permission) is on.
  const enabled =
    adapter.id === "gcal" ? src.enabled === true : src.enabled !== false;
  const [denied, setDenied] = useState(false);

  const needed = neededGroups(adapter.id, src);
  const access = useAccessMap(needed);
  const missing = needed.filter((g) => access[g] === false);
  const needsPerm = missing.length > 0;
  const shown = needsPerm
    ? {
        label: "Needs permission",
        tone: "warn",
        detail: `Allow ${missing
          .map((g) => GROUP_LABELS[g] || g)
          .join(" and ")} access so ${adapter.label} can read while you browse.`,
      }
    : status;

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

  const save = (patch) =>
    actions.saveSettings({ sources: { [adapter.id]: { ...src, ...patch } } });

  return (
    <section class="card source-card">
      <div class="source-head">
        <span class="mono-tile" aria-hidden="true">
          {monogram(adapter.label)}
        </span>
        <div class="source-title">
          <h3>{adapter.label}</h3>
          {enabled && (st || stage !== "soon") ? (
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
        {enabled ? (
          <span class={`badge ${TONE_BADGE[shown.tone]}`}>{shown.label}</span>
        ) : null}
        <Toggle
          label="Enabled"
          checked={enabled}
          onChange={onToggle}
        />
      </div>
      {SOURCE_HELP[adapter.id] ? (
        <p class="source-detail">{SOURCE_HELP[adapter.id]}</p>
      ) : null}
      {denied ? (
        <p class="help status-err">
          Permission wasn't granted — {adapter.label} stays off. The browser
          prompt asks for access to{" "}
          {adapter.origins[0].replace("https://", "")}; allow it, then toggle
          again.
        </p>
      ) : null}
      {!enabled ? null : (
        <>
          {shown.detail ? <p class="source-detail">{shown.detail}</p> : null}
          {stage === "live" && !(adapter.intervalMinutes > 0) && !needsPerm ? (
            <p class="source-detail">Updates while you browse {adapter.label}.</p>
          ) : null}
          {adapter.id === "outline" && !needsPerm ? (
            <p>
              <button
                type="button"
                class="btn btn-sm"
                onClick={() => onGoCourses && onGoCourses()}
              >
                Manage outlines in Courses
              </button>
            </p>
          ) : null}
          {adapter.id === "outlook" && !needsPerm ? (
            <>
              <EmailProviders src={src} save={save} />
              <MailScan src={src} />
              <EmailScanControls st={st} />
            </>
          ) : null}
          {adapter.id === "discord" && !needsPerm ? (
            <>
              <DiscordWatched src={src} save={save} />
              <DiscordChannels
                discordState={st && st.state}
                src={src}
                actions={actions}
              />
              <DiscordControls st={st} />
            </>
          ) : null}
          <div class="source-actions">
            {missing.map((g) => (
              <AllowSourceButton
                key={g}
                sourceId={g}
                label={`Allow ${GROUP_LABELS[g] || g}`}
              />
            ))}
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
        </>
      )}
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

/**
 * Guided mail-scan progress. While sourceState.outlook.state.scan is set,
 * the next queued subject is a click-through into the user's own mail tab;
 * Stop clears the scan. Nothing navigates without a click.
 * @param {{st: any}} p
 */
function EmailScanControls({ st }) {
  const state = (st && st.state) || {};
  const scan = state.scan;
  const queue = Array.isArray(state.scanQueue) ? state.scanQueue : [];
  const next = queue[0] || null;
  if (!scan) return null;

  const providerLabel = scan.provider === "gmail" ? "Gmail" : "Outlook";
  const hostPatterns =
    /** @type {Record<string, string[]>} */ (OPTIONAL_PERMISSION_GROUPS)[scan.provider] || [];

  /** Open a queued thread in the provider's existing mail tab, else a new tab. */
  const openQueued = async (url) => {
    if (IS_PREVIEW || !url) return;
    try {
      const tabs = hostPatterns.length ? await chrome.tabs.query({ url: hostPatterns }) : [];
      const tab = (tabs || []).find((t) => t.id != null && !t.discarded);
      if (tab) await chrome.tabs.update(tab.id, { url, active: true });
      else await chrome.tabs.create({ url });
    } catch {
      window.open(url, "_blank");
    }
  };

  return (
    <div class="mail-scan-controls">
      <p class="source-detail">
        Mail scan running — {providerLabel}, last {scan.days} days.
      </p>
      <div class="source-actions">
        {next ? (
          <button
            type="button"
            class="btn btn-sm"
            title={next.url}
            onClick={() => openQueued(next.url)}
          >
            <ArrowRightIcon size={13} /> Next ({queue.length} left): {next.subject}
          </button>
        ) : (
          <span class="source-detail">Queue empty — open the search results to feed it.</span>
        )}
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          onClick={() => send({ type: UI.MAIL_SCAN_STOP })}
        >
          Stop
        </button>
      </div>
    </div>
  );
}
