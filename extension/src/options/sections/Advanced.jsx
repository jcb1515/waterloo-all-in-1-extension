// Advanced: the per-source tuning that stays in the options page — email
// senders/keywords/folders and Discord identity/trigger overrides. The
// day-to-day source setup (toggles, outlines, sections, Discord servers and
// channels) moved into the side panel.

import { Card, Field, OpenPanelButton } from "../bits.jsx";
import { query } from "../../panel/data.js";

/**
 * @param {{settings: any, save: (patch: any) => void}} p
 */
export function AdvancedSection({ settings, save }) {
  const src = settings.sources || {};
  return (
    <div class="opt-stack">
      <Card title="Set up in the side panel">
        <p class="help">
          Sources, outlines, sections and Discord servers/channels are managed
          in the side panel — use the sync pill for Sources, or the Courses tab
          for outlines, sections and groups.
        </p>
        <p>
          <OpenPanelButton />
        </p>
      </Card>
      <Card title="Email">
        <EmailAdvanced src={src.outlook || {}} save={save} />
      </Card>
      <Card title="Discord">
        <DiscordAdvanced src={src.discord || {}} save={save} />
      </Card>
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
          placeholder="e.g. 000000000000000001"
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
