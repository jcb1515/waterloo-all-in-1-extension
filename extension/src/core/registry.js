// @ts-check
// The six source adapters. The baseline background still drives WATnow's
// LiveSource directly; the core scheduler starts consuming ADAPTERS in Phase 1.

import learn from "../sources/learn/index.js";
import outline from "../sources/outline/index.js";
import portal from "../sources/portal/index.js";
import email from "../sources/email/index.js";
import waterlooworks from "../sources/waterlooworks/index.js";
import discord from "../sources/discord/index.js";

/** @type {import("./contract.js").Adapter[]} */
export const ADAPTERS = [learn, outline, portal, email, waterlooworks, discord];
