// Sources view: a tile per source (status dot · "N picked up" · synced time),
// then a per-source page with the Picked up | Setup | Check segments. Setup
// mounts SETUP[id] from components/setup (W2); PickedUp/Check mount the
// views/sources slots (W3). Missing slots render an EmptyState.

import { useMemo, useState } from "preact/hooks";
import { ADAPTERS, stageForAdapter } from "../../core/registry.js";
import { sourceStatus } from "../model/sources.js";
import { fmtAgo } from "../model/agenda.js";
import { onboardingRows, nudges as visitNudges } from "../model/onboarding.js";
import { OnboardingCard, NudgeCard } from "../../ui/Onboarding.jsx";
import { IS_PREVIEW, send } from "../data.js";
import { UI } from "../../core/messages.js";
import {
  GROUP_LABELS,
  neededGroups,
  OPTIONAL_PERMISSION_GROUPS,
  requestSourceAccess,
} from "../../core/permissions.js";
import { AllowSourceButton, useAccessMap } from "../../ui/permissions.jsx";
import { Toggle } from "../../ui/bits.jsx";
import { Segmented } from "../../ui/Segmented.jsx";
import { EmptyState } from "../../ui/EmptyState.jsx";
import { sourceColorVar, sourceGlyph, sourceLabel } from "../../ui/sourceLabel.js";
import { inventoryReport } from "../../sources/discord/index.js";
import { SETUP } from "../components/setup/index.js";
import { PickedUp } from "./sources/PickedUp.jsx";
import { Check } from "./sources/Check.jsx";
import {
  RefreshIcon,
  ExternalLinkIcon,
  TrashIcon,
  ShieldIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  ClipboardCheckIcon,
  SettingsIcon,
} from "../../ui/icons.jsx";

const TONE_BADGE = { ok: "badge-ok", warn: "badge-warn", danger: "badge-danger", muted: "badge-muted" };

/** Open an external page in a new tab — click handlers only. */
function openExternal(url) {
  if (IS_PREVIEW) {
    window.open(url, "_blank");
    return;
  }
  try {
    chrome.tabs.create({ url });
  } catch {
    window.open(url, "_blank");
  }
}

const SEGMENTS = [
  ["picked", "Picked up"],
  ["setup", "Setup"],
  ["check", "Check"],
];

/**
 * @param {{state: any, actions: any, now: Date, onGoCourses?: () => void,
 *   onOpenCheck?: () => void}} props
 */
export function Sources({ state, actions, now, onGoCourses, onOpenCheck }) {
  const [sourceId, setSourceId] = useState(query0("source") || null);
  const [segment, setSegment] = useState(() => query0("seg") || "picked");

  const cards = useMemo(
    () =>
      ADAPTERS.map((a) => {
        const stage = stageForAdapter(a.id);
        const st = (state.sourceState || {})[a.id] || null;
        return { adapter: a, stage, st, status: sourceStatus(a, st, stage, now) };
      }),
    [state.sourceState, now]
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

  const card = sourceId ? cards.find((c) => c.adapter.id === sourceId) : null;

  if (card) {
    return (
      <SourcePage
        card={card}
        state={state}
        actions={actions}
        now={now}
        segment={segment}
        setSegment={setSegment}
        onBack={() => setSourceId(null)}
        onGoCourses={onGoCourses}
        onOpenCheck={onOpenCheck}
      />
    );
  }

  return (
    <div class="sources-view">
      <div class="sources-tiles" role="list">
        {cards.map(({ adapter, st, status }) => {
          const src = (state.settings && state.settings.sources && state.settings.sources[adapter.id]) || {};
          const enabled = adapter.id === "gcal" ? src.enabled === true : src.enabled !== false;
          const name = adapter.id === "gcal" ? sourceLabel("gcal", null) : adapter.label;
          const meta = !enabled
            ? "Off"
            : adapter.id === "gcal"
              ? "Duplicate check"
              : `${
                  st && typeof st.itemCount === "number" && st.itemCount > 0
                    ? `${st.itemCount} picked up`
                    : "Nothing picked up yet"
                } · ${
                  st && st.lastOkAt
                    ? `synced ${fmtAgo(st.lastOkAt, now)}`
                    : st && st.lastRunAt
                      ? `tried ${fmtAgo(st.lastRunAt, now)}`
                      : "not synced yet"
                }`;
          const tone = enabled ? status.tone : "muted";
          return (
            <button
              key={adapter.id}
              type="button"
              class={`src-tile${enabled ? "" : " off"}`}
              role="listitem"
              title={`${name} — ${status.label}`}
              aria-label={`${name}: ${meta}. Status: ${status.label}`}
              onClick={() => {
                setSourceId(adapter.id);
                setSegment("picked");
              }}
            >
              <span class="src-tile-icon" style={{ "--src": sourceColorVar(adapter.id) }} aria-hidden="true">
                {sourceGlyph(adapter.id)}
              </span>
              <span class="src-tile-text">
                <span class="src-tile-name">{name}</span>
                <span class="src-tile-meta tabular">{meta}</span>
              </span>
              <span
                class={`src-status-dot tone-${tone}`}
                title={status.label}
                aria-label={`Status: ${status.label}`}
                role="img"
              />
            </button>
          );
        })}
      </div>
      <div class="source-actions">
        <button type="button" class="btn btn-sm" onClick={() => actions.sync()}>
          <RefreshIcon size={13} /> Sync all
        </button>
        {onOpenCheck ? (
          <button type="button" class="btn btn-sm" onClick={onOpenCheck}>
            <ClipboardCheckIcon size={13} /> Check readers
          </button>
        ) : null}
      </div>
      <button type="button" class="btn btn-ghost sources-privacy" onClick={() => openOptions("#privacy")}>
        <ShieldIcon size={14} /> Privacy &amp; discovery settings
      </button>
      <button type="button" class="btn btn-ghost sources-privacy" onClick={() => openOptions("#advanced")}>
        <SettingsIcon size={14} /> Advanced settings
      </button>
    </div>
  );
}

/**
 * One source's page: header (name, status, Enabled toggle), the Segmented
 * picker, the three slot segments and the per-source actions.
 * @param {{card: any, state: any, actions: any, now: Date, segment: string,
 *   setSegment: (s: string) => void, onBack: () => void,
 *   onGoCourses?: () => void, onOpenCheck?: () => void}} p
 */
function SourcePage({ card, state, actions, now, segment, setSegment, onBack, onOpenCheck }) {
  const { adapter, stage, st, status } = card;
  const src = (state.settings && state.settings.sources && state.settings.sources[adapter.id]) || {};
  const enabled = adapter.id === "gcal" ? src.enabled === true : src.enabled !== false;
  const [denied, setDenied] = useState(false);

  // This source's slice of the setup checklist and its stale-read nudges.
  const onboard = useMemo(
    () => onboardingRows(state, now).filter((r) => r.source === adapter.id),
    [state.probes, state.sourceState, state.settings, state.userState, now, adapter.id]
  );
  const onboardHidden =
    !onboard.length ||
    onboard.every((r) => r.done) ||
    !!(state.userState && state.userState.onboardingDismissedAt);
  const visits = useMemo(
    () => visitNudges(state, now).filter((n) => n.source === adapter.id),
    [state.probes, state.sourceState, state.settings, state.userState, now, adapter.id]
  );

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

  const Setup = SETUP[adapter.id];

  return (
    <div class="src-page">
      <button type="button" class="linklike src-back" onClick={onBack}>
        <ArrowLeftIcon size={13} /> All sources
      </button>
      <div class="src-page-head">
        <div class="source-title">
          <h3>{adapter.label}</h3>
          <span class="source-meta tabular">
            {enabled
              ? st && st.lastOkAt
                ? `Synced ${fmtAgo(st.lastOkAt, now)}`
                : st && st.lastRunAt
                  ? `Tried ${fmtAgo(st.lastRunAt, now)}`
                  : "Not synced yet"
              : "Off"}
            {st && typeof st.itemCount === "number" && st.itemCount > 0 ? ` · ${st.itemCount} items` : ""}
          </span>
        </div>
        {enabled ? <span class={`badge ${TONE_BADGE[shown.tone]}`}>{shown.label}</span> : null}
        <Toggle label="Enabled" checked={enabled} onChange={onToggle} />
      </div>
      {denied ? (
        <p class="help status-err">
          Permission wasn't granted — {adapter.label} stays off. The browser prompt asks for access
          to {adapter.origins[0].replace("https://", "")}; allow it, then toggle again.
        </p>
      ) : null}
      {shown.detail ? <p class="source-detail">{shown.detail}</p> : null}
      {missing.map((g) => (
        <AllowSourceButton key={g} sourceId={g} label={`Allow ${GROUP_LABELS[g] || g}`} />
      ))}

      {onboardHidden ? null : (
        <OnboardingCard rows={onboard} onOpen={openExternal} onDismiss={actions.dismissOnboarding} />
      )}

      <Segmented options={SEGMENTS} value={segment} onChange={setSegment} ariaLabel={`${adapter.label} sections`} />

      {segment === "picked" ? (
        <PickedUp sourceId={adapter.id} state={state} actions={actions} now={now} />
      ) : segment === "setup" ? (
        Setup ? (
          <Setup state={state} actions={actions} />
        ) : (
          <EmptyState
            icon={SettingsIcon}
            title="Setup is in Settings"
            text={`${adapter.label} options live in the Settings page for now.`}
          >
            <OpenOptionsLink hash="#sources" />
          </EmptyState>
        )
      ) : (
        <>
          <NudgeCard nudges={visits} onOpen={openExternal} onSnooze={actions.snoozeNudge} />
          <Check sourceId={adapter.id} state={state} actions={actions} now={now} />
        </>
      )}

      {enabled ? (
        <div class="source-actions">
          {stage === "live" && adapter.sync && adapter.intervalMinutes > 0 && !needsPerm ? (
            <button type="button" class="btn btn-sm" onClick={() => actions.sync(adapter.id)}>
              <RefreshIcon size={13} /> Sync now
            </button>
          ) : null}
          {adapter.origins && adapter.origins[0] && !needsPerm ? (
            <button type="button" class="btn btn-sm" onClick={() => actions.open(`${adapter.origins[0]}/`)}>
              <ExternalLinkIcon size={13} /> Open site
            </button>
          ) : null}
          {adapter.id === "discord" && !needsPerm ? <DiscordControls st={st} /> : null}
          {adapter.id === "outlook" && !needsPerm ? <EmailScanControls st={st} /> : null}
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
      ) : null}
    </div>
  );
}

/** Settings link that works in preview (hash nav) and the real extension. */
function OpenOptionsLink({ hash }) {
  const open = () => {
    const url = IS_PREVIEW ? `/src/options/options.html${hash}` : chrome.runtime.getURL(`src/options/options.html${hash}`);
    try {
      if (!IS_PREVIEW && chrome.tabs) {
        chrome.tabs.create({ url });
        return;
      }
    } catch {
      /* fall through */
    }
    window.open(url, "_blank");
  };
  return (
    <button type="button" class="btn btn-sm" onClick={open}>
      <SettingsIcon size={13} /> Open Settings
    </button>
  );
}

/**
 * Discord sweep controls (kept on the source page's action row until W3's
 * Check segment lands). Everything is click-driven — the adapter never
 * navigates on its own.
 * @param {{st: any}} p
 */
function DiscordControls({ st }) {
  const [copied, setCopied] = useState(false);
  const state = (st && st.state) || {};
  const queue = Array.isArray(state.sweepQueue) ? state.sweepQueue : [];
  const next = queue[0] || null;

  const openChannel = async (url) => {
    if (IS_PREVIEW) return;
    try {
      const tabs = await chrome.tabs.query({ url: "https://discord.com/*" });
      const tab = (tabs || []).find((t) => t.id != null && !t.discarded);
      if (tab) await chrome.tabs.update(tab.id, { url, active: true });
      else await chrome.tabs.create({ url });
    } catch {
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
    <>
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
        <ClipboardCheckIcon size={13} /> {copied ? "Copied" : "Copy report"}
      </button>
    </>
  );
}

/**
 * Guided mail-scan progress (kept on the source page's action row). While
 * sourceState.outlook.state.scan is set, the next queued subject is a
 * click-through into the user's own mail tab; Stop clears the scan.
 * @param {{st: any}} p
 */
function EmailScanControls({ st }) {
  const state = (st && st.state) || {};
  const scan = state.scan;
  const queue = Array.isArray(state.scanQueue) ? state.scanQueue : [];
  const next = queue[0] || null;
  if (!scan) return null;

  const providerLabel = scan.provider === "gmail" ? "Gmail" : "Outlook";
  const hostPatterns = /** @type {Record<string, string[]>} */ (OPTIONAL_PERMISSION_GROUPS)[scan.provider] || [];

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
    <>
      {next ? (
        <button
          type="button"
          class="btn btn-sm"
          title={`Mail scan — ${next.url}`}
          onClick={() => openQueued(next.url)}
        >
          <ArrowRightIcon size={13} /> Mail scan ({queue.length} left): {next.subject}
        </button>
      ) : (
        <span class="source-detail">Mail scan running — {providerLabel}, queue empty.</span>
      )}
      <button type="button" class="btn btn-sm btn-ghost" onClick={() => send({ type: UI.MAIL_SCAN_STOP })}>
        Stop scan
      </button>
    </>
  );
}

function query0(name) {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}
