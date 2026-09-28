// Calendar view: a Week | Month toggle over effective items. Week is a
// Toronto-time grid with a due strip and workload-heat tint; Month is a 6x7
// grid with compact markers. Tapping an item opens a detail popover.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { weekModel, monthModel, weekStartOf, dayKeyOf, shortLabel } from "../model/calendar.js";
import { fmtDay, fmtTime, fmtRange } from "../model/agenda.js";
import { orgStyle } from "../../ui/colors.js";
import { ChevronRightIcon } from "../../ui/icons.jsx";
import { ItemRow } from "../components/ItemRow.jsx";

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

/** One hour-tick label, e.g. "8", "12 PM". */
const hourLabel = (h) => (h === 12 ? "12 PM" : h < 12 ? `${h}` : `${h - 12} PM`);

/** The Week grid. */
function WeekView({ state, actions, now, cursor, showClasses, onPick }) {
  const model = useMemo(
    () => weekModel(state.items, state.userState, state.settings, cursor, now, { showClasses }),
    [state.items, state.userState, state.settings, cursor, now, showClasses]
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
    () => monthModel(state.items, state.userState, state.settings, cursor, now),
    [state.items, state.userState, state.settings, cursor, now]
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
