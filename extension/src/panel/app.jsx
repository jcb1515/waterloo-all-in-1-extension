// Panel shell: sticky header with the brand lockup + sync controls, the
// Agenda | Sources segmented tabs, and keyboard shortcuts.

import { useEffect, useMemo, useState } from "preact/hooks";
import { useStore, query, IS_PREVIEW } from "./data.js";
import { storeSyncSummary } from "./model/sources.js";
import { ADAPTERS, stageForAdapter } from "../core/registry.js";
import { BrandMark } from "../ui/brand.jsx";
import { RefreshIcon, SettingsIcon } from "../ui/icons.jsx";
import { Agenda } from "./views/Agenda.jsx";
import { Sources } from "./views/Sources.jsx";

const TABS = [
  ["agenda", "Agenda"],
  ["sources", "Sources"],
];

export function App() {
  const state = useStore();
  const [tab, setTab] = useState(() => (query.get("tab") === "sources" ? "sources" : "agenda"));
  const [syncing, setSyncing] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const summary = useMemo(
    () => storeSyncSummary(ADAPTERS, state.sourceState, stageForAdapter, now),
    [state.sourceState, now]
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
      if (e.key === "1") setTab("agenda");
      if (e.key === "2") setTab("sources");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [syncing]);

  return (
    <div class="panel">
      <header class="panel-header">
        <div class="brand-lockup">
          <BrandMark size={30} />
          <div class="brand-words">
            <span class="brand-top">Waterloo</span>
            <span class="brand-name">All-in-1</span>
          </div>
        </div>
        <div class="header-actions">
          <button
            type="button"
            class={`sync-pill tone-${summary.tone}`}
            onClick={() => setTab("sources")}
            title="Source status"
          >
            {syncing ? "Syncing…" : summary.label}
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

      <main class="panel-body" role="tabpanel">
        {syncing ? <span class="sr-only" role="status">Syncing sources…</span> : null}
        {tab === "agenda" ? (
          <Agenda state={state} actions={state.actions} now={now} onGoSources={() => setTab("sources")} />
        ) : (
          <Sources state={state} actions={state.actions} now={now} />
        )}
      </main>
    </div>
  );
}
