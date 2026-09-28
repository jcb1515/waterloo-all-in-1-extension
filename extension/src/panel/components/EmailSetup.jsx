// Email setup blocks for the Sources card: the per-provider read toggles
// (each asks for its own host group on click) and the per-provider check
// status line with a "Check again now" button.
// Moved from the old options Sources section — `save` writes the
// sources.outlook settings slice via actions.saveSettings.

import { useState } from "preact/hooks";
import { Field, Toggle } from "../../options/bits.jsx";
import {
  OPTIONAL_PERMISSION_GROUPS,
  requestSourceAccess,
} from "../../core/permissions.js";
import { IS_PREVIEW, send } from "../data.js";
import { UI } from "../../core/messages.js";
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
 * Per-provider check status from sourceState.outlook.check[provider] (or,
 * until W1's writer hoists it, sourceState.outlook.state.check[provider]):
 * "Last checked N messages · <ago>", "Checking… N so far" while a run is in
 * flight, or "Not read yet — open Gmail/Outlook once". The button goes
 * through W1's UI.CHECK_NOW when that message exists; until then it pings
 * every open non-discarded tab of that provider with wa1:check-now and
 * shows the reply (accepted / not-on-page / signed-out) inline.
 * @param {{src: any, st: any, now?: Date}} p
 */
export function EmailBackfill({ src, st, now }) {
  const [reply, setReply] = useState(/** @type {Record<string, string>} */ ({}));
  const check =
    (st && st.check) || ((st && st.state && st.state.check) || {});
  const enabled = ["gmail", "outlook"].filter((prov) => src[prov] !== false);
  if (!enabled.length) return null;

  /** Force a read: UI.CHECK_NOW when wired, else wa1:check-now per tab. */
  const checkNow = async (/** @type {string} */ prov) => {
    if (IS_PREVIEW) return;
    const runId = `${prov}-${Date.now().toString(36)}`;
    const CHECK_NOW = /** @type {any} */ (UI).CHECK_NOW;
    if (CHECK_NOW) {
      send({ type: CHECK_NOW, source: prov }).catch(() => {});
      setReply((r) => ({ ...r, [prov]: "Checking…" }));
      return;
    }
    try {
      const patterns = /** @type {Record<string, string[]>} */ (
        OPTIONAL_PERMISSION_GROUPS
      )[prov];
      const tabs = patterns ? await chrome.tabs.query({ url: patterns }) : [];
      let answered = false;
      for (const t of tabs || []) {
        if (t.id == null || t.discarded) continue;
        try {
          const res = await chrome.tabs.sendMessage(t.id, {
            type: "wa1:check-now",
            source: prov,
            runId,
          });
          if (res && res.accepted) {
            setReply((r) => ({ ...r, [prov]: "Checking…" }));
          } else {
            const why = res && res.reason;
            setReply((r) => ({
              ...r,
              [prov]:
                why === "not-on-page"
                  ? `Open ${PROVIDER_LABEL[prov]} to the inbox first`
                  : why === "signed-out"
                    ? `Sign in to ${PROVIDER_LABEL[prov]} first`
                    : why === "disabled"
                      ? `${PROVIDER_LABEL[prov]} reading is off`
                      : "Not available on that page",
            }));
          }
          answered = true;
          break;
        } catch {
          /* tab has no listener — try the next one */
        }
      }
      if (!answered) {
        setReply((r) => ({ ...r, [prov]: `No ${PROVIDER_LABEL[prov]} tab is open` }));
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
        While a mail tab is open, the inbox is checked every 30 minutes.
      </p>
      {enabled.map((prov) => {
        const c = check[prov];
        const running = c && c.running;
        return (
          <div class="mail-backfill" key={prov}>
            <p class="source-detail">
              <strong>{PROVIDER_LABEL[prov]}</strong>
              {" — "}
              {running ? (
                <>Checking… {running.checked || 0} so far</>
              ) : c ? (
                <>
                  Last checked {c.checked || 0} messages
                  {" · "}
                  {fmtAgo(c.at, now || new Date())}
                  {c.ok === false && c.reason === "signed-out" ? " · signed out" : null}
                </>
              ) : (
                `Not read yet — open ${PROVIDER_LABEL[prov]} once`
              )}
            </p>
            <div class="source-actions">
              <button type="button" class="btn btn-sm" onClick={() => checkNow(prov)}>
                Check again now
              </button>
              {!c ? (
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  onClick={() => openTab(prov)}
                >
                  Open {PROVIDER_LABEL[prov]}
                </button>
              ) : null}
            </div>
            {reply[prov] ? <p class="help">{reply[prov]}</p> : null}
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
 * allow), extra keywords, the Sent opt-in, how much Outlook mail a run
 * reads, the Gmail invites flag and the course/co-op preset. Everything
 * saves under sources.outlook — the adapter and the mail tabs' content
 * scripts read it from there.
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
  const count = [50, 100, 200].includes(Number(src.outlookCount))
    ? Number(src.outlookCount)
    : 100;
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
      {src.outlook !== false ? (
        <Field label="Messages to check" help="Outlook reads the newest this many inbox messages. Gmail reads the first inbox page (50).">
          <select
            class="input"
            defaultValue={String(count)}
            onChange={(e) =>
              save({ outlookCount: Number(/** @type {any} */ (e.target).value) })
            }
          >
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </select>
        </Field>
      ) : null}
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
