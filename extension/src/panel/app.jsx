// Panel shell (v2): sticky header (logo · search · quick add · Review inbox ·
// Updates bell · gear), the Upcoming | To-do | Calendar | Sources strip with
// the More dropdown, the review/updates/item/quick-add/check-readers
// overlays, and keyboard shortcuts.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useStore, query, IS_PREVIEW } from "./data.js";
import { primaryTabs, moreTabs, migrateTabId } from "./model/tabs.js";
import { BrandMark } from "../ui/brand.jsx";
import { SettingsIcon, InboxIcon, BellIcon, BellOffIcon, ArrowLeftIcon, PlusIcon, SearchIcon, ChevronDownIcon } from "../ui/icons.jsx";
import { pauseEndMs } from "../core/pause.js";
import { Upcoming } from "./views/Upcoming.jsx";
import { Todo } from "./views/Todo.jsx";
import { CalendarView } from "./views/Calendar.jsx";
import { Coop } from "./views/Coop.jsx";
import { Courses } from "./views/Courses.jsx";
import { Projects } from "./views/Projects.jsx";
import { Sources } from "./views/Sources.jsx";
import { Review } from "./views/Review.jsx";
import { Updates } from "./views/Updates.jsx";
import { ItemSheet } from "./views/ItemSheet.jsx";
import { QuickAdd } from "./views/QuickAdd.jsx";
import { Teams } from "./views/Teams.jsx";
import { CheckReaders } from "./views/CheckReaders.jsx";

const OVERLAY_TITLES = {
  review: "Review",
  updates: "Updates",
  item: "Item",
  quickadd: "Quick add",
  checkreaders: "Check readers",
};

/** Items still awaiting a review verdict. */
function pendingCount(items, userState) {
  let n = 0;
  for (const it of Object.values(items || {})) {
    if (!it || it.review !== "pending") continue;
    const v = (userState[it.id] || {}).review;
    if (v !== "accepted" && v !== "dismissed") n++;
  }
  return n;
}

/** Updates newer than updatesSeenAt. */
function unreadCount(updates, seenAt) {
  const seen = seenAt ? Date.parse(seenAt) : 0;
  let n = 0;
  for (const u of updates || []) {
    if (u && u.at && Date.parse(u.at) > seen) n++;
  }
  return n;
}

export function App() {
  const state = useStore();
  const tabs = useMemo(() => primaryTabs(state.settings), [state.settings]);
  const more = useMemo(() => moreTabs(state.settings), [state.settings]);
  const [tab, setTab] = useState(() => {
    const t = query.get("tab");
    if (t) return migrateTabId(t);
    // ?view=sources was the old overlay link; it's a tab now.
    return query.get("view") === "sources" ? "sources" : "upcoming";
  });
  const [moreOpen, setMoreOpen] = useState(() => query.get("more") === "1");
  const tabsNav = useRef(/** @type {any} */ (null));
  const [sheetId, setSheetId] = useState(() => query.get("item"));
  const [qaEditId, setQaEditId] = useState(() => null);
  const [reviewOrg, setReviewOrg] = useState(() => query.get("org"));
  const [overlay, setOverlay] = useState(() => {
    if (query.get("item")) return "item";
    if (query.get("quickadd")) return "quickadd";
    const v = query.get("view");
    return v && OVERLAY_TITLES[v] ? v : null;
  });
  const [now, setNow] = useState(() => new Date());
  const [toast, setToast] = useState(/** @type {{text: string, action?: {label: string, run: () => void}} | null} */ (null));
  const toastTimer = useRef(/** @type {any} */ (null));

  const reviewCount = useMemo(
    () => pendingCount(state.items, state.userState),
    [state.items, state.userState]
  );
  const updateCount = useMemo(
    () => unreadCount(state.updates, state.updatesSeenAt),
    [state.updates, state.updatesSeenAt]
  );
  const remindersPaused = useMemo(
    () =>
      pauseEndMs(
        (state.settings && state.settings.reminders) || {},
        now
      ) != null,
    [state.settings, now]
  );

  const actions = useMemo(
    () => ({
      ...state.actions,
      toast(text, action) {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast({ text, action });
        toastTimer.current = setTimeout(() => setToast(null), 6000);
      },
      /** Open the item detail sheet. */
      openItem(item) {
        if (!item || !item.id) return;
        setSheetId(item.id);
        setOverlay("item");
      },
      /** Open the Quick add form prefilled from a manual item (edit mode). */
      editManual(item) {
        setQaEditId(item && item.id ? item.id : null);
        setOverlay("quickadd");
      },
      /** Open the Review overlay filtered to one org (Teams "Needs review"). */
      openReviewOrg(org) {
        setReviewOrg(org || null);
        setOverlay("review");
      },
      /** Open the Check readers overlay. */
      openCheckReaders() {
        setOverlay("checkreaders");
      },
    }),
    [state.actions]
  );

  const openSettings = () => {
    try {
      if (!IS_PREVIEW && chrome.runtime && chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
        return;
      }
    } catch {
      /* fall through */
    }
    window.open("/src/options/options.html", "_blank");
  };

  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(tick);
  }, []);

  // An unknown/saved-elsewhere current tab falls back to Upcoming.
  useEffect(() => {
    if (tabs.length && !tabs.some((t) => t.id === tab) && !more.some((t) => t.id === tab)) {
      setTab("upcoming");
    }
  }, [tabs, more, tab]);

  // Close the More dropdown on any outside click.
  useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [moreOpen]);

  // Keep the active tab in view when the strip scrolls horizontally.
  useEffect(() => {
    const el = tabsNav.current && tabsNav.current.querySelector('[aria-selected="true"]');
    if (el && el.scrollIntoView) {
      try {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
      } catch {
        el.scrollIntoView();
      }
    }
  }, [tab, tabs.length]);

  const goSearch = () => {
    setOverlay(null);
    setTab("upcoming");
    requestAnimationFrame(() => {
      const el = document.getElementById("upcoming-search");
      if (el) el.focus();
    });
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "Escape" && overlay) {
        setOverlay(null);
        return;
      }
      const digit = ["1", "2", "3", "4"].indexOf(e.key);
      if (digit >= 0 && digit < tabs.length) {
        setOverlay(null);
        setTab(tabs[digit].id);
      }
      if (e.key === "/") {
        e.preventDefault();
        goSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, tabs]);

  /** Known orgs for quick-add: course codes + watched Discord team names. */
  const orgs = useMemo(() => {
    const watched = (state.settings && state.settings.sources && state.settings.sources.discord
      && state.settings.sources.discord.watched) || {};
    const guilds = (state.sourceState.discord && state.sourceState.discord.state
      && state.sourceState.discord.state.guilds) || {};
    return [
      ...Object.keys(state.courses || {}),
      ...Object.keys(watched),
      ...Object.values(guilds).map((g) => g && g.name).filter(Boolean),
    ];
  }, [state.courses, state.settings, state.sourceState]);

  const overlayTitle = overlay ? OVERLAY_TITLES[overlay] : null;

  return (
    <div class="panel">
      <header class="panel-header">
        {overlay ? (
          <button
            type="button"
            class="btn-icon back-btn"
            aria-label="Back"
            onClick={() => setOverlay(null)}
          >
            <ArrowLeftIcon size={17} />
          </button>
        ) : null}
        <div class="brand-lockup">
          <BrandMark size={30} />
          <div class="brand-words">
            <span class="brand-top">Waterloo</span>
            <span class="brand-name">{overlay ? overlayTitle : "All-in-1"}</span>
          </div>
        </div>
        <div class="header-actions">
          <button
            type="button"
            class="btn-icon"
            aria-label="Search"
            title="Search (/)"
            onClick={goSearch}
          >
            <SearchIcon size={17} />
          </button>
          <button
            type="button"
            class="btn-icon"
            aria-label="Quick add"
            title="Quick add"
            onClick={() => {
              setQaEditId(null);
              setOverlay(overlay === "quickadd" ? null : "quickadd");
            }}
          >
            <PlusIcon size={17} />
          </button>
          <button
            type="button"
            class="btn-icon has-badge"
            aria-label={`Review — ${reviewCount} pending`}
            title={`Review (${reviewCount})`}
            onClick={() => {
              if (overlay === "review") {
                setOverlay(null);
              } else {
                setReviewOrg(null);
                setOverlay("review");
              }
            }}
          >
            <InboxIcon size={17} />
            {reviewCount ? <span class="icon-badge">{reviewCount}</span> : null}
          </button>
          <button
            type="button"
            class="btn-icon has-badge"
            aria-label={`Updates — ${updateCount} new`}
            title={`Updates (${updateCount})`}
            onClick={() => setOverlay(overlay === "updates" ? null : "updates")}
          >
            {remindersPaused ? <BellOffIcon size={17} /> : <BellIcon size={17} />}
            {updateCount ? <span class="icon-badge">{updateCount}</span> : null}
          </button>
          <button type="button" class="btn-icon" aria-label="Settings" onClick={openSettings}>
            <SettingsIcon size={17} />
          </button>
        </div>
      </header>

      {overlay ? null : (
        <nav class="panel-tabs" aria-label="Views" ref={tabsNav}>
          <div class="segmented" role="tablist">
            {tabs.map((t, i) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                title={`${t.label} (${i + 1})`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
            {more.length ? (
              <div class="more-wrap">
                <button
                  type="button"
                  role="tab"
                  aria-selected={more.some((t) => t.id === tab)}
                  aria-expanded={moreOpen}
                  aria-haspopup="menu"
                  class={`more-btn${more.some((t) => t.id === tab) ? " active" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMoreOpen(!moreOpen);
                  }}
                >
                  {(more.find((t) => t.id === tab) || {}).label || "More"} <ChevronDownIcon size={12} />
                </button>
                {moreOpen ? (
                  <div class="more-menu" role="menu">
                    {more.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        role="menuitem"
                        aria-selected={tab === t.id}
                        onClick={() => {
                          setMoreOpen(false);
                          setTab(t.id);
                        }}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </nav>
      )}

      <main class="panel-body" role="tabpanel">
        {!overlay && state.lastAudit && state.lastAudit.errors > 0 ? (
          <button
            type="button"
            class="attention-strip"
            role="alert"
            onClick={openSettings}
          >
            Health check found {state.lastAudit.errors} storage error
            {state.lastAudit.errors === 1 ? "" : "s"} — open Settings → About to see them
          </button>
        ) : null}
        {overlay === "review" ? (
          <Review
            state={state}
            actions={actions}
            now={now}
            org={reviewOrg}
            onBack={() => setOverlay(null)}
          />
        ) : overlay === "item" && sheetId ? (
          <ItemSheet
            state={state}
            actions={actions}
            now={now}
            itemId={sheetId}
            onClose={() => setOverlay(null)}
          />
        ) : overlay === "quickadd" ? (
          <QuickAdd
            state={state}
            actions={actions}
            now={now}
            orgs={orgs}
            editItem={qaEditId ? state.items[qaEditId] : null}
            initialText={query.get("q") || ""}
            onClose={() => setOverlay(null)}
          />
        ) : overlay === "updates" ? (
          <Updates
            state={state}
            actions={actions}
            now={now}
            onGoAgenda={() => {
              setOverlay(null);
              setTab("upcoming");
            }}
          />
        ) : overlay === "checkreaders" ? (
          <CheckReaders state={state} actions={actions} now={now} />
        ) : tab === "sources" ? (
          <Sources
            state={state}
            actions={actions}
            now={now}
            onGoCourses={() => setTab("courses")}
            onOpenCheck={() => setOverlay("checkreaders")}
          />
        ) : tab === "todo" ? (
          <Todo state={state} actions={actions} now={now} orgs={orgs} />
        ) : tab === "projects" ? (
          <Projects state={state} actions={actions} now={now} />
        ) : tab === "calendar" ? (
          <CalendarView state={state} actions={actions} now={now} />
        ) : tab === "coop" ? (
          <Coop state={state} actions={actions} now={now} />
        ) : tab === "teams" ? (
          <Teams
            state={state}
            actions={actions}
            now={now}
            onOpenReview={(org) => actions.openReviewOrg(org)}
          />
        ) : tab === "courses" ? (
          <Courses state={state} actions={actions} now={now} />
        ) : (
          <Upcoming
            state={state}
            actions={actions}
            now={now}
            onGoSources={() => setTab("sources")}
            onGoCalendar={() => setTab("calendar")}
          />
        )}
      </main>

      {toast ? (
        <div class="toast" role="status">
          <span>{toast.text}</span>
          {toast.action ? (
            <button
              type="button"
              class="toast-act"
              onClick={() => {
                toast.action.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
