// Panel shell: sticky header with the brand lockup + sync controls, the
// Agenda | Calendar | Co-op | Courses segmented tabs, the sources/review/
// updates overlays, and keyboard shortcuts.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useStore, query, IS_PREVIEW } from "./data.js";
import { storeSyncSummary } from "./model/sources.js";
import { ADAPTERS, stageForAdapter } from "../core/registry.js";
import { BrandMark } from "../ui/brand.jsx";
import { RefreshIcon, SettingsIcon, InboxIcon, BellIcon, ArrowLeftIcon, PlusIcon } from "../ui/icons.jsx";
import { Agenda } from "./views/Agenda.jsx";
import { CalendarView } from "./views/Calendar.jsx";
import { Coop } from "./views/Coop.jsx";
import { Courses } from "./views/Courses.jsx";
import { Sources } from "./views/Sources.jsx";
import { Review } from "./views/Review.jsx";
import { Updates } from "./views/Updates.jsx";
import { ItemSheet } from "./views/ItemSheet.jsx";
import { QuickAdd } from "./views/QuickAdd.jsx";

const TABS = [
  ["agenda", "Agenda"],
  ["calendar", "Calendar"],
  ["coop", "Co-op"],
  ["courses", "Courses"],
];

const OVERLAY_TITLES = {
  review: "Review",
  updates: "Updates",
  sources: "Sources",
  item: "Item",
  quickadd: "Quick add",
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
  const [tab, setTab] = useState(() => {
    const t = query.get("tab");
    return TABS.some(([id]) => id === t) ? /** @type {string} */ (t) : "agenda";
  });
  const [sheetId, setSheetId] = useState(() => query.get("item"));
  const [qaEditId, setQaEditId] = useState(() => null);
  const [overlay, setOverlay] = useState(() => {
    if (query.get("item")) return "item";
    if (query.get("quickadd")) return "quickadd";
    const v = query.get("view");
    return v && OVERLAY_TITLES[v] ? v : null;
  });
  const [syncing, setSyncing] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [toast, setToast] = useState(/** @type {{text: string, action?: {label: string, run: () => void}} | null} */ (null));
  const toastTimer = useRef(/** @type {any} */ (null));

  const summary = useMemo(
    () => storeSyncSummary(ADAPTERS, state.sourceState, stageForAdapter, now),
    [state.sourceState, now]
  );

  const reviewCount = useMemo(
    () => pendingCount(state.items, state.userState),
    [state.items, state.userState]
  );
  const updateCount = useMemo(
    () => unreadCount(state.updates, state.updatesSeenAt),
    [state.updates, state.updatesSeenAt]
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
    }),
    [state.actions]
  );

  const refresh = () => {
    if (syncing) return;
    setSyncing(true);
    state.actions.sync();
    // The sync lands via storage changes; give the spin a bounded life.
    setTimeout(() => setSyncing(false), 3000);
  };

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

  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "r") refresh();
      if (e.key === "Escape" && overlay) {
        setOverlay(null);
        return;
      }
      const digit = ["1", "2", "3", "4"].indexOf(e.key);
      if (digit >= 0 && digit < TABS.length) {
        setOverlay(null);
        setTab(TABS[digit][0]);
      }
      if (e.key === "/") {
        e.preventDefault();
        setOverlay(null);
        setTab("agenda");
        requestAnimationFrame(() => {
          const el = document.getElementById("agenda-search");
          if (el) el.focus();
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [syncing, overlay]);

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
            aria-label="Quick add"
            title="Quick add"
            onClick={() => {
              setQaEditId(null);
              setOverlay(overlay === "quickadd" ? null : "quickadd");
            }}
          >
            <PlusIcon size={17} />
          </button>
          {overlay ? null : (
            <button
              type="button"
              class={`sync-pill tone-${summary.tone}`}
              onClick={() => setOverlay("sources")}
              title="Source status"
            >
              {syncing ? "Syncing…" : summary.label}
            </button>
          )}
          <button
            type="button"
            class="btn-icon has-badge"
            aria-label={`Review — ${reviewCount} pending`}
            title={`Review (${reviewCount})`}
            onClick={() => setOverlay(overlay === "review" ? null : "review")}
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
            <BellIcon size={17} />
            {updateCount ? <span class="icon-badge">{updateCount}</span> : null}
          </button>
          <button
            type="button"
            class="btn-icon"
            aria-label="Sync all sources"
            onClick={refresh}
            disabled={syncing}
          >
            <RefreshIcon size={17} />
          </button>
          <button type="button" class="btn-icon" aria-label="Settings" onClick={openSettings}>
            <SettingsIcon size={17} />
          </button>
        </div>
      </header>

      {overlay ? null : (
        <nav class="panel-tabs" aria-label="Views">
          <div class="segmented" role="tablist">
            {TABS.map(([id, label], i) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                title={`${label} (${i + 1})`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </nav>
      )}

      <main class="panel-body" role="tabpanel">
        {syncing ? <span class="sr-only" role="status">Syncing sources…</span> : null}
        {overlay === "review" ? (
          <Review state={state} actions={actions} now={now} onBack={() => setOverlay(null)} />
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
              setTab("agenda");
            }}
          />
        ) : overlay === "sources" ? (
          <Sources state={state} actions={actions} now={now} />
        ) : tab === "agenda" ? (
          <Agenda state={state} actions={actions} now={now} onGoSources={() => setOverlay("sources")} />
        ) : tab === "calendar" ? (
          <CalendarView state={state} actions={actions} now={now} />
        ) : tab === "coop" ? (
          <Coop state={state} actions={actions} now={now} />
        ) : (
          <Courses state={state} actions={actions} now={now} />
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
