// Discord setup blocks for the Sources card: the watched-server/focus editor
// and the per-server channel picker built on model/setup.js channelPicker.
// Channel ticks write the full channelTargets map, then sync the adapter so
// recomputeWatch applies them without opening Discord.

import { useMemo, useState } from "preact/hooks";
import {
  channelPicker,
  resetChannelsPatch,
  toggleChannelPatch,
} from "../model/setup.js";
import { PlusIcon, TrashIcon } from "../../ui/icons.jsx";

/**
 * Watched Discord servers: name -> {focus: string[], channels: []}.
 * `save` writes the sources.discord slice (e.g. {watched: next}).
 * @param {{src: any, save: (patch: any) => void}} p
 */
export function DiscordWatched({ src, save }) {
  const watched = (src && src.watched) || {};
  const [name, setName] = useState("");
  const [focus, setFocus] = useState("");
  const write = (next) => save({ watched: next });

  return (
    <div class="src-sub">
      <span class="label">Watched servers</span>
      <p class="help">
        Read-only. Listing servers narrows the watch to just them — focus tags
        narrow it further (comma-separated, e.g. "electrical, firmware").
      </p>
      <table class="edit-table">
        <tbody>
          {Object.entries(watched).map(([n, w]) => (
            <tr key={n}>
              <td>{n}</td>
              <td>
                {w && w.focus && w.focus.length ? (
                  w.focus.join(", ")
                ) : (
                  <span class="help">all channels</span>
                )}
              </td>
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
 * The Channels block: one collapsible server block per watched guild from
 * channelPicker, with an Automatic/Custom badge, category-grouped channel
 * checkboxes and a "Reset to automatic" link when custom.
 * @param {{discordState: any, src: any, actions: any}} p
 */
export function DiscordChannels({ discordState, src, actions }) {
  const picker = useMemo(
    () => channelPicker(discordState, src),
    [discordState, src]
  );

  /** Persist a full channelTargets map, then make the adapter re-resolve. */
  const saveTargets = (targets) => {
    actions
      .saveSettings({
        sources: { discord: { ...(src || {}), channelTargets: targets } },
      })
      .then(() => actions.sync("discord"));
  };

  if (!picker.length) {
    return (
      <div class="src-sub">
        <span class="label">Channels</span>
        <p class="help">
          No Discord servers seen yet — open Discord once so your server list
          can be read.
        </p>
      </div>
    );
  }

  return (
    <div class="src-sub">
      <span class="label">Channels</span>
      <p class="help">
        Tick channels to watch only those. Mentions of you are always picked
        up. Untick every channel to return a server to automatic.
      </p>
      {picker.map((g) => (
        <GuildChannels key={g.guildId} g={g} src={src} saveTargets={saveTargets} />
      ))}
    </div>
  );
}

/** @param {{g: ReturnType<typeof channelPicker>[number], src: any,
 *   saveTargets: (t: Record<string, string[]>) => void}} p */
function GuildChannels({ g, src, saveTargets }) {
  // Group the (already category+order sorted) channels by category.
  const cats = /** @type {[string, any[]][]} */ ([]);
  const seen = new Map();
  for (const c of g.channels) {
    const cat = c.category || "CHANNELS";
    if (!seen.has(cat)) {
      const list = [];
      seen.set(cat, list);
      cats.push([cat, list]);
    }
    /** @type {any[]} */ (seen.get(cat)).push(c);
  }

  return (
    <div class="discord-guild">
      <div class="discord-guild-head">
        <span class="discord-guild-name">{g.name}</span>
        <span class={`badge ${g.mode === "custom" ? "badge-ok" : "badge-muted"}`}>
          {g.mode === "custom" ? "Custom" : "Automatic"}
        </span>
        {g.mode === "custom" ? (
          <button
            type="button"
            class="btn-link"
            onClick={() => saveTargets(resetChannelsPatch(src, g.name))}
          >
            Reset to automatic
          </button>
        ) : null}
      </div>
      {g.noInventory ? (
        <p class="help">
          Open this server in Discord once so its channel list can be read.
        </p>
      ) : (
        cats.map(([cat, chans]) => (
          <div class="discord-cat" key={cat}>
            <span class="label">{cat}</span>
            {chans.map((c) => (
              <label class="check-row" key={c.id}>
                <input
                  type="checkbox"
                  checked={c.checked}
                  onChange={(e) =>
                    saveTargets(
                      toggleChannelPatch(
                        src,
                        g,
                        c.id,
                        /** @type {any} */ (e.target).checked
                      )
                    )
                  }
                />
                <span>#{c.name}</span>
                {c.suggested ? <span class="help">suggested</span> : null}
              </label>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
