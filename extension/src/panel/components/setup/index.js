// @ts-check
// PLACEHOLDER — owned by W2 (stream/academic). Replace freely.
//
// Contract (see coordination/w1.md): the Sources source-page mounts
//   SETUP[sourceId]({ state, actions }) => JSX
// in its Setup segment. Entries absent from this map show an EmptyState.
//
// This minimal map wires the setup pieces that already exist so nothing
// regresses while W2 builds the real components. Kept JSX-free (plain .js)
// by using h() directly.

import { h } from "preact";
import { EmailProviders, MailScan } from "../EmailSetup.jsx";
import { DiscordWatched, DiscordChannels } from "../DiscordSetup.jsx";

/** @param {any} p @param {string} id */
const srcOf = (p, id) => ((p.state.settings && p.state.settings.sources && p.state.settings.sources[id]) || {});

/** @param {any} p @param {string} id */
const saveFor = (p, id) => (/** @type {any} */ patch) =>
  p.actions.saveSettings({ sources: { [id]: { ...srcOf(p, id), ...patch } } });

/** @type {Record<string, (p: {state: any, actions: any}) => any>} */
export const SETUP = {
  outlook: (p) =>
    h("div", { class: "setup-stack" }, [
      h(EmailProviders, { key: "p", src: srcOf(p, "outlook"), save: saveFor(p, "outlook") }),
      h(MailScan, { key: "s", src: srcOf(p, "outlook") }),
    ]),
  discord: (p) =>
    h("div", { class: "setup-stack" }, [
      h(DiscordWatched, { key: "w", src: srcOf(p, "discord"), save: saveFor(p, "discord") }),
      h(DiscordChannels, {
        key: "c",
        discordState: p.state.sourceState && p.state.sourceState.discord && p.state.sourceState.discord.state,
        src: srcOf(p, "discord"),
        actions: p.actions,
      }),
    ]),
};
