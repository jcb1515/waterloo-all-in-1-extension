// Sources settings: per-source enable toggle, stage badge, site link — plus
// the outline URL list and Discord watched-server editors.

import { useState } from "preact/hooks";
import { Card, Field, Toggle } from "../bits.jsx";
import { ADAPTERS, stageForAdapter } from "../../core/registry.js";
import { normCourseCode } from "../../core/contract.js";
import { ExternalLinkIcon, TrashIcon, PlusIcon } from "../../ui/icons.jsx";

const STAGE_BADGE = { live: "badge-ok", soon: "badge-muted" };
const STAGE_LABEL = { live: "Live", soon: "Coming soon" };

/**
 * @param {{settings: any, save: (patch: any) => void, saveNow: (patch: any) => void}} p
 */
export function SourcesSection({ settings, save }) {
  const src = settings.sources || {};

  const patchSource = (id, patch) => save({ sources: { [id]: { ...(src[id] || {}), ...patch } } });
  const enabledOf = (id) => !src[id] || src[id].enabled !== false;

  return (
    <div class="opt-stack">
      {ADAPTERS.map((a) => {
        const stage = stageForAdapter(a.id);
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
                onChange={(v) => patchSource(a.id, { enabled: v })}
              />
            </div>
            {a.id === "outline" ? <OutlineUrls src={src.outline || {}} save={save} /> : null}
            {a.id === "discord" ? <DiscordWatched src={src.discord || {}} save={save} /> : null}
          </Card>
        );
      })}
    </div>
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
