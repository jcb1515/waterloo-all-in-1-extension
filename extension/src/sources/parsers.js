// @ts-check
/*
  Offscreen parser registry (owned by Window 1 — core). Each source exports
  pure `(doc: Document, opts) => data` functions from ./<id>/parsers.js; the
  offscreen document calls them by name as "<id>/<name>".
  outlook and gmail share the email adapter's parsers.
*/

import * as learn from "./learn/parsers.js";
import * as outline from "./outline/parsers.js";
import * as portal from "./portal/parsers.js";
import * as email from "./email/parsers.js";
import * as waterlooworks from "./waterlooworks/parsers.js";
import * as discord from "./discord/parsers.js";
import * as gcal from "./gcal/parsers.js";

export const PARSERS = {
  learn,
  outline,
  portal,
  email,
  waterlooworks,
  discord,
  gcal,
  outlook: email,
  gmail: email,
};
