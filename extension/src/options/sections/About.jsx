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
      });
    } else {
      const all = await chrome.storage.local.get([
        SETTINGS_KEY,
        "userState",
        "raw:manual",
        "outlineFiles",
      ]);
      const raw = all["raw:manual"];
      payload = buildBackup({
        settings: all[SETTINGS_KEY],
        userState: all.userState,
        manualItems: raw && Array.isArray(raw.items) ? raw.items : [],
        outlineFiles: all.outlineFiles,
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

      <Card title="Privacy">
        <p class="help">Everything stays on this computer unless you turn on calendar sync.</p>
      </Card>
    </div>
  );
}
