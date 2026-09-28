// Upcoming view: summary card, type chips + course/source filters, and the
// grouped item list with sticky full-date day headers. Every row carries a
// SourceBadge and a DateBlock — rows under a day header may show just a time.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { buildAgenda, foundNotAdded } from "../model/agenda.js";
import { fmtEstimate } from "../model/itemsheet.js";
import { attentionSource } from "../model/sources.js";
import { onboardingRows, nudges as visitNudges } from "../model/onboarding.js";
import { priorityOf } from "../../core/priority.js";
import { ADAPTERS, stageForAdapter } from "../../core/registry.js";
import { ItemRow } from "../../ui/ItemRow.jsx";
import { OnboardingCard, NudgeCard } from "../../ui/Onboarding.jsx";
import { IS_PREVIEW } from "../data.js";
import { GroupHeader } from "../components/GroupHeader.jsx";
import { normCourseCode } from "../../core/contract.js";
import { orgStyle } from "../../ui/colors.js";
import { itemSourceIds, sourceLabel } from "../../ui/sourceLabel.js";
import { fmtCompactDay } from "../../ui/dateLabel.js";
import {
  SearchIcon,
  ExternalLinkIcon,
  AlertTriangleIcon,
  FilterIcon,
  XIcon,
} from "../../ui/icons.jsx";

const FILTERS = [
  ["all", "All"],
  ["exams", "Exams"],
  ["deadlines", "Deadlines"],
  ["classes", "Classes"],
  ["meetings", "Meetings"],
  ["coop", "Co-op"],
  ["clash", "Clashes"],
];

// Group ids that are day headers — rows under them may show a bare time.
const DAY_GROUP = /^(today|tomorrow|classes-today|day:)/;

/**
 * @param {{state: any, actions: any, now: Date, onGoSources: () => void,
 *   onGoCalendar?: () => void}} props
 */
export function Upcoming({ state, actions, now, onGoSources, onGoCalendar }) {
  const [filter, setFilter] = useState(query0("filter") || "all");
  const [org, setOrg] = useState(null);
  const [source, setSource] = useState(() => query0("src") || null);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState(() => ({}));
  const [foundAll, setFoundAll] = useState(false);
  const [filterOpen, setFilterOpen] = useState(() => query0("fsheet") === "1");

  const orgs = useMemo(() => {
    const seen = new Map();
    for (const it of Object.values(state.items)) {
      const itAny = /** @type {any} */ (it);
      if (itAny && itAny.org) seen.set(normCourseCode(itAny.org), itAny.org);
    }
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [state.items]);

  // Sources that actually produced items, in badge order.
  const sources = useMemo(() => {
    const seen = new Set();
    for (const it of Object.values(state.items)) {
      for (const s of itemSourceIds(it)) seen.add(s);
    }
    return [...seen].filter((id) => id !== "manual");
  }, [state.items]);

  // Fade edge on the chip row only while it actually overflows.
  const chipRef = useRef(null);
  const [chipsOverflow, setChipsOverflow] = useState(false);
  useEffect(() => {
    const el = chipRef.current;
    if (!el) return;
    const check = () => setChipsOverflow(el.scrollWidth - el.scrollLeft > el.clientWidth + 2);
    check();
    el.addEventListener("scroll", check);
    window.addEventListener("resize", check);
    return () => {
      el.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [state.ready]);

  const agenda = useMemo(
    () =>
      buildAgenda({
        items: state.items,
        userState: state.userState,
        settings: state.settings,
        now,
        filter,
        org,
        source,
        q,
        projects: state.projects,
      }),
    [state.items, state.userState, state.settings, state.projects, filter, org, source, q]
  );

  // Pending finds with no verdict or to-do pin — the "Found, not added yet"
  // section ([] while review.showPending lists them in the normal groups).
  const found = useMemo(
    () =>
      foundNotAdded({
        items: state.items,
        userState: state.userState,
        settings: state.settings,
        now,
        projects: state.projects,
      }),
    [state.items, state.userState, state.settings, state.projects]
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
  const troubled = attentionSource(ADAPTERS, state.sourceState, stageForAdapter);

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

  // "Get set up" card + "Needs a visit" nudges (panel/model/onboarding.js).
  const onboarding = onboardingRows(state, now);
  const onboardingDone = onboarding.length > 0 && onboarding.every((r) => r.done);
  const onboardingHidden =
    !onboarding.length ||
    onboardingDone ||
    !!(state.userState && state.userState.onboardingDismissedAt);
  const visits = visitNudges(state, now);
  const openUrl = (url) => {
    if (IS_PREVIEW) {
      window.open(url, "_blank");
      return;
    }
    try {
      chrome.tabs.create({ url });
    } catch {
      window.open(url, "_blank");
    }
  };
  // Checklist Open: stamp the row opened AND open the page in one click.
  const onOpenRow = (entry) => {
    actions.markOnboardingOpened(`${entry.source}:${entry.row.id}`);
    if (entry.row.url) actions.open(entry.row.url);
  };

  return (
    <div class="agenda">
      {onboardingHidden ? null : (
        <OnboardingCard rows={onboarding} onOpen={onOpenRow} onDismiss={actions.dismissOnboarding} />
      )}
      {calErr ? (
        <button type="button" class="attention-strip" onClick={onGoCalendar}>
          <AlertTriangleIcon size={14} /> Calendar: {calErr}
        </button>
      ) : null}
      {troubled ? (
        <button type="button" class="attention-strip" onClick={onGoSources}>
          <AlertTriangleIcon size={14} />
          {troubled.adapter.label}: {troubled.text}
        </button>
      ) : null}
      <NudgeCard nudges={visits} limit={2} onOpen={openUrl} onSnooze={actions.snoozeNudge} />

      {found.length ? (
        <section class="agenda-group" aria-label="Found, not added yet">
          <GroupHeader
            label="Found, not added yet"
            count={found.length}
            collapsed={collapsed.found ?? false}
            onToggle={() =>
              setCollapsed((c) => ({ ...c, found: !(c.found ?? false) }))
            }
          />
          {(collapsed.found ?? false) ? null : (
            <div class="card row-card" role="list">
              {(foundAll ? found : found.slice(0, 5)).map((item) => (
                <FoundRow
                  key={item.id}
                  item={item}
                  state={state}
                  actions={actions}
                  now={now}
                />
              ))}
              {found.length > 5 && !foundAll ? (
                <button
                  type="button"
                  class="linklike"
                  onClick={() => setFoundAll(true)}
                >
                  Show all {found.length}
                </button>
              ) : null}
            </div>
          )}
        </section>
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
        {(() => {
          const nu = (agenda.nextUp || []).find((u) => u.key) || null;
          return nu ? (
            <p class="summary-nextup" title={`${nu.org ? `${nu.org} — ` : ""}${nu.title}`}>
              Next up: {fmtCompactDay(nu.anchor)} · {nu.title}
            </p>
          ) : null;
        })()}
        {agenda.nextClass ? (
          <div
            class="next-class"
            style={orgStyle(agenda.nextClass.org, state.projects)}
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
        <div class="search-row">
          <div class="search-wrap">
            <SearchIcon size={14} />
            <input
              id="upcoming-search"
              class="input search-input"
              type="search"
              placeholder="Search titles, courses, rooms…"
              aria-label="Search upcoming items"
              value={q}
              onInput={(e) => setQ(/** @type {any} */ (e.target).value)}
            />
          </div>
          <button
            type="button"
            class="btn qa-add"
            onClick={() => actions.openQuickAdd && actions.openQuickAdd({})}
          >
            + Add
          </button>
        </div>
        <div class="chip-row">
          <div
            ref={chipRef}
            class={`chip-scroll${chipsOverflow ? " has-overflow" : ""}`}
            role="group"
            aria-label="Type filter"
          >
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
          <div class="filter-wrap">
            <button
              type="button"
              class={`btn btn-sm filter-btn${filterOpen ? " open" : ""}`}
              aria-expanded={filterOpen}
              aria-haspopup="dialog"
              onClick={() => setFilterOpen((o) => !o)}
            >
              <FilterIcon size={13} /> Filter
              {org || source ? (
                <span class="count-badge" aria-label={`${(org ? 1 : 0) + (source ? 1 : 0)} filters active`}>
                  {(org ? 1 : 0) + (source ? 1 : 0)}
                </span>
              ) : null}
            </button>
            {filterOpen ? (
              <>
                <button
                  type="button"
                  class="filter-backdrop"
                  aria-label="Close filters"
                  onClick={() => setFilterOpen(false)}
                />
                <div class="filter-sheet" role="dialog" aria-label="Filter by course and source">
                  {orgs.length ? (
                    <div class="filter-sheet-group">
                      <span class="filter-sheet-label">Course / team</span>
                      <FilterOption
                        label="All courses & teams"
                        active={!org}
                        onPick={() => { setOrg(null); setFilterOpen(false); }}
                      />
                      {orgs.map(([key, label]) => (
                        <FilterOption
                          key={key}
                          label={label}
                          active={org === key}
                          onPick={() => { setOrg(key); setFilterOpen(false); }}
                        />
                      ))}
                    </div>
                  ) : null}
                  {sources.length ? (
                    <div class="filter-sheet-group">
                      <span class="filter-sheet-label">Source</span>
                      <FilterOption
                        label="All sources"
                        active={!source}
                        onPick={() => { setSource(null); setFilterOpen(false); }}
                      />
                      {sources.map((id) => (
                        <FilterOption
                          key={id}
                          label={sourceLabel(id, null)}
                          active={source === id}
                          onPick={() => { setSource(id); setFilterOpen(false); }}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </div>
        {org || source ? (
          <div class="filter-pills">
            {org ? (
              <button
                type="button"
                class="filter-pill"
                title="Remove course filter"
                onClick={() => setOrg(null)}
              >
                {(orgs.find(([k]) => k === org) || [null, org])[1]} <XIcon size={11} />
              </button>
            ) : null}
            {source ? (
              <button
                type="button"
                class="filter-pill"
                title="Remove source filter"
                onClick={() => setSource(null)}
              >
                {sourceLabel(source, null)} <XIcon size={11} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {!hasItems && !learnSynced ? <FirstRun actions={actions} onGoSources={onGoSources} /> : null}
      {hasItems && agenda.groups.length === 0 ? (
        <EmptyRows filter={filter} />
      ) : null}

      {agenda.groups.map((g) => (
        <section class="agenda-group" key={g.id} aria-label={g.label}>
          <GroupHeader
            label={g.label}
            count={g.count}
            tone={g.tone}
            collapsed={collapsed[g.id] ?? g.collapsedByDefault}
            onToggle={() => setCollapsed((c) => ({ ...c, [g.id]: !(c[g.id] ?? g.collapsedByDefault) }))}
            extra={
              g.estMin ? (
                <span class="est-sum tabular" title="Summed estimates">
                  ~{fmtEstimate(g.estMin)}
                </span>
              ) : null
            }
          />
          {(collapsed[g.id] ?? g.collapsedByDefault) ? null : (
            <div class="card row-card" role="list">
              {g.rows.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  now={now}
                  inDayGroup={DAY_GROUP.test(g.id)}
                  actions={actions}
                  done={g.done}
                  clashes={agenda.clashById.get(item.id)}
                  items={state.items}
                  priority={rowPriority(item, now)}
                  projects={state.projects}
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

/**
 * One "Found, not added yet" row: the ItemRow opens the item sheet; the
 * pill + verdict buttons sit under it. Every button stops propagation so
 * the click can't reach the row's open handler.
 * @param {{item: any, state: any, actions: any, now: Date}} p
 */
function FoundRow({ item, state, actions, now }) {
  const dismiss = (e) => {
    e.stopPropagation();
    actions.setUserState(item.id, { review: "dismissed" });
    actions.toast(`${item.title} dismissed`, {
      label: "Undo",
      run: () => actions.setUserState(item.id, { review: null }),
    });
  };
  return (
    <div>
      <ItemRow
        item={item}
        now={now}
        actions={actions}
        projects={state.projects}
      />
      <p class="help">
        <span class="badge badge-warn">Not added</span>{" "}
        <button
          type="button"
          class="btn btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            actions.setUserState(item.id, { review: "accepted" });
          }}
        >
          Add to calendar
        </button>{" "}
        <button
          type="button"
          class="btn btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            actions.setUserState(item.id, { todo: true });
          }}
        >
          Add to To-do
        </button>{" "}
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          onClick={dismiss}
        >
          Dismiss
        </button>
      </p>
    </div>
  );
}

function query0(name) {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

/** @param {{label: string, active: boolean, onPick: () => void}} p */
function FilterOption({ label, active, onPick }) {
  return (
    <button
      type="button"
      class={`filter-opt${active ? " active" : ""}`}
      aria-pressed={active}
      onClick={onPick}
    >
      {label}
    </button>
  );
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
function EmptyRows({ filter }) {
  return (
    <div class="card empty-card">
      <SearchIcon size={20} />
      <h3>Nothing due{filter !== "all" ? " in this filter" : ""} — enjoy the break</h3>
      <p class="help">Anything new your sources report lands here automatically.</p>
    </div>
  );
}
