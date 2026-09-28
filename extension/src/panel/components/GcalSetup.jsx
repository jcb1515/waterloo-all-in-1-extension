// @ts-check
// Google Calendar setup blocks for the Sources card: the export-read
// status line with a "Check again now" button, and the private iCal
// fallback addresses — a saved address is a secret, so only a masked
// "…/private-…/basic.ics" shape is ever shown.

import { Field } from "../../options/bits.jsx";
import { fmtAgo } from "../model/agenda.js";

const ICAL_URL_RE = /^https:\/\/calendar\.google\.com\/calendar\/ical\//;

/** "https://calendar.google.com/calendar/ical/<id>/private-<key>/basic.ics" -> "…/private-…/basic.ics" */
const maskUrl = (u) => {
  const segs = String(u || "").split("/").filter(Boolean);
  const tail = segs
    .slice(-2)
    .map((s) => (s.startsWith("private-") ? "private-…" : s))
    .join("/");
  return `…/${tail || "basic.ics"}`;
};

/**
 * "Reads your own calendars every 6 h · <N> events · last read <ago>" from
 * sourceState.gcal (state.ics counts + the scheduler's lastOkAt), plus a
 * manual re-check and the iCal fallback list.
 * @param {{src: any, st: any, save: (patch: any) => void,
 *   sync: () => void, now?: Date}} p
 */
export function GcalRead({ src, st, save, sync, now }) {
  const state = (st && st.state) || {};
  const ics = state.ics || null;
  const urls = (Array.isArray(src.icalUrls) ? src.icalUrls : []).filter(
    (u) => typeof u === "string" && ICAL_URL_RE.test(u),
  );
  return (
    <div class="src-sub">
      <span class="label">Automatic read</span>
      <p class="source-detail">
        Reads your own calendars every 6 h
        {ics ? ` · ${ics.events || 0} events` : ""}
        {st && st.lastOkAt ? ` · last read ${fmtAgo(st.lastOkAt, now || new Date())}` : ""}
      </p>
      <div class="source-actions">
        <button type="button" class="btn btn-sm" onClick={sync}>
          Check again now
        </button>
      </div>
      <Field
        label="Private iCal addresses"
        help="Optional fallback for calendars the export misses. Paste the secret
          iCal address from Google Calendar settings — it stays in local settings
          and is only ever shown masked."
      >
        {urls.map((u, i) => (
          <div class="ical-row" key={i}>
            <code>{maskUrl(u)}</code>{" "}
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              onClick={() => save({ icalUrls: urls.filter((_, j) => j !== i) })}
            >
              Remove
            </button>
          </div>
        ))}
        <input
          class="input"
          placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics"
          onBlur={(e) => {
            const el = /** @type {HTMLInputElement} */ (e.target);
            const v = el.value.trim();
            if (!v) return;
            if (ICAL_URL_RE.test(v)) {
              save({ icalUrls: [...urls, v] });
              el.value = "";
            }
          }}
        />
      </Field>
    </div>
  );
}
