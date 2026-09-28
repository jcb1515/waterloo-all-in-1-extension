// @ts-check
// Shared "Check readers" cards — the per-source checklist rendering used by
// both the Check readers overlay (panel/views/CheckReaders.jsx) and the
// Sources page's per-source Check segment (panel/views/sources/Check.jsx).

import { useState } from "preact/hooks";
import { IS_PREVIEW } from "../../data.js";
import { UI } from "../../../core/messages.js";

/** Source order + labels + the tab hosts the snapshot button looks for. */
export const SOURCE_META = [
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
 * The "Download check report" handler: asks the background for the report
 * and saves it as JSON.
 * @param {(msg: any) => Promise<any>} send
 */
export async function downloadCheckReport(send) {
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
}

/**
 * One source's checklist card plus its "Something missed?" capture.
 * `rowExtra` (optional) is rendered inside each row's body by CheckRow — the
 * Check segment uses it for the row's Open button and stale-read warning.
 * @param {{meta: any, rows: any[], actions: any, openSaw?: string,
 *   rowExtra?: (result: any) => any}} p
 */
export function SourceCheck({ meta, rows, actions, openSaw, rowExtra }) {
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
          <CheckRow
            key={r.row.id}
            result={r}
            open={openSaw === `${meta.id}:${r.row.id}`}
            extra={rowExtra ? rowExtra(r) : null}
          />
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
 * @param {{result: any, open?: boolean, extra?: any}} p
 */
export function CheckRow({ result, open, extra }) {
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
          {extra}
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
