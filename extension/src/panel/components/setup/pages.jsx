// @ts-check
// One Setup page component per source, mounted by SETUP in ./index.js under
// W1's Sources page. Each is SourceBasics plus the source's own blocks.
// Profile's sections/groups editing lives on the Portal page (v2).

import { SourceBasics } from "./SourceBasics.jsx";
import { EmailProviders, EmailBackfill, EmailFilters } from "../EmailSetup.jsx";
import { DiscordWatched, DiscordChannels } from "../DiscordSetup.jsx";
import { OutlineManager } from "../OutlineSetup.jsx";
import { WaterlooworksRefreshToggle } from "../WaterlooworksSetup.jsx";
import { sectionsPatch, groupPatch } from "../../model/setup.js";
import { normCourseCode } from "../../../core/contract.js";

/**
 * The "Your sections" block on Portal's page: one row per course code from
 * courses ∪ settings.profile.sections ∪ settings.profile.groups, with a
 * sections text input and a group input saved on blur.
 * @param {{state: any, actions: any}} p
 */
function SectionRows({ state, actions }) {
  const settings = state.settings || {};
  const profile = settings.profile || {};
  const codes = new Set();
  for (const list of [
    Object.keys(state.courses || {}),
    Object.keys(profile.sections || {}),
    Object.keys(profile.groups || {}),
  ]) {
    for (const k of list) {
      const c = normCourseCode(k);
      if (c) codes.add(c);
    }
  }
  const sorted = [...codes].sort();

  return (
    <div class="src-sub">
      <span class="label">Your sections</span>
      <p class="help">
        Portal fills this in automatically; what you type is used for any
        section type Portal doesn't list.
      </p>
      {sorted.length ? (
        <table class="edit-table">
          <tbody>
            {sorted.map((code) => {
              const sectionsText = (
                Array.isArray(profile.sections && profile.sections[code])
                  ? profile.sections[code]
                  : []
              ).join(", ");
              const groupText = (profile.groups && profile.groups[code]) || "";
              return (
                <tr key={code}>
                  <td class="code-cell">{code}</td>
                  <td>
                    <input
                      class="input"
                      defaultValue={sectionsText}
                      placeholder="LEC 002, TUT 104"
                      onBlur={(e) => {
                        const v = /** @type {any} */ (e.target).value;
                        if (v !== sectionsText) {
                          actions.saveSettings({
                            profile: {
                              sections: sectionsPatch(settings, code, v),
                            },
                          });
                        }
                      }}
                    />
                  </td>
                  <td class="num">
                    <input
                      class="input group-input"
                      defaultValue={groupText}
                      placeholder="Group"
                      onBlur={(e) => {
                        const v = /** @type {any} */ (e.target).value;
                        if (v !== groupText) {
                          actions.saveSettings({
                            profile: { groups: groupPatch(settings, code, v) },
                          });
                        }
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p class="help">
          No courses seen yet — open Portal once so your enrolment can be read.
        </p>
      )}
    </div>
  );
}

/** @param {{state: any, actions: any}} p */
export function LearnSetup(p) {
  return <SourceBasics sourceId="learn" {...p} />;
}

/** @param {{state: any, actions: any}} p */
export function PortalSetup(p) {
  return (
    <SourceBasics sourceId="portal" {...p}>
      <SectionRows state={p.state} actions={p.actions} />
    </SourceBasics>
  );
}

/** @param {{state: any, actions: any}} p */
export function OutlineSetupPage(p) {
  return (
    <SourceBasics sourceId="outline" {...p}>
      <OutlineManager state={p.state} actions={p.actions} />
    </SourceBasics>
  );
}

/** @param {{state: any, actions: any}} p */
export function EmailSetupPage(p) {
  const src =
    (p.state.settings &&
      p.state.settings.sources &&
      p.state.settings.sources.outlook) ||
    {};
  const save = (patch) =>
    p.actions.saveSettings({ sources: { outlook: { ...src, ...patch } } });
  const st = p.state.sourceState && p.state.sourceState.outlook;
  return (
    <SourceBasics sourceId="outlook" {...p}>
      <EmailProviders src={src} save={save} />
      <EmailBackfill src={src} st={st} now={p.state.now} />
      <EmailFilters src={src} save={save} />
    </SourceBasics>
  );
}

/** @param {{state: any, actions: any}} p */
export function WaterlooworksSetup(p) {
  return (
    <SourceBasics sourceId="waterlooworks" {...p}>
      <WaterlooworksRefreshToggle state={p.state} actions={p.actions} />
    </SourceBasics>
  );
}

/** @param {{state: any, actions: any}} p */
export function DiscordSetupPage(p) {
  const src =
    (p.state.settings &&
      p.state.settings.sources &&
      p.state.settings.sources.discord) ||
    {};
  const st = p.state.sourceState && p.state.sourceState.discord;
  const save = (patch) =>
    p.actions.saveSettings({ sources: { discord: { ...src, ...patch } } });
  return (
    <SourceBasics sourceId="discord" {...p}>
      <DiscordWatched src={src} save={save} />
      <DiscordChannels
        discordState={st && st.state}
        src={src}
        actions={p.actions}
      />
    </SourceBasics>
  );
}

/** @param {{state: any, actions: any}} p */
export function GcalSetup(p) {
  return <SourceBasics sourceId="gcal" {...p} />;
}
