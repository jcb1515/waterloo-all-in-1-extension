// Email setup blocks for the Sources card: the per-provider read toggles
// (each asks for its own host group on click) and the guided mail scan.
// Moved from the old options Sources section — `save` writes the
// sources.outlook settings slice via actions.saveSettings.

import { useState } from "preact/hooks";
import { Toggle } from "../../options/bits.jsx";
import {
  OPTIONAL_PERMISSION_GROUPS,
  requestSourceAccess,
} from "../../core/permissions.js";
import { IS_PREVIEW, query, send } from "../data.js";
import { UI } from "../../core/messages.js";
import { ArrowRightIcon } from "../../ui/icons.jsx";

const PREVIEW_SCAN_QUERY =
  'received:>=2025-11-25 AND (subject:interview OR subject:deadline OR subject:exam OR hasattachment:yes)';

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
 * Guided "Scan my mail" — one button per enabled provider. Gmail opens its
 * search url in an existing mail tab; Outlook shows the query to paste.
 * Nothing navigates until this click.
 * @param {{src: any}} p
 */
export function MailScan({ src }) {
  const [outlookQuery, setOutlookQuery] = useState(
    IS_PREVIEW && query.get("mailscan") === "outlook" ? PREVIEW_SCAN_QUERY : null
  );
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(/** @type {string|null} */ (null));

  /** Reuse an open Gmail tab for the scan url; otherwise open a new one. */
  const openMailTab = async (url) => {
    if (IS_PREVIEW || !url) return;
    try {
      const tabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
      const tab = (tabs || []).find((t) => t.id != null && !t.discarded);
      if (tab) await chrome.tabs.update(tab.id, { url, active: true });
      else await chrome.tabs.create({ url });
    } catch {
      window.open(url, "_blank");
    }
  };

  const start = async (provider) => {
    if (IS_PREVIEW) {
      if (provider === "outlook") setOutlookQuery(PREVIEW_SCAN_QUERY);
      return;
    }
    setBusy(provider);
    try {
      const r = await send({ type: UI.MAIL_SCAN_START, provider });
      if (r && r.url) await openMailTab(r.url);
      else if (r && r.query) setOutlookQuery(r.query);
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(outlookQuery || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div class="src-sub mail-scan">
      <span class="label">Guided scan</span>
      <p class="help">
        Walk your older mail in a tab you control — the extension reads each message only while
        you open it.
      </p>
      <div class="toggle-col">
        {src.outlook !== false ? (
          <button
            type="button"
            class="btn btn-sm"
            disabled={busy === "outlook"}
            onClick={() => start("outlook")}
          >
            Scan my Outlook mail (last 60 days)
          </button>
        ) : null}
        {src.gmail !== false ? (
          <button
            type="button"
            class="btn btn-sm"
            disabled={busy === "gmail"}
            onClick={() => start("gmail")}
          >
            Scan my Gmail (last 60 days)
          </button>
        ) : null}
      </div>
      {outlookQuery ? (
        <div class="mail-scan-query">
          <code class="mail-scan-code">{outlookQuery}</code>
          <p class="help">Paste this into Outlook's search box.</p>
          <button type="button" class="btn btn-sm" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Guided mail-scan progress (copied from Sources.jsx so the whole "Scan my
 * mail" flow lives here). While sourceState.outlook.state.scan is set, the
 * next queued subject is a click-through into the user's own mail tab;
 * Stop clears the scan. Nothing navigates without a click.
 * @param {{st: any}} p
 */
export function EmailScanControls({ st }) {
  const state = (st && st.state) || {};
  const scan = state.scan;
  const queue = Array.isArray(state.scanQueue) ? state.scanQueue : [];
  const next = queue[0] || null;
  if (!scan) return null;

  const providerLabel = scan.provider === "gmail" ? "Gmail" : "Outlook";
  const hostPatterns =
    /** @type {Record<string, string[]>} */ (OPTIONAL_PERMISSION_GROUPS)[scan.provider] || [];

  /** Open a queued thread in the provider's existing mail tab, else a new tab. */
  const openQueued = async (url) => {
    if (IS_PREVIEW || !url) return;
    try {
      const tabs = hostPatterns.length ? await chrome.tabs.query({ url: hostPatterns }) : [];
      const tab = (tabs || []).find((t) => t.id != null && !t.discarded);
      if (tab) await chrome.tabs.update(tab.id, { url, active: true });
      else await chrome.tabs.create({ url });
    } catch {
      window.open(url, "_blank");
    }
  };

  return (
    <div class="mail-scan-controls">
      <p class="source-detail">
        Mail scan running — {providerLabel}, last {scan.days} days.
      </p>
      <div class="source-actions">
        {next ? (
          <button
            type="button"
            class="btn btn-sm"
            title={next.url}
            onClick={() => openQueued(next.url)}
          >
            <ArrowRightIcon size={13} /> Next ({queue.length} left): {next.subject}
          </button>
        ) : (
          <span class="source-detail">Queue empty — open the search results to feed it.</span>
        )}
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          onClick={() => send({ type: UI.MAIL_SCAN_STOP })}
        >
          Stop
        </button>
      </div>
    </div>
  );
}
