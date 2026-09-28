// @ts-check
// The SETUP registry: W1's Sources page mounts SETUP[sourceId]({state,
// actions}) under each source's "Setup" segment. `email`/`gmail` alias the
// outlook adapter's page — the email adapter serves both providers.

import {
  LearnSetup,
  PortalSetup,
  OutlineSetupPage,
  EmailSetupPage,
  WaterlooworksSetup,
  DiscordSetupPage,
  GcalSetup,
} from "./pages.jsx";

/**
 * @type {Record<string, (p: {state: any, actions: any}) => any>}
 */
export const SETUP = {
  learn: LearnSetup,
  outline: OutlineSetupPage,
  portal: PortalSetup,
  outlook: EmailSetupPage,
  waterlooworks: WaterlooworksSetup,
  discord: DiscordSetupPage,
  gcal: GcalSetup,
  email: EmailSetupPage,
  gmail: EmailSetupPage,
};
