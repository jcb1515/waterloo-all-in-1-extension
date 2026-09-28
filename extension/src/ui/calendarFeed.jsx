// @ts-check
// Shared calendar-feed pieces used by the options Calendar section and the
// side panel's Calendar tab: feed URL masking, the Google "Add" link, the
// Copy button, the include toggles, and the split-by-type group feeds.

import { useState } from "preact/hooks";
import { Field, Toggle } from "./bits.jsx";
import { ExternalLinkIcon } from "./icons.jsx";

export const GROUP_LABELS = [
  ["classes", "Classes"],
  ["deadlines", "Deadlines & exams"],
  ["coop", "Co-op"],
  ["teams", "Teams"],
  ["other", "Other"],
];

/** Mask a secret feed URL: keep origin + first/last 4 of the feed id. */
export function maskUrl(url) {
  try {
    const u = new URL(url);
    const id = u.pathname.match(/calendars\/(.+)\.ics$/)?.[1] || "";
    const masked = id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : "…";
    return `${u.origin}/v1/calendars/${masked}.ics`;
  } catch {
    return "…";
  }
}

/** @param {string} feedUrl */
export const googleAddUrl = (feedUrl) =>
  `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(
    String(feedUrl).replace(/^https:/, "webcal:")
  )}`;

/** Copy helper — clipboard API where available. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{url: string, label?: string, add?: boolean, reveal?: boolean}} p
 * one feed URL row: masked text + copy (+ Reveal/Add). `reveal: false` keeps
 * the raw URL out of the DOM entirely (the panel never shows it).
 */
export function FeedLink({ url, label, add, reveal = true }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const visible = reveal && shown;
  return (
    <div class="feed-link">
      {label ? <span class="feed-link-label">{label}</span> : null}
      <code class="feed-url">{visible ? url : maskUrl(url)}</code>
      <span class="feed-link-acts">
        {reveal ? (
          <button type="button" class="btn btn-sm" onClick={() => setShown((v) => !v)}>
            {shown ? "Hide" : "Reveal"}
          </button>
        ) : null}
        <button
          type="button"
          class="btn btn-sm"
          onClick={async () => {
            if (await copyText(url)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {add ? (
          <a
            class="btn btn-sm btn-primary"
            href={googleAddUrl(url)}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLinkIcon size={12} /> Add
          </a>
        ) : null}
      </span>
    </div>
  );
}

/** @param {string|undefined} iso @param {boolean} [future] */
export function relAgo(iso, future) {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const d = Math.abs(Date.now() - t);
  const m = Math.floor(d / 60000);
  const s = m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
  return future ? `in ~${m < 60 ? `${Math.max(1, m)} min` : `${Math.floor(m / 60)} h`}` : s;
}

/**
 * One-line feed status ("Published 3m ago · 80 events · 2 duplicates merged").
 * Returns "" for other statuses — callers render Publishing…/error separately.
 * @param {any} feed calendarFeed runtime state
 */
export function feedStatusLine(feed) {
  if (!feed || feed.status !== "ok") return "";
  let s = `Published ${relAgo(feed.lastPublishedAt)}`;
  if (typeof feed.eventCount === "number") s += ` · ${feed.eventCount} events`;
  if (feed.collapsed > 0) s += ` · ${feed.collapsed} duplicates merged`;
  return s;
}

/**
 * The "Include" toggles shared by options and the panel's "What's included"
 * disclosure. `patch` is a calendar-slice writer ({include: …}, {split: v}).
 * The alarms toggle stays options-only.
 * @param {{cal: any, patch: (p: any) => void}} p
 */
export function IncludeToggles({ cal, patch }) {
  return (
    <Field label="Include">
      <div class="toggle-col">
        <Toggle label="Classes, tutorials and labs" checked={cal.include?.classes !== false} onChange={(v) => patch({ include: { ...(cal.include || {}), classes: v } })} />
        {cal.include?.classes !== false ? (
          <div class="inline-row class-weeks">
            <span class="help">Weeks of classes ahead</span>
            <input
              class="input num-input"
              type="number"
              min={1}
              max={20}
              value={cal.include?.classWeeks ?? 8}
              onChange={(e) => {
                const n = Math.round(Number(/** @type {any} */ (e.target).value));
                if (!Number.isFinite(n)) return;
                patch({ include: { ...(cal.include || {}), classWeeks: Math.min(20, Math.max(1, n)) } });
              }}
            />
          </div>
        ) : null}
        <Toggle label="Tentative items" checked={cal.include?.tentative !== false} onChange={(v) => patch({ include: { ...(cal.include || {}), tentative: v } })} />
        <Toggle label="Completed items" checked={cal.include?.completed !== false} onChange={(v) => patch({ include: { ...(cal.include || {}), completed: v } })} />
        <Toggle label="Term dates" checked={cal.include?.termDates !== false} onChange={(v) => patch({ include: { ...(cal.include || {}), termDates: v } })} />
      </div>
      <p class="help">
        Gmail invitations are skipped — Google already adds them to your calendar.
      </p>
    </Field>
  );
}

/**
 * "Separate calendars by type" toggle plus per-group feed links. Used by the
 * options card and the panel's "What's included" disclosure.
 * @param {{cal: any, feed: any, patch: (p: any) => void, reveal?: boolean}} p
 */
export function SplitCalendars({ cal, feed, patch, reveal = true }) {
  return (
    <>
      <Toggle
        label="Separate calendars by type"
        checked={!!cal.split}
        onChange={(v) => patch({ split: v })}
      />
      {cal.split && feed && feed.groupFeeds ? (
        <>
          <p class="help status-err">
            Subscribe to either the single calendar or the separate ones, not both, or
            events appear twice.
          </p>
          {GROUP_LABELS.map(([key, label]) => {
            const g = feed.groupFeeds[key];
            const url = (g && (g.feedUrl || g)) || null;
            return url ? <FeedLink key={key} url={url} label={label} add reveal={reveal} /> : null;
          })}
        </>
      ) : null}
    </>
  );
}
