// Calendar view: a Week | Month toggle over effective items. Week is a
// Toronto-time grid with a due strip and workload-heat tint; Month is a 6x7
// grid with compact markers. Tapping an item opens a detail popover.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { weekModel, monthModel, weekStartOf, dayKeyOf, shortLabel } from "../model/calendar.js";
import { fmtDay, fmtTime, fmtRange } from "../model/agenda.js";
import { orgStyle } from "../../ui/colors.js";
import { ChevronRightIcon, AlertTriangleIcon, ExternalLinkIcon, MoreIcon, RefreshIcon } from "../../ui/icons.jsx";
import { ItemRow } from "../components/ItemRow.jsx";
import {
  maskUrl,
  googleAddUrl,
  copyText,
  relAgo,
  feedStatusLine,
  IncludeToggles,
  SplitCalendars,
} from "../../ui/calendarFeed.jsx";
import { send, IS_PREVIEW } from "../data.js";
import { UI } from "../../core/messages.js";
import { mutateKey } from "../../core/store.js";
import { validServiceUrl, FEED_KEY } from "../../calendar/publish.js";

const PX_PER_MIN = 0.8;
const WD_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December",
];

const HEAT_LABELS = ["0", "1–9", "10–24", "25+"];

function query0(name) {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

/** Open the options page's calendar section (Settings → Calendar). */
function openCalendarOptions() {
  const url = IS_PREVIEW
    ? "/src/options/options.html#calendar"
    : chrome.runtime.getURL("src/options/options.html#calendar");
  try {
    if (!IS_PREVIEW && chrome.tabs) {
      chrome.tabs.create({ url });
      return;
    }
  } catch {
    /* fall through */
  }
  window.open(url, "_blank");
}

/**
 * The calendar-sync strip atop the Calendar tab. Off: a compact card with a
 * Turn on button. On: a status line + Sync now / Add / Copy, the resubscribe
 * banner, and a "What's included" disclosure with the include toggles and
 * split-by-type feeds. Collapses to one line once the user has subscribed;
 * `?calsync=open` forces the expanded layout for previews.
 * @param {{state: any, actions: any}} p
 */
function SyncStrip({ state, actions }) {
  const cal = (state.settings && state.settings.calendar) || {};
  const feed = state.calendarFeed;
  const origin = validServiceUrl(cal.serviceUrl);
  const subscribed = !!(cal.subscribed || (feed && feed.lastPublishedAt));
  const [expanded, setExpanded] = useState(() => query0("calsync") === "open" || !subscribed);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!subscribed) setExpanded(true);
  }, [subscribed]);

  const patchCal = (p) => actions.saveSettings({ calendar: p });
  const publishNow = () => send({ type: UI.CALENDAR_PUBLISH });
  const markSubscribed = () => patchCal({ subscribed: true });
  const dismissResubscribe = () => {
    if (IS_PREVIEW) return;
    mutateKey(FEED_KEY, (cur) => (cur ? { ...cur, needsResubscribe: false } : cur)).catch(() => {});
  };

  if (!cal.enabled) {
    return (
      <section class="card cal-sync">
        <div class="cal-sync-head">
          <h3>Sync to Google Calendar</h3>
        </div>
        <p class="help">
          Sends event titles, times and places to the calendar server; your link is private.
        </p>
        <div class="inline-row">
          <button
            type="button"
            class="btn btn-sm btn-primary"
            disabled={!origin}
            onClick={() => patchCal({ enabled: true })}
          >
            Turn on
          </button>
          {!origin ? (
            <button type="button" class="linklike" onClick={openCalendarOptions}>
              No calendar server set — Settings → Calendar
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  if (!expanded) {
    return (
      <section class="card cal-sync cal-sync-collapsed">
        <div class="cal-sync-line">
          <span class="help cal-sync-status">
            {feed && feed.status === "ok" && feed.lastPublishedAt
              ? `Synced ${relAgo(feed.lastPublishedAt)}`
              : feed && feed.status === "publishing"
                ? "Publishing…"
                : feed && feed.status === "error"
                  ? `Sync failed — ${feed.error || "publish error"}`
                  : "Calendar sync on"}
          </span>
          <button type="button" class="btn btn-sm" onClick={publishNow}>
            Sync now
          </button>
          <button
            type="button"
            class="btn-icon"
            aria-label="Calendar sync options"
            onClick={() => setExpanded(true)}
          >
            <MoreIcon size={15} />
          </button>
        </div>
      </section>
    );
  }

  const statusLine = feedStatusLine(feed);
  return (
    <section class="card cal-sync">
      <div class="cal-sync-head">
        <h3>Sync to Google Calendar</h3>
        {subscribed ? (
          <button
            type="button"
            class="linklike"
            onClick={() => setExpanded(false)}
          >
            Collapse
          </button>
        ) : null}
      </div>

      {feed && feed.needsResubscribe ? (
        <div class="banner banner-warn" role="alert">
          <AlertTriangleIcon size={14} />
          <span>Your calendar link changed — remove the old calendar in Google and add this one.</span>
          <button type="button" class="btn btn-sm" onClick={dismissResubscribe}>
            Dismiss
          </button>
        </div>
      ) : null}

      {statusLine ? (
        <p class="help status-ok">{statusLine}</p>
      ) : feed && feed.status === "error" ? (
        <p class="help status-err">
          {feed.error || "Publish failed"}
          {feed.retryAt ? ` · retrying ${relAgo(feed.retryAt, true)}` : ""}
        </p>
      ) : feed && feed.status === "publishing" ? (
        <p class="help">Publishing…</p>
      ) : (
        <p class="help">Not published yet — it publishes a minute after the next change.</p>
      )}

      {feed && feed.feedUrl ? (
        <code class="feed-url">{maskUrl(feed.feedUrl)}</code>
      ) : null}

      <div class="inline-row">
        <button type="button" class="btn btn-sm" onClick={publishNow}>
          <RefreshIcon size={13} /> Sync now
        </button>
        {feed && feed.feedUrl ? (
          <>
            <a
              class="btn btn-sm btn-primary"
              href={googleAddUrl(feed.feedUrl)}
              target="_blank"
              rel="noreferrer"
              onClick={markSubscribed}
            >
              <ExternalLinkIcon size={12} /> Add to Google Calendar
            </a>
            <button
              type="button"
              class="btn btn-sm"
              onClick={async () => {
                if (await copyText(feed.feedUrl)) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                }
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </>
        ) : null}
      </div>

      <details class="help-details">
        <summary>What's included</summary>
        <IncludeToggles cal={cal} patch={patchCal} />
        <SplitCalendars cal={cal} feed={feed} patch={patchCal} reveal={false} />
      </details>

      <p class="help">
        <button type="button" class="linklike" onClick={openCalendarOptions}>
          More calendar settings
        </button>
      </p>
    </section>
  );
}

/** One hour-tick label, e.g. "8", "12 PM". */
const hourLabel = (h) => (h === 12 ? "12 PM" : h < 12 ? `${h}` : `${h - 12} PM`);

/** The Week grid. */
function WeekView({ state, actions, now, cursor, showClasses, onPick }) {
  const model = useMemo(
    () =>
      weekModel(state.items, state.userState, state.settings, cursor, now, {
        showClasses,
        projects: state.projects,
      }),
    [state.items, state.userState, state.settings, state.projects, cursor, now, showClasses]
  );
  const { startHour, endHour, minutes } = model.range;
  const gridH = minutes * PX_PER_MIN;
  const hourTicks = [];
  for (let h = startHour; h < endHour; h++) hourTicks.push(h);

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowInRange = nowMin >= startHour * 60 && nowMin <= endHour * 60;

  // Real column width drives the label switch: under ~60px a block/pill
  // shows the compact subject/catalog split instead of the full org.
  const gridRef = useRef(null);
  const [gridW, setGridW] = useState(0);
  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setGridW(el.clientWidth));
    ro.observe(el);
    setGridW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const colPx = gridW ? gridW / 7 : 80;
  const pillNarrow = colPx < 60;

  return (
    <div class="cal-week">
      {/* Due strip + day headers, both heat-tinted. */}
      <div class="cal-days-head">
        <span class="cal-gutter" />
        {model.days.map((d, i) => (
          <div key={d.date} class={`cal-day-head${d.today ? " today" : ""}`} data-heat={d.heat}>
            <span class="cal-dow">{WD_SHORT[i]}</span>
            <span class="cal-date tabular">{d.date.slice(8)}</span>
            <div class="cal-due">
              {d.due.slice(0, 3).map((it) => {
                const sl = pillNarrow ? shortLabel(it) : null;
                return (
                  <button
                    key={it.id}
                    type="button"
                    class="cal-due-pill"
                    style={orgStyle(it.org, state.projects)}
                    title={`${it.title}${typeof it.weight === "number" ? ` · ${it.weight}%` : ""}`}
                    onClick={() => onPick(it)}
                  >
                    {sl ? (
                      <>
                        {sl.sub ? <span class="cal-pill-sub">{sl.sub}</span> : null}
                        <strong>{sl.main}</strong>
                      </>
                    ) : (
                      <>
                        {it.org ? `${it.org} ` : ""}
                        {it.title.length > 18 ? `${it.title.slice(0, 17)}…` : it.title}
                      </>
                    )}
                  </button>
                );
              })}
              {d.due.length > 3 ? <span class="cal-due-more">+{d.due.length - 3}</span> : null}
            </div>
          </div>
        ))}
      </div>

      <div class="cal-grid-wrap">
        <div class="cal-gutter cal-hours" style={{ height: gridH }}>
          {hourTicks.map((h) => (
            <span key={h} class="cal-hour" style={{ top: (h - startHour) * 60 * PX_PER_MIN }}>
              {hourLabel(h)}
            </span>
          ))}
        </div>
        <div class="cal-grid" ref={gridRef} style={{ height: gridH }}>
          {hourTicks.map((h) => (
            <div
              key={h}
              class="cal-hourline"
              style={{ top: (h - startHour) * 60 * PX_PER_MIN }}
            />
          ))}
          {model.days.map((d) => (
            <div key={d.date} class={`cal-col${d.today ? " today" : ""}`}>
              {d.today && nowInRange ? (
                <span class="cal-now" style={{ top: (nowMin - startHour * 60) * PX_PER_MIN }} />
              ) : null}
              {d.timed.map((ev) => {
                const narrow = colPx / ev.cols < 60;
                const sl = narrow ? shortLabel(ev.item) : null;
                return (
                  <button
                    key={ev.item.id}
                    type="button"
                    class={[
                      "cal-block",
                      narrow ? "narrow" : "",
                      ev.item.confidence === "tentative" ? "tentative" : "",
                      ev.clash ? (ev.severe ? "clash severe" : "clash") : "",
                      ev.item.type === "exam" || ev.item.type === "interview" ? "major" : "",
                      ev.item.status === "done" || ev.item.status === "submitted" ? "dim" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{
                      ...orgStyle(ev.item.org, state.projects),
                      top: ev.top * PX_PER_MIN,
                      height: ev.height * PX_PER_MIN,
                      left: `${(ev.col / ev.cols) * 100}%`,
                      width: `${100 / ev.cols}%`,
                    }}
                    title={ev.item.title}
                    onClick={() => onPick(ev.item)}
                  >
                    {sl ? (
                      <span class="cal-block-title">
                        {sl.sub ? <span class="cal-block-sub">{sl.sub}</span> : null}
                        <span class="cal-block-num">{sl.main}</span>
                      </span>
                    ) : (
                      <span class="cal-block-title">{ev.item.org || ev.item.title}</span>
                    )}
                    {!narrow && ev.e - ev.s >= 45 * 60000 ? (
                      <span class="cal-block-time">
                        {fmtTime(ev.s)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The Month grid + selected-day rows. */
function MonthView({ state, actions, now, cursor, selDay, onSelectDay }) {
  const model = useMemo(
    () => monthModel(state.items, state.userState, state.settings, cursor, now, state.projects),
    [state.items, state.userState, state.settings, state.projects, cursor, now]
  );
  const [showClassCounts, setShowClassCounts] = useState(false);
  const sel = selDay ? model.cells.find((c) => c.date === selDay) : null;

  return (
    <div class="cal-month-wrap">
      <div class="cal-month-head">
        {WD_SHORT.map((d) => (
          <span key={d} class="cal-dow">
            {d}
          </span>
        ))}
      </div>
      <div class="cal-month">
        {model.cells.map((c) => (
          <button
            key={c.date}
            type="button"
            class={`cal-cell${c.inMonth ? "" : " off"}${c.today ? " today" : ""}${selDay === c.date ? " sel" : ""}`}
            data-heat={c.heat}
            onClick={() => onSelectDay(c.date)}
          >
            <span class="cal-cell-num tabular">{c.day}</span>
            <span class="cal-cell-marks">
              {c.markers.map((m) => (
                <span
                  key={m.id}
                  class={`cal-mark${m.type === "exam" || m.type === "interview" ? " major" : ""}`}
                  title={m.title}
                >
                  <i style={orgStyle(m.org, state.projects)} />
                  {m.title}
                </span>
              ))}
              {c.more ? <span class="cal-mark-more">+{c.more}</span> : null}
              {showClassCounts && c.classCount ? (
                <span class="cal-mark classes">{c.classCount} classes</span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
      <label class="switch cal-toggle">
        <input
          type="checkbox"
          checked={showClassCounts}
          onChange={(e) => setShowClassCounts(/** @type {any} */ (e.target).checked)}
        />
        <span class="track" aria-hidden="true" />
        <span>Show class counts</span>
      </label>
      {sel ? (
        <div class="cal-day-items">
          {/* Anchor at noon so the bare date can't shift back a day in TZ. */}
          <h3 class="cal-day-title">{fmtDay(`${sel.date}T12:00`)}</h3>
          <div class="card row-card" role="list">
            {sel.items.length ? (
              sel.items.map((it) => (
                <ItemRow key={it.id} item={it} now={now} actions={actions} projects={state.projects} />
              ))
            ) : (
              <p class="help cal-empty-day">Nothing on this day.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * @param {{state: any, actions: any, now: Date}} props
 */
export function CalendarView({ state, actions, now }) {
  const [mode, setMode] = useState(() => (query0("view") === "month" ? "month" : "week"));
  const [cursor, setCursor] = useState(() => now.getTime());
  const [selDay, setSelDay] = useState(() => query0("day") || dayKeyOf(now.getTime()));
  const [showClasses, setShowClasses] = useState(() => query0("classes") !== "0");

  const weekStart = useMemo(() => weekStartOf(cursor), [cursor]);
  const weekLabel = useMemo(() => {
    const end = weekStart + 6 * 86400000;
    return `${fmtDay(weekStart)} – ${fmtDay(end)}`;
  }, [weekStart]);

  const monthLabel = useMemo(() => {
    const d = new Date(cursor);
    return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
  }, [cursor]);

  const step = (dir) => {
    if (mode === "week") {
      setCursor((c) => weekStartOf(c) + dir * 7 * 86400000);
    } else {
      setCursor((c) => {
        const d = new Date(c);
        return new Date(d.getFullYear(), d.getMonth() + dir, 1).getTime();
      });
    }
  };

  return (
    <div class="cal">
      <SyncStrip state={state} actions={actions} />

      <div class="cal-toolbar">
        <div class="segmented" role="tablist" aria-label="Calendar range">
          {["week", "month"].map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
            >
              {m === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
        <div class="cal-nav">
          <button type="button" class="btn-icon" aria-label="Previous" onClick={() => step(-1)}>
            <span class="chev" style={{ transform: "rotate(180deg)", display: "inline-flex" }}>
              <ChevronRightIcon size={15} />
            </span>
          </button>
          <button type="button" class="btn btn-sm" onClick={() => setCursor(now.getTime())}>
            Today
          </button>
          <button type="button" class="btn-icon" aria-label="Next" onClick={() => step(1)}>
            <ChevronRightIcon size={15} />
          </button>
        </div>
        <span class="cal-range">{mode === "week" ? weekLabel : monthLabel}</span>
      </div>

      {mode === "week" ? (
        <label class="switch cal-toggle">
          <input
            type="checkbox"
            checked={showClasses}
            onChange={(e) => setShowClasses(/** @type {any} */ (e.target).checked)}
          />
          <span class="track" aria-hidden="true" />
          <span>Show classes</span>
        </label>
      ) : null}

      {mode === "week" ? (
        <WeekView
          state={state}
          actions={actions}
          now={now}
          cursor={weekStart}
          showClasses={showClasses}
          onPick={(it) => actions.openItem && actions.openItem(it)}
        />
      ) : (
        <MonthView
          state={state}
          actions={actions}
          now={now}
          cursor={cursor}
          selDay={selDay}
          onSelectDay={setSelDay}
        />
      )}

      <div class="cal-legend" aria-label="Workload heat legend">
        <span>Workload</span>
        {HEAT_LABELS.map((l, i) => (
          <span key={l} class="cal-legend-chip">
            <i data-heat={i} />
            {l}
          </span>
        ))}
      </div>

    </div>
  );
}
