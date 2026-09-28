// About: version, open-source licenses link, privacy, backup & restore.

import { useRef, useState } from "preact/hooks";
import { Card } from "../bits.jsx";
import { IS_PREVIEW, query, send } from "../../panel/data.js";
import { SETTINGS_KEY, setLocal } from "../../core/store.js";
import { UI } from "../../core/messages.js";
import {
  applyBackup,
  backupFileName,
  buildBackup,
  validateBackup,
} from "../../core/backup.js";
import { ExternalLinkIcon } from "../../ui/icons.jsx";

/** Sample pending-import state for preview screenshots (?backup=import). */
const PREVIEW_PENDING = {
  name: "waterloo-all-in-1-backup-2026-10-01.json",
  backup: {
    version: 1,
    settings: { general: {}, reminders: {}, sources: {} },
    userState: { "manual:a": { notes: "x" }, "learn:b": { done: true } },
    manualItems: [{ id: "manual:a" }],
    outlineFiles: [{ id: "f1" }],
  },
  summary: { settingsSections: 3, itemEdits: 2, manualItems: 1, outlineFiles: 1 },
};

/** Fixture report for the ?health=1 preview screenshot. */
const PREVIEW_AUDIT = {
  summary: { keys: 34, bytes: 402318, items: 138, rawItems: 415, todos: 9, projects: 3 },
  issues: [
    {
      id: "secrets-leak",
      severity: "error",
      area: "secrets",
      message: "Token-like data found outside calendarFeed: log:learn",
      count: 1,
      fixable: false,
      sample: ["log:learn"],
    },
    {
      id: "duplicates",
      severity: "warn",
      area: "items",
      message:
        "2 pair(s) look like the same event to the publish guard — check them in the Agenda",
      count: 2,
      fixable: false,
      sample: ["learn:mt1 ~ outline:midterm", "ww:int4 ~ gmail:abc"],
    },
    {
      id: "userstate-orphans",
      severity: "warn",
      area: "orphans",
      message:
        "4 userState row(s) point at items that no longer exist and have had no activity for 60 days",
      count: 4,
      fixable: true,
      sample: ["learn:a1", "learn:a2", "manual:x", "ww:old1"],
    },
    {
      id: "reminders-stale",
      severity: "info",
      area: "orphans",
      message: "6 reminder record(s) are older than 30 days",
      count: 6,
      fixable: true,
      sample: ["learn:a1:120:…", "manual:x:1440:…"],
    },
    {
      id: "storage-total",
      severity: "info",
      area: "caps",
      message: "Storage holds 393 KiB across 34 keys (unlimitedStorage is enabled)",
      count: 34,
      fixable: false,
    },
  ],
};

const SEV_ORDER = { error: 0, warn: 1, info: 2 };
const SEV_LABEL = { error: "Errors", warn: "Warnings", info: "Info" };

/** Settings → About → Health check: run the store audit, fix safe issues. */
function HealthCard() {
  const [report, setReport] = useState(
    IS_PREVIEW && query.get("health") === "1" ? PREVIEW_AUDIT : null,
  );
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const run = async () => {
    setRunning(true);
    const res = await send({ type: UI.AUDIT_RUN });
    if (res && res.report) setReport(res.report);
    setRunning(false);
  };

  const fix = async () => {
    setRunning(true);
    const res = await send({ type: UI.AUDIT_FIX });
    if (res && res.report) setReport(res.report);
    setRunning(false);
    setConfirming(false);
  };

  const download = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `waterloo-all-in-1-health-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const fixable = report ? report.issues.filter((i) => i.fixable) : [];
  const bySev = { error: [], warn: [], info: [] };
  if (report) {
    for (const i of [...report.issues].sort(
      (a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3)
    )) {
      (bySev[i.severity] || bySev.info).push(i);
    }
  }

  return (
    <Card title="Health check" id="health">
      <p class="help">
        Scans the stored data for malformed items, duplicates, stale references and secrets in
        the wrong place. Runs automatically once a week; errors show a banner in the panel.
      </p>
      <div class="inline-row">
        <button type="button" class="btn" onClick={run} disabled={running}>
          {running ? "Running…" : report ? "Run again" : "Run health check"}
        </button>
        {report ? (
          <button type="button" class="btn btn-ghost" onClick={download}>
            Download report
          </button>
        ) : null}
      </div>
      {report ? (
        <>
          <p class="health-summary tabular">
            {report.summary.keys} keys · {Math.round(report.summary.bytes / 1024)} KiB ·{" "}
            {report.summary.items} items · {report.summary.rawItems} raw items ·{" "}
            {report.summary.todos} to-dos · {report.summary.projects} projects
          </p>
          {report.issues.length ? (
            ["error", "warn", "info"].map((sev) =>
              bySev[sev].length ? (
                <div key={sev} class="health-group">
                  <h4 class={`health-sev health-sev-${sev}`}>
                    {SEV_LABEL[sev]} ({bySev[sev].length})
                  </h4>
                  <ul class="health-issues">
                    {bySev[sev].map((i) => (
                      <li key={i.id} class="health-issue">
                        <span class="health-msg">{i.message}</span>
                        {i.fixable ? <span class="badge badge-muted">fixable</span> : null}
                        {i.sample && i.sample.length ? (
                          <details class="health-sample">
                            <summary>{i.count} affected</summary>
                            <ul class="tabular">
                              {i.sample.map((s) => (
                                <li key={s}>{s}</li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null
            )
          ) : (
            <p class="status-ok">Nothing to report — the store looks healthy.</p>
          )}
          {fixable.length ? (
            confirming ? (
              <div class="inline-row">
                <span class="help">Apply {fixable.length} safe fix{fixable.length === 1 ? "" : "es"}?</span>
                <button type="button" class="btn btn-primary" onClick={fix} disabled={running}>
                  {running ? "Applying…" : "Fix now"}
                </button>
                <button type="button" class="btn btn-ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" class="btn" onClick={() => setConfirming(true)}>
                Fix safe issues ({fixable.length})
              </button>
            )
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

export function AboutSection({ state }) {
  let version = "0.0.1";
  let licensesUrl = "/licenses/THIRD_PARTY_NOTICES.txt";
  try {
    if (!IS_PREVIEW) {
      version = chrome.runtime.getManifest().version;
      licensesUrl = chrome.runtime.getURL("licenses/THIRD_PARTY_NOTICES.txt");
    }
  } catch {
    /* preview */
  }

  const fileRef = useRef(/** @type {any} */ (null));
  const [pending, setPending] = useState(
    IS_PREVIEW && query.get("backup") === "import" ? PREVIEW_PENDING : null,
  );
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function onExport() {
    let payload;
    if (IS_PREVIEW) {
      payload = buildBackup({
        settings: state && state.settings,
        userState: state && state.userState,
        manualItems: [],
        outlineFiles: state && state.outlineFiles,
        projects: state && state.projects,
      });
    } else {
      const all = await chrome.storage.local.get([
        SETTINGS_KEY,
        "userState",
        "raw:manual",
        "outlineFiles",
        "projects",
      ]);
      const raw = all["raw:manual"];
      payload = buildBackup({
        settings: all[SETTINGS_KEY],
        userState: all.userState,
        manualItems: raw && Array.isArray(raw.items) ? raw.items : [],
        outlineFiles: all.outlineFiles,
        projects: all.projects,
      });
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = backupFileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** @param {any} e */
  async function onFile(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    setError("");
    setDone(false);
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setError("That file isn't valid JSON.");
      return;
    }
    const res = validateBackup(parsed);
    if (!res.ok) {
      setError(res.error || "That file isn't a backup.");
      return;
    }
    setPending({ name: file.name, backup: parsed, summary: res.summary });
  }

  async function confirmImport() {
    if (!pending) return;
    const writes = applyBackup(pending.backup, {
      userState: IS_PREVIEW
        ? state && state.userState
        : (await chrome.storage.local.get("userState")).userState,
    });
    if (!IS_PREVIEW) {
      await setLocal(SETTINGS_KEY, writes.settings);
      await setLocal("userState", writes.userState);
      await setLocal("outlineFiles", writes.outlineFiles);
      if (writes.projects) await setLocal("projects", writes.projects);
      await send({ type: UI.MANUAL_SET, items: writes.manualItems });
    }
    setPending(null);
    setDone(true);
  }

  return (
    <div class="opt-stack">
      <Card title="Waterloo All-in-1">
        <p class="about-version tabular">Version {version}</p>
        <p class="help">
          Every Waterloo deadline, class, interview and meeting in one side panel and one Google
          Calendar.
        </p>
        <p class="about-links">
          <a href={licensesUrl} target="_blank" rel="noreferrer">
            Open-source licenses <ExternalLinkIcon size={12} />
          </a>
        </p>
      </Card>

      <Card title="Backup &amp; restore" id="backup">
        <p class="help">
          Export your settings, item edits, manual items and outline files to a JSON file. The
          calendar feed connection and source data are never included.
        </p>
        <div class="inline-row">
          <button type="button" class="btn" onClick={onExport}>
            Export backup
          </button>
          <button type="button" class="btn btn-ghost" onClick={() => fileRef.current && fileRef.current.click()}>
            Import backup…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={onFile}
          />
        </div>
        {error ? <p class="status-err">{error}</p> : null}
        {pending ? (
          <div class="backup-summary">
            <p>
              Restore <strong>{pending.name}</strong>?
            </p>
            <ul class="backup-counts">
              <li>{pending.summary.settingsSections} settings sections</li>
              <li>{pending.summary.itemEdits} item edits</li>
              <li>{pending.summary.manualItems} manual items</li>
              <li>{pending.summary.outlineFiles} outline files</li>
            </ul>
            <div class="inline-row">
              <button type="button" class="btn btn-primary" onClick={confirmImport}>
                Import
              </button>
              <button type="button" class="btn btn-ghost" onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
            <p class="help">This replaces your settings; item edits are merged.</p>
          </div>
        ) : null}
        {done ? <p class="status-ok">Backup imported.</p> : null}
      </Card>

      <HealthCard />

      <Card title="Privacy">
        <p class="help">Everything stays on this computer unless you turn on calendar sync.</p>
      </Card>
    </div>
  );
}
