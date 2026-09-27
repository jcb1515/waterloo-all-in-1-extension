// @ts-check
// Calendar settings: feed server URL + health check, the opt-in publish
// toggle, masked feed/group URLs with Copy and Add-to-Google buttons, the
// include switches and the publish status line.

import { useState } from "preact/hooks";
import { Card, Field, Toggle } from "../bits.jsx";
import { send, IS_PREVIEW } from "../../panel/data.js";
import { UI } from "../../core/messages.js";
import { mutateKey } from "../../core/store.js";
import { validServiceUrl, FEED_KEY } from "../../calendar/publish.js";
import { buildFeedPayload } from "../../calendar/payload.js";
// Pure feed renderers shared with the worker — same UIDs as the live feed.
import { applyPublish, buildCalendar } from "../../../../server/src/worker.js";
import {
  ExternalLinkIcon,
  CheckIcon,
  AlertTriangleIcon,
  RefreshIcon,
} from "../../ui/icons.jsx";

const GROUP_LABELS = [
  ["classes", "Classes"],
  ["deadlines", "Deadlines & exams"],
  ["coop", "Co-op"],
  ["teams", "Teams"],
  ["other", "Other"],
];

/** Mask a secret feed URL: keep origin + first/last 4 of the feed id. */
function maskUrl(url) {
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
const googleAddUrl = (feedUrl) =>
  `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(
    String(feedUrl).replace(/^https:/, "webcal:")
  )}`;

/** Copy helper — clipboard API where available. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** @param {{url: string, label?: string, add?: boolean}} p one feed URL row: masked text + reveal/copy (+ Add for group feeds) */
function FeedLink({ url, label, add }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div class="feed-link">
      {label ? <span class="feed-link-label">{label}</span> : null}
      <code class="feed-url">{shown ? url : maskUrl(url)}</code>
      <span class="feed-link-acts">
        <button type="button" class="btn btn-sm" onClick={() => setShown((v) => !v)}>
          {shown ? "Hide" : "Reveal"}
        </button>
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

/**
 * @param {{settings: any, save: (patch: any) => void, state: any}} p
 */
export function CalendarSection({ settings, save, state }) {
  const cal = (settings.calendar) || {};
  const feed = state.calendarFeed;
  const [testState, setTestState] = useState(/** @type {any} */ (null));
  const [confirmStop, setConfirmStop] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);

  const origin = validServiceUrl(cal.serviceUrl);
  const published = feed && feed.status === "ok" && feed.feedUrl;

  const patch = (p) => save({ calendar: p });

  const testConnection = async () => {
    if (!origin) return;
    setTestState({ busy: true });
    try {
      const res = await fetch(`${origin}/health`);
      const body = await res.json();
      if (res.ok && body && body.ok) {
        setTestState({ ok: true, feeds: body.feeds });
      } else {
        setTestState({ ok: false, error: `HTTP ${res.status}` });
      }
    } catch (e) {
      setTestState({ ok: false, error: String((e && /** @type {any} */ (e).message) || e) });
    }
  };

  const publishNow = () => {
    if (IS_PREVIEW) return;
    send({ type: UI.CALENDAR_PUBLISH });
  };
  const stopSync = async () => {
    if (!IS_PREVIEW) await send({ type: UI.CALENDAR_STOP });
    setConfirmStop(false);
  };
  const dismissResubscribe = () => {
    if (IS_PREVIEW) return;
    mutateKey(FEED_KEY, (cur) => (cur ? { ...cur, needsResubscribe: false } : cur)).catch(() => {});
  };

  const [icsNote, setIcsNote] = useState("");
  /** One-off .ics export — same payload builder + UID mapping as the feed. */
  const downloadIcs = () => {
    const now = new Date();
    const { payload } = buildFeedPayload(state.items || {}, state.userState || {}, cal, now, {
      acceptPending: !!(settings.review && settings.review.showPending),
    });
    const { state: feedState } = applyPublish(null, payload, now);
    const ics = buildCalendar(feedState, {});
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `waterloo-all-in-1-${now.toISOString().slice(0, 10)}.ics`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const n = (feedState.events || []).length;
    setIcsNote(`${n} event${n === 1 ? "" : "s"} exported`);
  };

  return (
    <div class="opt-stack">
      <Card title="Calendar server">
        <Field
          label="Feed server URL"
          help="Deploy your own server (see server/README.md in the repo) or use one someone shares with you."
        >
          <div class="inline-row">
            <input
              class="input"
              type="url"
              value={cal.serviceUrl || ""}
              placeholder="https://waterloo-all-in-1-feed.<you>.workers.dev"
              onInput={(e) => patch({ serviceUrl: /** @type {any} */ (e.target).value.trim() })}
            />
            <button
              type="button"
              class="btn"
              disabled={!origin || (testState && testState.busy)}
              onClick={testConnection}
            >
              {testState && testState.busy ? "Testing…" : "Test"}
            </button>
          </div>
        </Field>
        {testState && !testState.busy ? (
          testState.ok ? (
            <p class="help status-ok"><CheckIcon size={12} /> Connected · {testState.feeds ?? 0} feeds</p>
          ) : (
            <p class="help status-err"><AlertTriangleIcon size={12} /> {testState.error}</p>
          )
        ) : null}
      </Card>

      <Card title="Google Calendar sync">
        <p class="help">
          Turning this on sends your events' titles, times, locations and links to the server
          above so Google Calendar can subscribe. The feed link is private — anyone with it
          can see your calendar.
        </p>
        <Toggle
          label="Publish to a calendar feed"
          checked={!!cal.enabled}
          disabled={!origin}
          onChange={(v) => patch({ enabled: v })}
        />
        {!origin ? (
          <p class="help">Enter a valid https server URL above to enable sync.</p>
        ) : null}

        {cal.enabled ? (
          <>
            {feed && feed.needsResubscribe ? (
              <div class="banner banner-warn" role="alert">
                <AlertTriangleIcon size={14} />
                <span>
                  Your calendar link changed — remove the old calendar in Google and add this one.
                </span>
                <button type="button" class="btn btn-sm" onClick={dismissResubscribe}>
                  Dismiss
                </button>
              </div>
            ) : null}

            {published ? (
              <>
                <FeedLink url={feed.feedUrl} />
                <a
                  class="btn btn-primary"
                  href={googleAddUrl(feed.feedUrl)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLinkIcon size={13} /> Add to Google Calendar
                </a>
                <details class="help-details">
                  <summary>Manual steps</summary>
                  <p class="help">
                    Google Calendar → Other calendars “+” → From URL → paste the feed link above.
                  </p>
                </details>

                <Toggle
                  label="Separate calendars by type"
                  checked={!!cal.split}
                  onChange={(v) => patch({ split: v })}
                />
                {cal.split && feed.groupFeeds ? (
                  <>
                    <p class="help status-err">
                      Subscribe to either the single calendar or the separate ones, not both, or
                      events appear twice.
                    </p>
                    {GROUP_LABELS.map(([key, label]) => {
                      const g = feed.groupFeeds[key];
                      const url = (g && (g.feedUrl || g)) || null;
                      return url ? <FeedLink key={key} url={url} label={label} add /> : null;
                    })}
                  </>
                ) : null}
              </>
            ) : (
              <p class="help">Not published yet — it publishes a minute after the next change, or press Publish now.</p>
            )}

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
                <Toggle label="Reminders in the feed (Apple/Outlook only; Google ignores them)" checked={!!cal.alarms} onChange={(v) => patch({ alarms: v })} />
              </div>
            </Field>

            {feed && feed.status === "ok" ? (
              <p class="help status-ok">
                <CheckIcon size={12} /> Published {relAgo(feed.lastPublishedAt)} · {feed.eventCount} events
                {feed.skipped && feed.skipped.length ? (
                  <>
                    {" "}· {feed.skipped.length} skipped{" "}
                    <button type="button" class="linklike" onClick={() => setShowSkipped((v) => !v)}>
                      {showSkipped ? "hide" : "why"}
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
            {showSkipped && feed && feed.skipped ? (
              <ul class="help skipped-list">
                {feed.skipped.map((/** @type {any} */ s) => (
                  <li key={s.id}><code>{s.id}</code> — {s.reason}</li>
                ))}
              </ul>
            ) : null}
            {feed && feed.status === "error" ? (
              <p class="help status-err">
                <AlertTriangleIcon size={12} /> {feed.error || "Publish failed"}
                {feed.retryAt ? ` · retrying ${relAgo(feed.retryAt, true)}` : ""}
              </p>
            ) : null}
            {feed && feed.status === "publishing" ? <p class="help">Publishing…</p> : null}

            <div class="inline-row">
              <button type="button" class="btn" onClick={publishNow}>
                <RefreshIcon size={13} /> Publish now
              </button>
            </div>
            {confirmStop ? (
              <div class="inline-row">
                <span class="help">Delete the feed and turn sync off?</span>
                <button type="button" class="btn btn-danger btn-sm" onClick={stopSync}>
                  Delete feed
                </button>
                <button type="button" class="btn btn-sm" onClick={() => setConfirmStop(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" class="linklike danger" onClick={() => setConfirmStop(true)}>
                Stop syncing and delete feed
              </button>
            )}

            <p class="help">
              Google refreshes subscribed calendars every few hours (sometimes up to a day).
              The side panel is always instant.
            </p>
          </>
        ) : null}
      </Card>

      <Card title="Download a calendar file">
        <p class="help">
          For a one-time copy only. Don't import it into the same Google calendar you subscribe
          to — events would appear twice. The subscription above stays up to date on its own.
        </p>
        <div class="inline-row">
          <button type="button" class="btn" onClick={downloadIcs}>
            Download .ics
          </button>
          {icsNote ? <span class="help">{icsNote}</span> : null}
        </div>
      </Card>
    </div>
  );
}

/** @param {string|undefined} iso @param {boolean} [future] */
function relAgo(iso, future) {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const d = Math.abs(Date.now() - t);
  const m = Math.floor(d / 60000);
  const s = m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
  return future ? `in ~${m < 60 ? `${Math.max(1, m)} min` : `${Math.floor(m / 60)} h`}` : s;
}
