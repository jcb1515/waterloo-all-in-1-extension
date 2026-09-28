// Outline setup pieces for the Courses tab: the "Add outline" card (paste a
// link or upload saved pages/PDFs), the collapsible imported-files list with
// the PDF text backfill, and the per-course link row in the course Setup card.

import { useEffect, useState } from "preact/hooks";
import { normCourseCode } from "../../core/contract.js";
import { mutateKey } from "../../core/store.js";
import { IS_PREVIEW } from "../data.js";
import { fileToEntry, OUTLINE_FILES_KEY } from "../../options/outline-import.js";
import { pdfToText, base64ToBytes } from "../../options/pdf-text.js";
import { outlineUrlPatch } from "../model/setup.js";
import { FileTextIcon, TrashIcon } from "../../ui/icons.jsx";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// Stable empty list so the backfill effect doesn't re-fire every render.
const NO_FILES = /** @type {any[]} */ ([]);

/**
 * Persist a full outline `urls` map and nudge the outline source. Table keys
 * replace wholesale — always pass the map outlineUrlPatch returned.
 * @param {any} state @param {any} actions @param {Record<string, string>} urls
 */
export function saveOutlineUrls(state, actions, urls) {
  const src =
    (isObj(state.settings) &&
      isObj(state.settings.sources) &&
      state.settings.sources.outline) ||
    {};
  actions.saveSettings({ sources: { outline: { ...src, urls } } });
  actions.sync("outline");
}

/**
 * Imported outline files with preview-local state and the PDF text backfill
 * (moved here from the old options OutlineFiles block). `write` transforms
 * the stored list and re-syncs the outline source; `addFiles` turns picked
 * File objects into entries (same name replaces).
 * @param {any} state @param {any} actions
 */
export function useOutlineFiles(state, actions) {
  const [local, setLocal] = useState(/** @type {any[] | null} */ (null));
  const [error, setError] = useState("");
  const files = IS_PREVIEW && local ? local : state.outlineFiles || NO_FILES;

  // Backfill `text` for pdf entries imported before extraction existed. A
  // failure is remembered on the entry (textError) so it isn't retried.
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
          actions.sync("outline");
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

  /** @param {(cur: any[]) => any[]} fn */
  const write = async (fn) => {
    if (IS_PREVIEW) {
      setLocal((cur) => fn(cur || files));
      return;
    }
    await mutateKey(OUTLINE_FILES_KEY, (cur) => fn(Array.isArray(cur) ? cur : []));
    actions.sync("outline");
  };

  /** @param {any[]} picked File objects */
  const addFiles = async (picked) => {
    for (const file of picked) {
      try {
        const entry = await fileToEntry(file);
        await write((cur) => [...cur.filter((f) => f.name !== entry.name), entry]);
      } catch (err) {
        setError(String((err && /** @type {any} */ (err).message) || err));
      }
    }
  };

  return { files, error, write, addFiles };
}

/**
 * The "Add outline" card: a Paste link | Upload file segmented switch.
 * @param {{state: any, actions: any, addFiles: (picked: any[]) => Promise<void>,
 *   fileError?: string}} p
 */
export function AddOutlineCard({ state, actions, addFiles, fileError }) {
  const [mode, setMode] = useState(/** @type {"link"|"file"} */ ("link"));
  const [code, setCode] = useState("");
  const [url, setUrl] = useState("");

  const add = () => {
    const c = normCourseCode(code);
    if (!c || !url.trim()) return;
    saveOutlineUrls(state, actions, outlineUrlPatch(state.settings, c, url));
    if (actions.toast) actions.toast("Added — reading the outline…");
    setCode("");
    setUrl("");
  };

  return (
    <div class="card outline-add">
      <div class="outline-add-head">
        <h3>Add an outline</h3>
        <div class="segmented" role="group" aria-label="Add outline mode">
          <button
            type="button"
            aria-pressed={mode === "link"}
            onClick={() => setMode("link")}
          >
            Paste link
          </button>
          <button
            type="button"
            aria-pressed={mode === "file"}
            onClick={() => setMode("file")}
          >
            Upload file
          </button>
        </div>
      </div>
      {mode === "link" ? (
        <>
          <p class="help">
            The outline.uwaterloo.ca page with the assessments table — paste it
            for one course.
          </p>
          <div class="inline-row">
            <input
              class="input outline-code-input"
              value={code}
              placeholder="ECE 105"
              onInput={(e) => setCode(/** @type {any} */ (e.target).value)}
            />
            <input
              class="input"
              value={url}
              placeholder="https://outline.uwaterloo.ca/viewer/view/…"
              onInput={(e) => setUrl(/** @type {any} */ (e.target).value)}
            />
          </div>
          <div class="source-actions">
            <button
              type="button"
              class="btn btn-sm"
              disabled={!code.trim() || !url.trim()}
              onClick={add}
            >
              Add outline
            </button>
          </div>
        </>
      ) : (
        <>
          <p class="help">
            Save the outline page (Ctrl+S) or export its PDF, then import it —
            files stay on this computer and are read on the next sync.
          </p>
          <div class="source-actions">
            <label class="btn btn-sm">
              Choose files
              <input
                type="file"
                multiple
                accept=".html,.htm,.pdf"
                style={{ display: "none" }}
                onChange={(e) => {
                  addFiles(Array.from(/** @type {any} */ (e.target).files || []));
                  /** @type {any} */ (e.target).value = "";
                }}
              />
            </label>
          </div>
          {fileError ? <p class="help status-err">{fileError}</p> : null}
        </>
      )}
    </div>
  );
}

/**
 * "Outline files (n)": the collapsible imported-files list.
 * @param {{files: any[], write: (fn: (cur: any[]) => any[]) => Promise<void>}} p
 */
export function OutlineFileList({ files, write }) {
  if (!files.length) return null;
  return (
    <details class="card outline-files">
      <summary>Outline files ({files.length})</summary>
      <table class="edit-table">
        <tbody>
          {files.map((f) => (
            <tr key={f.id || f.name}>
              <td class="url-cell">
                <FileTextIcon size={12} /> {f.name}
              </td>
              <td class="num">
                {Math.round((f.size || 0) / 1024)} KB · {f.kind}
                {f.addedAt ? ` · ${new Date(f.addedAt).toLocaleDateString()}` : ""}
                {f.textError ? (
                  <span class="status-err"> · Couldn't read this PDF</span>
                ) : null}
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
    </details>
  );
}

const shortUrl = (u) =>
  String(u || "").replace(/^https?:\/\//, "").replace(/\/$/, "");

/**
 * The Outline row of a course's Setup card: the current link with
 * Replace/Remove, or "Add outline link" / "Upload outline" when there is
 * none. A link found by the outline sync (not the user's urls map) is shown
 * muted and can only be replaced, not removed.
 * @param {{state: any, actions: any, code: string, discoveredUrl?: string|null,
 *   addFiles: (picked: any[]) => Promise<void>}} p
 */
export function OutlineLinkEditor({ state, actions, code, discoveredUrl, addFiles }) {
  const urls =
    (isObj(state.settings) &&
      isObj(state.settings.sources) &&
      isObj(state.settings.sources.outline) &&
      state.settings.sources.outline.urls) ||
    {};
  const confUrl = urls[code] || null;
  const shown = confUrl || discoveredUrl || null;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  const save = (/** @type {string|null} */ u) =>
    saveOutlineUrls(state, actions, outlineUrlPatch(state.settings, code, u));

  if (editing) {
    return (
      <div class="inline-row">
        <input
          class="input"
          value={text}
          placeholder="https://outline.uwaterloo.ca/viewer/view/…"
          onInput={(e) => setText(/** @type {any} */ (e.target).value)}
        />
        <button
          type="button"
          class="btn btn-sm"
          disabled={!text.trim()}
          onClick={() => {
            save(text);
            setEditing(false);
          }}
        >
          Save
        </button>
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </div>
    );
  }

  if (!shown) {
    return (
      <div class="outline-edit">
        <button
          type="button"
          class="btn btn-sm"
          onClick={() => {
            setText("");
            setEditing(true);
          }}
        >
          Add outline link
        </button>
        <label class="btn btn-sm">
          Upload outline
          <input
            type="file"
            multiple
            accept=".html,.htm,.pdf"
            style={{ display: "none" }}
            onChange={(e) => {
              addFiles(Array.from(/** @type {any} */ (e.target).files || []));
              /** @type {any} */ (e.target).value = "";
            }}
          />
        </label>
      </div>
    );
  }

  return (
    <div class="outline-edit">
      <a class="outline-url" href={shown} target="_blank" rel="noreferrer" title={shown}>
        {shortUrl(shown)}
      </a>
      {!confUrl ? <span class="help">(found by sync)</span> : null}
      <span class="outline-edit-acts">
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          onClick={() => {
            setText(shown);
            setEditing(true);
          }}
        >
          Replace
        </button>
        {confUrl ? (
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            onClick={() => save(null)}
          >
            Remove
          </button>
        ) : null}
      </span>
    </div>
  );
}
