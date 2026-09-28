// Email setup blocks for the Sources card: the per-provider read toggles
// (each asks for its own host group on click) and the backfill status line
// with a "Check again now" button.
// Moved from the old options Sources section — `save` writes the
// sources.outlook settings slice via actions.saveSettings.

import { useState } from "preact/hooks";
import { Field, Toggle } from "../../options/bits.jsx";
import {
  OPTIONAL_PERMISSION_GROUPS,
  requestSourceAccess,
} from "../../core/permissions.js";
import { IS_PREVIEW } from "../data.js";
import { fmtAgo } from "../model/agenda.js";

const PROVIDER_LABEL = { gmail: "Gmail", outlook: "Outlook" };
const PROVIDER_HOME = {
  gmail: "https://mail.google.com/mail/u/0/#inbox",
  outlook: "https://outlook.office.com/mail/inbox",
};

/**
 * Two independent provider toggles under sources.outlook; each asks for
 * only its own host group on click. Denied -> stays off with a note.
 * @param {{src: any, save: (patch: any) => void}} p
 */
export function EmailProviders({ src, save }) {
  const [denied, setDenied] = useState(/** @type {Record<string, boolean>} */ ({}));
  const onProvider = async (/** @type {string} */ group, /** @type {boolean} */ v) => {
    if (v && !IS_PREVIEW) {
      const ok = await requestSourceAccess(group); // inside the click gesture
      if (!ok) {
        setDenied((d) => ({ ...d, [group]: true }));
        return;
      }
    }
    setDenied((d) => ({ ...d, [group]: false }));
    save({ [group]: v });
  };
  return (
    <div class="src-sub">
      <span class="label">Providers</span>
      <p class="help">Reads invites and dated mail only in mail tabs you already have open.</p>
      <div class="toggle-col">
        <Toggle
          label="Read Outlook"
          checked={src.outlook !== false}
          onChange={(v) => onProvider("outlook", v)}
        />
        <Toggle
          label="Read Gmail"
          checked={src.gmail !== false}
          onChange={(v) => onProvider("gmail", v)}
        />
      </div>
      {denied.outlook ? (
        <p class="help status-err">Outlook access wasn't granted — "Read Outlook" stays off.</p>
      ) : null}
      {denied.gmail ? (
        <p class="help status-err">Gmail access wasn't granted — "Read Gmail" stays off.</p>
      ) : null}
    </div>
  );
}

/**
 * Per-provider backfill status from sourceState.outlook.state.backfill:
 * "Last 30 days · 265 messages checked · last run 4m ago", a "Check again
 * now" button that pings every open non-discarded tab of that provider,
 * and — when no tab is open — an Open button to the provider's inbox.
 * @param {{src: any, st: any, now?: Date}} p
 */
export function EmailBackfill({ src, st, now }) {
  const state = (st && st.state) || {};
  const backfill = state.backfill || {};
  const lookback = Math.max(7, Math.min(90, Math.round(Number(src.lookbackDays) || 30)));
  const enabled = ["gmail", "outlook"].filter((prov) => src[prov] !== false);
  if (!enabled.length) return null;

  /** Ping every open non-discarded tab of the provider for an immediate read. */
  const checkNow = async (/** @type {string} */ prov) => {
    if (IS_PREVIEW) return;
    try {
      const patterns = /** @type {Record<string, string[]>} */ (
        OPTIONAL_PERMISSION_GROUPS
      )[prov];
      const tabs = patterns ? await chrome.tabs.query({ url: patterns }) : [];
      for (const t of tabs || []) {
        if (t.id == null || t.discarded) continue;
        chrome.tabs.sendMessage(t.id, { type: "wa1:mail-check-now" }).catch(() => {});
      }
    } catch {
      /* no tabs API (preview) */
    }
  };

  const openTab = (/** @type {string} */ prov) => {
    if (IS_PREVIEW) return;
    try {
      chrome.tabs.create({ url: PROVIDER_HOME[prov] });
    } catch {
      window.open(PROVIDER_HOME[prov], "_blank");
    }
  };

  return (
    <div class="src-sub">
      <span class="label">Automatic read</span>
      <p class="help">
        While a mail tab is open, new mail is checked every 30 minutes; a full pass over
        the lookback window runs at most every 6 hours.
      </p>
      {enabled.map((prov) => {
        const b = backfill[prov];
        return (
          <div class="mail-backfill" key={prov}>
            <p class="source-detail">
              <strong>{PROVIDER_LABEL[prov]}</strong>
              {" — "}
              {b ? (
                <>
                  Last {b.lookbackDays || lookback} days · {b.checked || 0} messages
                  checked · last run {fmtAgo(b.lastRunAt, now || new Date())}
                </>
              ) : (
                `Not read yet — open ${PROVIDER_LABEL[prov]} once`
              )}
            </p>
            <div class="source-actions">
              <button type="button" class="btn btn-sm" onClick={() => checkNow(prov)}>
                Check again now
              </button>
              {!b ? (
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  onClick={() => openTab(prov)}
                >
                  Open {PROVIDER_LABEL[prov]}
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const csv = (/** @type {any} */ v) => (Array.isArray(v) ? v.join(", ") : "");
const list = (/** @type {string} */ s) =>
  s.split(",").map((x) => x.trim()).filter(Boolean);

/**
 * The filter block: who counts (allow), who never does (block, wins over
 * allow), extra keywords, the Sent opt-in, the lookback window, the Gmail
 * invites flag and the course/co-op preset. Everything saves under
 * sources.outlook — the adapter and the mail tabs' content scripts read it
 * from there.
 * @param {{src: any, save: (patch: any) => void}} p
 */
export function EmailFilters({ src, save }) {
  const folders = Array.isArray(src.folders) ? src.folders : ["inbox"];
  const sentOn = folders.some((/** @type {any} */ f) => String(f).toLowerCase() === "sent");
  const setSent = (/** @type {boolean} */ on) =>
    save({
      folders: on
        ? [...new Set([...folders, "sent"])]
        : folders.filter((f) => String(f).toLowerCase() !== "sent"),
    });
  const lookback = Math.max(7, Math.min(90, Math.round(Number(src.lookbackDays) || 30)));
  const onLookback = (/** @type {any} */ e) => {
    const n = Math.round(Number(e.target.value));
    if (Number.isFinite(n)) save({ lookbackDays: Math.max(7, Math.min(90, n)) });
  };
  return (
    <div class="src-sub">
      <span class="label">Filters</span>
      <div class="toggle-col">
        <Toggle
          label="Course and co-op senders only"
          checked={src.onlyCourseCoop === true}
          onChange={(v) => save({ onlyCourseCoop: v })}
        />
        <Toggle
          label="Also read Sent (to close reply to-dos)"
          checked={sentOn}
          onChange={setSent}
        />
        {src.gmail !== false ? (
          <Toggle
            label="Also put Gmail invitations on the calendar"
            checked={src.gmailInvitesToFeed === true}
            onChange={(v) => save({ gmailInvitesToFeed: v })}
          />
        ) : null}
      </div>
      <Field
        label="Days to look back"
        help="How far the automatic read goes on a full pass (7–90)."
      >
        <input
          class="input"
          type="number"
          min="7"
          max="90"
          defaultValue={lookback}
          onBlur={onLookback}
        />
      </Field>
      <Field
        label="Always count (allow list)"
        help="Comma-separated addresses or domains — a domain also covers its subdomains."
      >
        <input
          class="input"
          defaultValue={csv(src.allowSenders)}
          placeholder="prof@uwaterloo.ca, acme.com"
          onBlur={(e) => save({ allowSenders: list(/** @type {any} */ (e.target).value) })}
        />
      </Field>
      <Field
        label="Never count (block list)"
        help="Same format; a block wins over everything, including the allow list."
      >
        <input
          class="input"
          defaultValue={csv(src.blockSenders)}
          placeholder="newsletter@, spammy.example.com"
          onBlur={(e) => save({ blockSenders: list(/** @type {any} */ (e.target).value) })}
        />
      </Field>
      <Field
        label="Keywords"
        help="Comma-separated words added to the built-in ones (interview, deadline, exam…)."
      >
        <input
          class="input"
          defaultValue={csv(src.keywords)}
          placeholder="tapeout, design review"
          onBlur={(e) => save({ keywords: list(/** @type {any} */ (e.target).value) })}
        />
      </Field>
    </div>
  );
}
