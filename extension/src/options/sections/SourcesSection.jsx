// Sources settings: per-source enable toggle, stage badge, site link — plus
// the outline URL list and Discord watched-server editors.

import { useEffect, useState } from "preact/hooks";
import { Card, Field, Toggle } from "../bits.jsx";
import { ADAPTERS, stageForAdapter } from "../../core/registry.js";
import { normCourseCode } from "../../core/contract.js";
import { mutateKey } from "../../core/store.js";
import { send, IS_PREVIEW, query } from "../../panel/data.js";
import { UI } from "../../core/messages.js";
import { fileToEntry, OUTLINE_FILES_KEY } from "../outline-import.js";
import { pdfToText, base64ToBytes } from "../pdf-text.js";
import {
  GROUP_LABELS,
  adapterGroups,
  neededGroups,
  requestSourceAccess,
} from "../../core/permissions.js";
import { AllowSourceButton, useAccessMap } from "../../ui/permissions.jsx";
import { ExternalLinkIcon, TrashIcon, PlusIcon, FileTextIcon } from "../../ui/icons.jsx";

const STAGE_BADGE = { live: "badge-ok", soon: "badge-muted" };
const STAGE_LABEL = { live: "Live", soon: "Coming soon" };

/**
 * @param {{settings: any, save: (patch: any) => void, state?: any}} p
 */
export function SourcesSection({ settings, save, state }) {
  const src = settings.sources || {};
  const [denied, setDenied] = useState(/** @type {Record<string, boolean>} */ ({}));

  const patchSource = (id, patch) => save({ sources: { [id]: { ...(src[id] || {}), ...patch } } });
  const enabledOf = (id) => !src[id] || src[id].enabled !== false;

  /**
   * Enabling Discord asks for its host group inside this click — denied ->
   * the toggle stays off with a note. The email adapter's master toggle only
   * flips the flag; its per-provider toggles ask for their own groups.
   * @param {string} id adapter id
   * @param {boolean} v
   */
  const onToggle = async (id, v) => {
    if (v && !IS_PREVIEW && id === "discord") {
      const ok = await requestSourceAccess("discord");
      if (!ok) {
        setDenied((d) => ({ ...d, discord: true }));
        return;
      }
    }
    setDenied((d) => ({ ...d, [id]: false }));
    patchSource(id, { enabled: v });
  };

  return (
    <div class="opt-stack">
      {ADAPTERS.map((a) => {
        const stage = stageForAdapter(a.id);
        const groups = adapterGroups(a.id);
        const optional = groups.length > 0;
        return (
          <Card key={a.id}>
            <div class="src-row">
              <div class="src-main">
                <div class="src-name">
                  <h3 class="opt-card-title">{a.label}</h3>
                  <span class={`badge ${STAGE_BADGE[stage]}`}>{STAGE_LABEL[stage]}</span>
                </div>
                <a
                  class="src-link"
                  href={`${a.origins[0]}/`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {a.origins[0].replace("https://", "")} <ExternalLinkIcon size={11} />
                </a>
              </div>
              <Toggle
                label="Enabled"
                checked={enabledOf(a.id)}
                onChange={(v) => onToggle(a.id, v)}
              />
            </div>
            {denied[a.id] ? (
              <p class="help status-err">
                Permission wasn't granted — {a.label} stays off. The browser prompt asks for
                access to {a.origins[0].replace("https://", "")}; allow it, then toggle again.
              </p>
            ) : null}
            {enabledOf(a.id) ? (
              <PermNotice groups={neededGroups(a.id, src[a.id])} label={a.label} />
            ) : null}
            {optional && !denied[a.id] ? (
              <p class="help">
                {a.id === "outlook"
                  ? "Optional permissions: your browser asks for Outlook and Gmail access separately when you turn each provider on."
                  : `Optional permission: your browser asks for ${a.origins[0].replace("https://", "")} when you enable this.`}
              </p>
            ) : null}
            {a.id === "outline" ? (
              <>
                <OutlineUrls src={src.outline || {}} save={save} />
                <OutlineFiles files={(state && state.outlineFiles) || []} />
              </>
            ) : null}
            {a.id === "outlook" ? (
              <>
                <EmailProviders src={src.outlook || {}} save={save} />
                <EmailAdvanced src={src.outlook || {}} save={save} />
              </>
            ) : null}
            {a.id === "discord" ? (
              <>
                <DiscordWatched src={src.discord || {}} save={save} />
                <DiscordAdvanced src={src.discord || {}} save={save} />
              </>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

/**
 * Shown under an enabled optional-permission source that lacks a grant —
 * e.g. permission revoked in the browser, or enabled before the grant flow.
 * One Allow button per missing group (email's Outlook and Gmail are separate).
 * @param {{groups: string[], label: string}} p
 */
function PermNotice({ groups, label }) {
  const access = useAccessMap(groups);
  const missing = (groups || []).filter((g) => access[g] === false);
  if (!missing.length) return null;
  return (
    <p class="help status-err">
      Needs permission to read {label}:{" "}
      {missing.map((g) => (
        <AllowSourceButton
          key={g}
          sourceId={g}
          className="btn btn-sm"
          label={`Allow ${GROUP_LABELS[g] || g}`}
        />
      ))}
    </p>
  );
}

/** Course code -> outline URL list editor. */
function OutlineUrls({ src, save }) {
  const urls = (src && src.urls) || {};
  const [code, setCode] = useState("");
  const [url, setUrl] = useState("");
  const write = (next) => save({ sources: { outline: { ...(src || {}), urls: next } } });

  return (
    <div class="src-sub">
      <span class="label">Outline URLs</span>
      <p class="help">One per course — the page with the assessments table.</p>
      <table class="edit-table">
        <tbody>
          {Object.entries(urls).map(([c, u]) => (
            <tr key={c}>
              <td class="code-cell">{c}</td>
              <td class="url-cell">{u}</td>
              <td class="row-act">
                <button
                  type="button"
                  class="btn-icon"
                  aria-label={`Remove ${c}`}
                  onClick={() => {
                    const next = { ...urls };
                    delete next[c];
                    write(next);
                  }}
                >
                  <TrashIcon size={14} />
                </button>
              </td>
            </tr>
          ))}
          <tr class="add-row">
            <td class="code-cell">
              <input
                class="input"
                value={code}
                placeholder="ECE 105"
                onInput={(e) => setCode(/** @type {any} */ (e.target).value)}
              />
            </td>
            <td>
              <input
                class="input"
                value={url}
                placeholder="https://outline.uwaterloo.ca/viewer/view/…"
                onInput={(e) => setUrl(/** @type {any} */ (e.target).value)}
              />
            </td>
            <td class="row-act">
              <button
                type="button"
                class="btn-icon"
                aria-label="Add outline URL"
                disabled={!code.trim() || !url.trim()}
                onClick={() => {
                  write({ ...urls, [normCourseCode(code)]: url.trim() });
                  setCode("");
                  setUrl("");
                }}
              >
                <PlusIcon size={15} />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Imported outline pages (saved HTML / PDF), stored under `outlineFiles`.
 * Re-parsed by the outline adapter on the next sync.
 * @param {{files: any[]}} p
 */
function OutlineFiles({ files }) {
  const [local, setLocal] = useState(/** @type {any[] | null} */ (null));
  const [error, setError] = useState("");
  const list = IS_PREVIEW && local ? local : files;

  const resync = () => send({ type: UI.SYNC, source: "outline" });

  // Backfill `text` for pdf entries imported before extraction existed.
  // A failure is remembered on the entry (textError) so the row can say so
  // and it isn't retried every render.
  useEffect(() => {
    if (IS_PREVIEW) return;
    for (const f of files) {
      if (!f || f.kind !== "pdf" || typeof f.text === "string" || f.textError) continue;
      void (async () => {
        try {
          if (!f.base64) throw new Error("no bytes stored");
          const text = await pdfToText(base64ToBytes(f.base64));
          await mutateKey(OUTLINE_FILES_KEY, (cur) =>
            (Array.isArray(cur) ? cur : []).map((x) =>
              x.id === f.id ? { ...x, text, textError: false } : x
            )
          );
          resync();
        } catch {
          await mutateKey(OUTLINE_FILES_KEY, (cur) =>
            (Array.isArray(cur) ? cur : []).map((x) =>
              x.id === f.id ? { ...x, textError: true } : x
            )
          );
        }
      })();
    }
  }, [files]);

  const write = async (/** @type {(cur: any[]) => any[]} */ fn) => {
    if (IS_PREVIEW) {
      setLocal((cur) => fn(cur || files));
      return;
    }
    await mutateKey(OUTLINE_FILES_KEY, (cur) => fn(Array.isArray(cur) ? cur : []));
    resync();
  };

  const onPick = async (/** @type {any} */ e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    for (const file of picked) {
      try {
        const entry = await fileToEntry(file);
        // Same name replaces (re-saving a page refreshes it).
        await write((cur) => [...cur.filter((f) => f.name !== entry.name), entry]);
      } catch (err) {
        setError(String((err && /** @type {any} */ (err).message) || err));
      }
    }
  };

  return (
    <div class="src-sub">
      <span class="label">Imported files</span>
      <p class="help">
        Or save the outline page (Ctrl+S) and import it — useful when a browser fetch is
        blocked. HTML pages are sanitized before storing; PDFs are read into text locally.
      </p>
      {list.length ? (
        <table class="edit-table">
          <tbody>
            {list.map((f) => (
              <tr key={f.id || f.name}>
                <td class="url-cell">
                  <FileTextIcon size={12} /> {f.name}
                </td>
                <td class="num">
                  {Math.round((f.size || 0) / 1024)} KB · {f.kind}
                  {f.addedAt ? ` · ${new Date(f.addedAt).toLocaleDateString()}` : ""}
                  {f.textError ? <span class="status-err"> · Couldn't read this PDF</span> : null}
                </td>
                <td class="row-act">
                  <button
                    type="button"
                    class="btn-icon"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => write((cur) => cur.filter((x) => x.id !== f.id))}
                  >
                    <TrashIcon size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class="help">No imported files yet.</p>
      )}
      {error ? <p class="help status-err">{error}</p> : null}
      <label class="btn">
        Import files
        <input
          type="file"
          multiple
          accept=".html,.htm,.pdf"
          style={{ display: "none" }}
          onChange={onPick}
        />
      </label>
    </div>
  );
}

/**
 * Email providers: two independent toggles under sources.outlook, each asking
 * for only its own host group on click. Denied -> stays off with a note.
 * @param {{src: any, save: (patch: any) => void}} p
 */
function EmailProviders({ src, save }) {
  const [denied, setDenied] = useState(/** @type {Record<string, boolean>} */ ({}));
  const patch = (p) => save({ sources: { outlook: { ...(src || {}), ...p } } });
  const onProvider = async (group, v) => {
    if (v && !IS_PREVIEW) {
      const ok = await requestSourceAccess(group);
      if (!ok) {
        setDenied((d) => ({ ...d, [group]: true }));
        return;
      }
    }
    setDenied((d) => ({ ...d, [group]: false }));
    patch({ [group]: v });
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
 * Email Advanced: extra senders, keywords, team names and the folder
 * allow-list, saved under sources.outlook (the adapter id).
 * @param {{src: any, save: (patch: any) => void}} p
 */
function EmailAdvanced({ src, save }) {
  const csv = (v) => (Array.isArray(v) ? v.join(", ") : "");
  const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const patch = (p) => save({ sources: { outlook: { ...(src || {}), ...p } } });
  const open = query.get("adv") === "1";

  return (
    <details class="src-sub email-advanced" open={open || undefined}>
      <summary class="label">Advanced</summary>
      <Field label="Senders" help="Comma-separated substrings matched against the sender name or address — mail from them always counts as important.">
        <input
          class="input"
          defaultValue={csv(src.senders)}
          placeholder="co-op, prof"
          onBlur={(e) => patch({ senders: list(/** @type {any} */ (e.target).value) })}
        />
      </Field>
      <Field label="Keywords" help="Comma-separated words added to the built-in ones (interview, deadline, exam…).">
        <input
          class="input"
          defaultValue={csv(src.keywords)}
          placeholder="tapeout, design review"
          onBlur={(e) => patch({ keywords: list(/** @type {any} */ (e.target).value) })}
        />
      </Field>
      <Field label="Teams" help="Comma-separated names — mail from them counts and supplies the org tag.">
        <input
          class="input"
          defaultValue={csv(src.teams)}
          placeholder="design team"
          onBlur={(e) => patch({ teams: list(/** @type {any} */ (e.target).value) })}
        />
      </Field>
      <Field label="Folders" help="Comma-separated folder allow-list; default is inbox only.">
        <input
          class="input"
          defaultValue={csv(src.folders)}
          placeholder="inbox"
          onBlur={(e) => patch({ folders: list(/** @type {any} */ (e.target).value) })}
        />
      </Field>
    </details>
  );
}

/** Watched Discord servers: name -> {focus: string[], channels: []}. Passive only. */
function DiscordWatched({ src, save }) {
  const watched = (src && src.watched) || {};
  const [name, setName] = useState("");
  const [focus, setFocus] = useState("");
  const write = (next) => save({ sources: { discord: { ...(src || {}), watched: next } } });

  return (
    <div class="src-sub">
      <span class="label">Watched servers</span>
      <p class="help">
        Read-only. The extension only looks at servers you list here — focus tags narrow it further
        (comma-separated, e.g. "electrical, firmware").
      </p>
      <table class="edit-table">
        <tbody>
          {Object.entries(watched).map(([n, w]) => (
            <tr key={n}>
              <td>{n}</td>
              <td>{(w && w.focus && w.focus.length) ? w.focus.join(", ") : <span class="help">all channels</span>}</td>
              <td class="row-act">
                <button
                  type="button"
                  class="btn-icon"
                  aria-label={`Remove ${n}`}
                  onClick={() => {
                    const next = { ...watched };
                    delete next[n];
                    write(next);
                  }}
                >
                  <TrashIcon size={14} />
                </button>
              </td>
            </tr>
          ))}
          <tr class="add-row">
            <td>
              <input
                class="input"
                value={name}
                placeholder="Server name"
                onInput={(e) => setName(/** @type {any} */ (e.target).value)}
              />
            </td>
            <td>
              <input
                class="input"
                value={focus}
                placeholder="focus tags (optional)"
                onInput={(e) => setFocus(/** @type {any} */ (e.target).value)}
              />
            </td>
            <td class="row-act">
              <button
                type="button"
                class="btn-icon"
                aria-label="Add watched server"
                disabled={!name.trim()}
                onClick={() => {
                  write({
                    ...watched,
                    [name.trim()]: {
                      focus: focus.split(",").map((s) => s.trim()).filter(Boolean),
                      channels: [],
                    },
                  });
                  setName("");
                  setFocus("");
                }}
              >
                <PlusIcon size={15} />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Discord Advanced: identity overrides and extra trigger words, saved under
 * sources.discord. The adapter infers these on its own; these correct it.
 * @param {{src: any, save: (patch: any) => void}} p
 */
function DiscordAdvanced({ src, save }) {
  const csv = (v) => (Array.isArray(v) ? v.join(", ") : "");
  const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const patch = (p) => save({ sources: { discord: { ...(src || {}), ...p } } });
  // ?adv=1 opens the section for screenshots/previews.
  const open = query.get("adv") === "1";

  return (
    <details class="src-sub discord-advanced" open={open || undefined}>
      <summary class="label">Advanced</summary>
      <Field label="Your Discord user id" help="Overrides the id inferred from your Mentions inbox.">
        <input
          class="input"
          defaultValue={src.userId || ""}
          placeholder="e.g. 123456789012345678"
          onBlur={(e) => patch({ userId: /** @type {any} */ (e.target).value.trim() })}
        />
      </Field>
      <Field label="Role ids" help="Comma-separated. Extends the roles inferred from role pings.">
        <input
          class="input"
          defaultValue={csv(src.roleIds)}
          placeholder="1234…, 5678…"
          onBlur={(e) => patch({ roleIds: list(/** @type {any} */ (e.target).value) })}
        />
      </Field>
      <Field label="Keywords" help="Comma-separated words that count as meeting triggers (e.g. scrum, standup).">
        <input
          class="input"
          defaultValue={csv(src.keywords)}
          placeholder="standup, retro"
          onBlur={(e) => patch({ keywords: list(/** @type {any} */ (e.target).value) })}
        />
      </Field>
    </details>
  );
}
