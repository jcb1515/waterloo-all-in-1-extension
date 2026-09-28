// @ts-check
// "Check readers" overlay: per-source checklists that verify each reader sees
// what it expects — satisfied by the recorder's DOM probes (counts only) or
// by recent observe/sync readStats for sources without a probe.

import { useMemo, useState } from "preact/hooks";
import { checklistFor, CHECK_SOURCES } from "../../sources/probes.js";
import { IS_PREVIEW, send, query } from "../data.js";
import { UI } from "../../core/messages.js";
import { ClipboardCheckIcon } from "../../ui/icons.jsx";

/** Source order + labels + the tab hosts the snapshot button looks for. */
const SOURCE_META = [
  { id: "learn", label: "Learn", hosts: ["learn.uwaterloo.ca"] },
  { id: "portal", label: "Portal", hosts: ["portal.uwaterloo.ca"] },
  { id: "outline", label: "Course outlines", hosts: ["outline.uwaterloo.ca"] },
  { id: "waterlooworks", label: "WaterlooWorks", hosts: ["waterlooworks.uwaterloo.ca"] },
  { id: "discord", label: "Discord", hosts: ["discord.com"] },
  { id: "gmail", label: "Gmail", hosts: ["mail.google.com"] },
  {
    id: "outlook",
    label: "Outlook",
    hosts: ["outlook.office.com", "outlook.cloud.microsoft", "outlook.live.com"],
  },
];

const STATUS_ICON = {
  ok: { icon: "✓", cls: "check-ok" },
  fail: { icon: "✗", cls: "check-fail" },
  unchecked: { icon: "○", cls: "check-none" },
};

/**
 * @param {{state: any, actions: any, now: Date}} props
 */
export function CheckReaders({ state, actions, now }) {
  const probes = state.probes || {};
  const readStats = state.readStats || [];

  const sources = useMemo(
    () =>
      SOURCE_META.map((m) => ({
        ...m,
        rows: checklistFor(
          m.id,
          probes[m.id] || {},
          readStats.filter((s) => s && s.source === m.id),
          now
        ),
      })),
    [probes, readStats, now]
  );

  const okCount = sources.reduce(
    (n, s) => n + s.rows.filter((r) => r.status === "ok").length,
    0
  );
  const rowCount = sources.reduce((n, s) => n + s.rows.length, 0);
  /** ?saw=<source>:<rowId> pre-opens that row's "What it saw" (previews). */
  const saw = query.get("saw") || "";

  const downloadReport = async () => {
    const day = new Date().toISOString().slice(0, 10);
    const file = `waterloo-all-in-1-check-${day}.json`;
    const resp = await send({ type: UI.CHECK_REPORT });
    const report = resp && resp.report ? resp.report : { error: "unavailable" };
    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  return (
    <div class="sources-list check-readers">
      <p class="source-detail">
        Open each page below — the extension checks its readers see what they
        expect. Counts only; no text leaves the page. {okCount}/{rowCount} checks
        passing.
      </p>
      {sources.map((s) => (
        <SourceCheck key={s.id} meta={s} rows={s.rows} actions={actions} openSaw={saw} />
      ))}
      <div class="source-actions">
        <button type="button" class="btn btn-sm" onClick={downloadReport}>
          <ClipboardCheckIcon size={13} /> Download check report
        </button>
      </div>
    </div>
  );
}

/**
 * One source's checklist card plus its "Something missed?" capture.
 * @param {{meta: any, rows: any[], actions: any}} p
 */
function SourceCheck({ meta, rows, actions, openSaw }) {
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(false);
  const [missOpen, setMissOpen] = useState(false);

  const saveStructure = async () => {
    if (IS_PREVIEW) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      return;
    }
    try {
      const tabs = await chrome.tabs.query({});
      const tab = (tabs || []).find(
        (t) =>
          t.id != null &&
          !t.discarded &&
          meta.hosts.some((h) => (t.url || "").includes(h))
      );
      if (!tab || tab.id == null) {
        actions.toast(`Open a ${meta.label} tab first, then save.`);
        return;
      }
      const resp = await chrome.tabs.sendMessage(tab.id, {
        type: UI.PROBE_SNAPSHOT,
        note,
      });
      if (resp && resp.ok) {
        setSaved(true);
        setNote("");
        setTimeout(() => setSaved(false), 2500);
      } else {
        actions.toast("Couldn't read that tab — reload the page and try again.");
      }
    } catch {
      actions.toast("Couldn't reach the tab — reload the page and try again.");
    }
  };

  return (
    <section class="card source-card check-card">
      <div class="source-head">
        <div class="source-title">
          <h3>{meta.label}</h3>
        </div>
        <span class="source-meta tabular">
          {rows.filter((r) => r.status === "ok").length}/{rows.length}
        </span>
      </div>
      <ul class="check-rows">
        {rows.map((r) => (
          <CheckRow key={r.row.id} result={r} open={openSaw === `${meta.id}:${r.row.id}`} />
        ))}
      </ul>
      <div class="check-missed">
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          onClick={() => setMissOpen(!missOpen)}
        >
          Something missed?
        </button>
        {missOpen ? (
          <div class="check-missed-form">
            <textarea
              class="check-note"
              rows={2}
              placeholder="What should the reader have seen?"
              value={note}
              onInput={(e) => setNote(/** @type {any} */ (e.target).value)}
            />
            <button type="button" class="btn btn-sm" onClick={saveStructure}>
              {saved ? "Saved" : "Save page structure"}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * @param {{result: any, open?: boolean}} p
 */
function CheckRow({ result, open }) {
  const { row, status, text, counts, hints } = result;
  const s = STATUS_ICON[status] || STATUS_ICON.unchecked;
  const countsList = Object.entries(counts || {});
  return (
    <li class={`check-row ${s.cls}`}>
      <div class="check-row-head">
        <span class={`check-dot ${s.cls}`} aria-hidden="true">
          {s.icon}
        </span>
        <div class="check-row-body">
          <p class="check-label">{row.label}</p>
          <p class="check-status">{text}</p>
          <p class="check-how">{row.how}</p>
          {hints && hints.length > 1 ? (
            <ul class="check-hints">
              {hints.slice(1).map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {countsList.length ? (
        <details class="check-saw" open={open || undefined}>
          <summary>What it saw</summary>
          <ul class="check-counts">
            {countsList.map(([k, v]) => (
              <li key={k}>
                <span>{k}</span>
                <span class="tabular">{String(v)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}
