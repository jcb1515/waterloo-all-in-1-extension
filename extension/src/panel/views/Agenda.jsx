// Agenda view: summary card, filter chips + org picker, grouped item list,
// and the empty / first-run / loading states.

import { useMemo, useState } from "preact/hooks";
import { buildAgenda } from "../model/agenda.js";
import { priorityOf } from "../../core/priority.js";
import { ADAPTERS, stageForAdapter } from "../../core/registry.js";
import { ItemRow } from "../components/ItemRow.jsx";
import { GroupHeader } from "../components/GroupHeader.jsx";
import { normCourseCode } from "../../core/contract.js";
import { orgStyle } from "../../ui/colors.js";
import { SearchIcon, ExternalLinkIcon, AlertTriangleIcon } from "../../ui/icons.jsx";

const FILTERS = [
  ["all", "All"],
  ["deadlines", "Deadlines"],
  ["classes", "Classes"],
  ["exams", "Exams"],
  ["meetings", "Meetings"],
  ["coop", "Co-op"],
];

/**
 * @param {{state: any, actions: any, now: Date, onGoSources: () => void}} props
 */
export function Agenda({ state, actions, now, onGoSources }) {
  const [filter, setFilter] = useState(query0("filter") || "all");
  const [org, setOrg] = useState(null);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState(() => ({}));

  const orgs = useMemo(() => {
    const seen = new Map();
    for (const it of Object.values(state.items)) {
      const itAny = /** @type {any} */ (it);
      if (itAny && itAny.org) seen.set(normCourseCode(itAny.org), itAny.org);
    }
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [state.items]);

  const agenda = useMemo(
    () =>
      buildAgenda({
        items: state.items,
        userState: state.userState,
        settings: state.settings,
        now,
        filter,
        org,
        q,
      }),
    [state.items, state.userState, state.settings, filter, org, q]
  );

  if (!state.ready) {
    return (
      <div class="agenda" aria-busy="true">
        <div class="card summary-card">
          <div class="skeleton" style={{ height: "26px", width: "60%" }} />
          <div class="skeleton" style={{ height: "14px", width: "80%", marginTop: "8px" }} />
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div class="skeleton skel-row" key={i} />
        ))}
      </div>
    );
  }

  const hasItems = Object.keys(state.items).length > 0;
  const learnSynced = !!(state.sourceState.learn && state.sourceState.learn.lastOkAt);
  const s = agenda.summary;

  // Error / stale strip: the first *actively synced* source that needs
  // attention. Passive sources (WaterlooWorks) stay silent — they read only
  // while you browse, so a stale/signed-out state is normal, not a nag.
  const troubled = ADAPTERS.find((a) => {
    if (stageForAdapter(a.id) !== "live" || !(a.intervalMinutes > 0)) return false;
    const st = (state.sourceState || {})[a.id];
    return st && (st.error || st.session === "signed-out");
  });

  // Calendar feed trouble gets its own strip — it isn't a "source", so the
  // adapter loop above can't see it.
  const calErr =
    state.settings &&
    state.settings.calendar &&
    state.settings.calendar.enabled &&
    state.calendarFeed &&
    state.calendarFeed.status === "error"
      ? state.calendarFeed.error || "Calendar publish failed"
      : null;

  return (
    <div class="agenda">
      {calErr ? (
        <button type="button" class="attention-strip" onClick={openCalendarSettings}>
          <AlertTriangleIcon size={14} /> Calendar: {calErr}
        </button>
      ) : null}
      {troubled ? (
        <button type="button" class="attention-strip" onClick={onGoSources}>
          <AlertTriangleIcon size={14} />
          {troubled.label}:{" "}
          {troubled.session === "signed-out" || (troubled.error && troubled.error.code) === "signed-out"
            ? "signed out — open the site"
            : (troubled.error && troubled.error.message) || "sync error"}
        </button>
      ) : null}

      <section class="card summary-card" aria-label="Today">
        <h2 class="summary-date">{s.dateLabel}</h2>
        <p class="summary-counts tabular">
          {s.dueToday} due today · {s.dueWeek} this week
          {s.overdue ? <span class="summary-overdue"> · {s.overdue} overdue</span> : null}
        </p>
        {s.clashCount || s.busyDay ? (
          <p class="summary-extra">
            {s.clashCount ? (
              <button
                type="button"
                class="linklike summary-clash"
                onClick={() => setFilter("clash")}
              >
                {s.clashCount} clash{s.clashCount === 1 ? "" : "es"} this week
              </button>
            ) : null}
            {s.clashCount && s.busyDay ? " · " : null}
            {s.busyDay ? <span>Busy {s.busyDay.label.split(", ")[0]}: {s.busyDay.count} due</span> : null}
          </p>
        ) : null}
        {agenda.nextUp && agenda.nextUp.length ? (
          <p class="summary-nextup">
            Next up: {agenda.nextUp.map((u) => u.title).join(" · ")}
          </p>
        ) : null}
        {agenda.nextClass ? (
          <div
            class="next-class"
            style={orgStyle(agenda.nextClass.org)}
            role="status"
          >
            <span class="chip chip-org">{agenda.nextClass.org}</span>
            <span class="next-class-time tabular">{agenda.nextClass.rangeLabel}</span>
            {agenda.nextClass.location ? (
              <span class="next-class-loc">{agenda.nextClass.location}</span>
            ) : null}
            <span class="next-class-label">next class</span>
          </div>
        ) : null}
      </section>

      <div class="filter-bar" role="toolbar" aria-label="Filters">
        <div class="filter-row">
          <div class="search-wrap">
            <SearchIcon size={14} />
            <input
              id="agenda-search"
              class="input search-input"
              type="search"
              placeholder="Search titles, courses, rooms…"
              aria-label="Search agenda"
              value={q}
              onInput={(e) => setQ(/** @type {any} */ (e.target).value)}
            />
          </div>
          {orgs.length > 1 ? (
            <select
              class="select org-select"
              aria-label="Filter by course or team"
              value={org || ""}
              onChange={(e) => setOrg(/** @type {any} */ (e.target).value || null)}
            >
              <option value="">All courses &amp; teams</option>
              {orgs.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <div class="chip-scroll" role="group" aria-label="Type filter">
          {s.clashCount || filter === "clash" ? (
            <button
              type="button"
              class={`chip filter-chip${filter === "clash" ? " active" : ""}`}
              aria-pressed={filter === "clash"}
              onClick={() => setFilter(filter === "clash" ? "all" : "clash")}
            >
              Clashes
            </button>
          ) : null}
          {FILTERS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              class={`chip filter-chip${filter === id ? " active" : ""}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {!hasItems && !learnSynced ? <FirstRun actions={actions} onGoSources={onGoSources} /> : null}
      {hasItems && agenda.groups.length === 0 ? (
        <EmptyState filter={filter} />
      ) : null}

      {agenda.groups.map((g) => (
        <section class="agenda-group" key={g.id} aria-label={g.label}>
          <GroupHeader
            label={g.label}
            count={g.count}
            tone={g.tone}
            collapsed={collapsed[g.id] ?? g.collapsedByDefault}
            onToggle={() => setCollapsed((c) => ({ ...c, [g.id]: !(c[g.id] ?? g.collapsedByDefault) }))}
          />
          {(collapsed[g.id] ?? g.collapsedByDefault) ? null : (
            <div class="card row-card" role="list">
              {g.rows.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  now={now}
                  actions={actions}
                  done={g.done}
                  clashes={agenda.clashById.get(item.id)}
                  items={state.items}
                  priority={rowPriority(item, now)}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** Row priority — rows already carry effective fields. */
function rowPriority(item, now) {
  return priorityOf(item, now);
}

/** Open the options page's calendar section. */
function openCalendarSettings() {
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/options/options.html#calendar") });
  } catch {
    /* preview / no extension context */
  }
}

function query0(name) {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

/** @param {{actions: any, onGoSources: () => void}} p */
function FirstRun({ actions, onGoSources }) {
  return (
    <div class="card empty-card">
      <h3>Nothing here yet</h3>
      <p class="help">Open Learn in a tab to get started — the extension reads what's already on your screen.</p>
      <div class="empty-actions">
        <button
          type="button"
          class="btn btn-primary"
          onClick={() => actions.open("https://learn.uwaterloo.ca/")}
        >
          <ExternalLinkIcon size={14} /> Open Learn
        </button>
        <button type="button" class="btn" onClick={onGoSources}>
          Sources
        </button>
      </div>
    </div>
  );
}

/** @param {{filter: string}} p */
function EmptyState({ filter }) {
  return (
    <div class="card empty-card">
      <SearchIcon size={20} />
      <h3>Nothing due{filter !== "all" ? " in this filter" : ""} — enjoy the break</h3>
      <p class="help">Anything new your sources report lands here automatically.</p>
    </div>
  );
}
