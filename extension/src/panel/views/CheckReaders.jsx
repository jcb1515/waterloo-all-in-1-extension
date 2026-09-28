// @ts-check
// "Check readers" overlay: per-source checklists that verify each reader sees
// what it expects — satisfied by the recorder's DOM probes (counts only) or
// by recent observe/sync readStats for sources without a probe. The cards
// live in views/sources/checkCards.jsx (shared with the Check segment).

import { useMemo } from "preact/hooks";
import { checklistFor } from "../../sources/probes.js";
import { send, query } from "../data.js";
import { ClipboardCheckIcon } from "../../ui/icons.jsx";
import {
  SOURCE_META,
  SourceCheck,
  downloadCheckReport,
} from "./sources/checkCards.jsx";

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
        <button type="button" class="btn btn-sm" onClick={() => downloadCheckReport(send)}>
          <ClipboardCheckIcon size={13} /> Download check report
        </button>
      </div>
    </div>
  );
}
