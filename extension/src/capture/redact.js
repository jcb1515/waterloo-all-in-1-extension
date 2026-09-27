// @ts-check
/*
  Redaction helpers for the discovery recorder. They turn page text, JSON
  bodies and DOM landmarks into shapes safe to keep in a report: endpoints,
  key names and value types survive; personal values do not.

  Adapted from WATnow's shapeOf/redactText in extension/src/data/live-source.js
  (watnow @ 801a1b1, MIT, Eric Zou), extended here with URL normalisation,
  date patterns and an HTML outline. No chrome APIs, so the same code runs in
  the page world, the content script, the service worker and tests.
*/

const MAX_TEXT = 400;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces each extra word with "<redacted>" (case-insensitive, length > 1). */
export function replaceRedactWords(text, extraWords = []) {
  let s = String(text || "");
  for (const w of extraWords || []) {
    const word = String(w || "").trim();
    if (word.length > 1) s = s.replace(new RegExp(escapeRegExp(word), "gi"), "<redacted>");
  }
  return s;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\+\d[\d .\-()]{6,}\d|\(\d{3}\)[ .\-]?\d{3}[ .\-]\d{4}\b|\b\d{3}[ .\-]\d{3}[ .\-]\d{4}\b|\b\d{3}[ .\-]\d{4}\b/g;
const LONG_NUMBER_RE = /\b\d{8,}\b/g;

/**
 * Free text with anything personal removed: markup, email addresses,
 * phone-like numbers, long digit runs and the user's own redact words.
 */
export function redactText(text, extraWords = []) {
  let s = String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(EMAIL_RE, "<email>")
    .replace(PHONE_RE, "<phone>")
    .replace(LONG_NUMBER_RE, "<number>");
  s = replaceRedactWords(s, extraWords);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}...` : s;
}

/* ------------------------------------------------------------------ */
/* URL normalisation                                                   */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A path segment that identifies one user, object or session rather than a
 * route: long numbers (Discord snowflakes are 17-20 digits), UUIDs and long
 * opaque tokens.
 */
function isIdSegment(seg) {
  if (!seg) return false;
  if (/^\d{3,}$/.test(seg)) return true;
  if (UUID_RE.test(seg)) return true;
  const base = seg.replace(/\.[a-z0-9]{1,5}$/i, "");
  if (base.length >= 16 && /^[A-Za-z0-9_\-+~]+$/.test(base)) {
    if (/[A-Za-z]/.test(base) && /\d/.test(base)) return true; // mixed letters+digits
    if (base.length >= 32) return true; // long base64-ish token
  }
  return false;
}

const normSegments = (p) =>
  String(p || "")
    .split("/")
    .map((seg) => (isIdSegment(seg) ? "{id}" : seg))
    .join("/");

/**
 * "https://discord.com/api/v9/channels/123…/messages?limit=50&before=…"
 * -> "discord.com/api/v9/channels/{id}/messages?before&limit".
 * Query keys are kept sorted, values dropped. A hash route is normalised the
 * same way. Relative input keeps just its path.
 */
export function normalizePath(url) {
  let u;
  try {
    u = new URL(String(url || ""), "https://wa1-relative.invalid");
  } catch {
    return String(url || "").slice(0, 300);
  }
  let out = u.hostname === "wa1-relative.invalid" ? "" : u.host;
  out += normSegments(u.pathname);
  const keys = [...new Set(u.searchParams.keys())].sort();
  if (keys.length) out += `?${keys.join("&")}`;
  if (u.hash.length > 1) out += `#${normSegments(u.hash.slice(1))}`;
  return out;
}

/* ------------------------------------------------------------------ */
/* JSON shapes                                                         */
/* ------------------------------------------------------------------ */

// Keys whose values are never recorded, at any depth.
const IDENTITY_KEYS = new Set([
  "firstname", "lastname", "displayname", "username", "global_name", "email",
  "avatar", "discriminator", "phone", "token", "access_token", "authorization",
  "cookie", "uniquename", "orgdefinedid", "studentnumber", "userid",
]);
// "name" is redacted only when these siblings are present (a bare "name" on a
// course or channel is structural; on a user object it is personal).
const NAME_SIBLINGS = ["email", "avatar", "username"];

// A short string under one of these keys is a label worth keeping ("open",
// "Not Selected"), so its value survives redaction.
const LABEL_KEY_RE = /(status|state|type|kind|category|format|mode)$/i;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const URLISH_RE = /^https?:\/\//i;
const TIME_HINT_RE = /\d{1,2}:\d{2}/;
const DATE_HINT_RE = /\d{4}-\d{2}-\d{2}/;

const MONTH_RE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const WEEKDAY_RE =
  /\b(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;
// Month and weekday names, AM/PM, and ISO's T/Z markers keep their letters.
const KEEP_TOKEN_RE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|am|pm)\b|T(?=\d{2}:)|Z(?=$|[+-]\d)/gi;

/** "Oct 5, 2026 3:30 PM" -> "Oct 9, 9999 9:99 PM" */
export function datePattern(s) {
  const str = String(s);
  const keep = new Array(str.length).fill(false);
  for (const m of str.matchAll(new RegExp(KEEP_TOKEN_RE.source, "gi"))) {
    for (let i = m.index; i < m.index + m[0].length; i++) keep[i] = true;
  }
  return [...str]
    .map((ch, i) => (keep[i] ? ch : /\d/.test(ch) ? "9" : /[A-Za-z]/.test(ch) ? "x" : ch))
    .join("");
}

const isPlainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * One shape for an array's first items: the union of object keys, with "?"
 * on keys not present in every sampled object.
 */
function mergeShapes(list) {
  const objs = list.filter(isPlainObj);
  if (!objs.length) return list.length ? list[0] : null;
  /** @type {Record<string, any>} */
  const out = {};
  for (const o of objs) {
    for (const [k, v] of Object.entries(o)) {
      const key = objs.every((x) => k in x) ? k : `${k}?`;
      if (!(key in out)) out[key] = v;
    }
  }
  return out;
}

const MAX_DEPTH = 8;
const ARRAY_SAMPLE = 3;

/**
 * The shape of a JSON value: object key -> shape of its value. Identity keys
 * become "<redacted>", numbers "<number>", ISO datetimes "<iso-datetime>",
 * URLs "<url host/path>", other strings "<string N>".
 */
export function shapeOf(value, key = "", depth = 0, extraWords = []) {
  const k = String(key).toLowerCase();
  if (IDENTITY_KEYS.has(k)) return value == null ? null : "<redacted>";
  if (value === null || value === undefined) return value === null ? null : "<undefined>";
  if (Array.isArray(value)) {
    const items = value.slice(0, ARRAY_SAMPLE).map((v) => shapeOf(v, "", depth + 1, extraWords));
    return { "<array>": value.length, items: mergeShapes(items) };
  }
  if (isPlainObj(value)) {
    if (depth >= MAX_DEPTH) return "<object>";
    const siblings = new Set(Object.keys(value).map((x) => x.toLowerCase()));
    const nameIsPersonal = NAME_SIBLINGS.some((s) => siblings.has(s));
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k2, v] of Object.entries(value)) {
      out[k2] = k2.toLowerCase() === "name" && nameIsPersonal ? (v == null ? null : "<redacted>") : shapeOf(v, k2, depth + 1, extraWords);
    }
    return out;
  }
  if (typeof value === "number") return "<number>";
  if (typeof value === "boolean") return value;
  const s = String(value);
  if (LABEL_KEY_RE.test(key) && s.length <= 40 && !s.includes("@") && !/\d{5,}/.test(s)) {
    return redactText(s, extraWords);
  }
  if (ISO_RE.test(s)) return "<iso-datetime>";
  if (URLISH_RE.test(s)) return `<url ${normalizePath(s)}>`;
  if (s.length <= 60 && (MONTH_RE.test(s) || WEEKDAY_RE.test(s) || TIME_HINT_RE.test(s) || DATE_HINT_RE.test(s))) {
    return datePattern(s);
  }
  return `<string ${s.length}>`;
}

/* ------------------------------------------------------------------ */
/* HTML outlines                                                       */
/* ------------------------------------------------------------------ */

const NAV_CONTAINERS = 'nav, aside, [role="navigation"], [role="tree"], [role="tablist"]';
const NAV_ITEMS = 'a, li, button, [role="link"], [role="tab"], [role="treeitem"], [role="menuitem"]';
const COUNTED = {
  table: "table",
  tr: "tr",
  li: "li",
  article: "article",
  form: "form",
  "role=row": '[role="row"]',
  "role=listitem": '[role="listitem"]',
  "role=grid": '[role="grid"]',
  "role=dialog": '[role="dialog"]',
};

const attr = (el, name) => (el && el.getAttribute ? el.getAttribute(name) : null);

/**
 * The landmarks of a page or HTML response: headings, table headers, forms,
 * iframes, nav text, common classes/data attributes, <time> values and
 * structural element counts. Text runs through redactText first.
 */
export function htmlOutline(doc, extraWords = []) {
  /** @param {any} t @param {number} n */
  const redact = (t, n) => redactText(t, extraWords).slice(0, n);
  /** @type {{
    headings: string[], tables: string[][], forms: {action: string, fields: string[]}[],
    iframes: string[], nav: string[], classes: string[], dataAttrs: string[],
    timeSamples: string[], counts: Record<string, number>,
  }} */
  const out = {
    headings: [],
    tables: [],
    forms: [],
    iframes: [],
    nav: [],
    classes: [],
    dataAttrs: [],
    timeSamples: [],
    counts: {},
  };
  if (!doc || !doc.querySelectorAll) return out;

  for (const h of doc.querySelectorAll("h1,h2,h3,h4")) {
    if (out.headings.length >= 60) break;
    const t = redact(h.textContent, 80);
    if (t) out.headings.push(`${String(h.tagName).toLowerCase()}: ${t}`);
  }

  for (const table of doc.querySelectorAll("table")) {
    if (out.tables.length >= 30) break;
    out.tables.push([...table.querySelectorAll("th")].slice(0, 40).map((th) => redact(th.textContent, 80)));
  }

  for (const form of doc.querySelectorAll("form")) {
    if (out.forms.length >= 30) break;
    const action = attr(form, "action");
    out.forms.push({
      action: action ? normalizePath(action) : "",
      fields: [...form.querySelectorAll("input,select,textarea")]
        .slice(0, 60)
        .map((f) => attr(f, "name"))
        .filter(Boolean),
    });
  }

  for (const f of doc.querySelectorAll("iframe")) {
    if (out.iframes.length >= 30) break;
    const src = attr(f, "src");
    if (src) out.iframes.push(normalizePath(src));
  }

  const navText = new Set();
  for (const box of doc.querySelectorAll(NAV_CONTAINERS)) {
    for (const item of box.querySelectorAll(NAV_ITEMS)) {
      if (navText.size >= 200) break;
      const t = redact(item.textContent, 60);
      if (t) navText.add(t);
    }
  }
  out.nav = [...navText];

  const classFreq = new Map();
  const dataAttrs = new Map();
  for (const el of doc.querySelectorAll("*")) {
    const cls = attr(el, "class");
    if (cls) {
      for (const c of String(cls).split(/\s+/)) {
        if (c) classFreq.set(c, (classFreq.get(c) || 0) + 1);
      }
    }
    const attrs = el.attributes;
    if (attrs) {
      for (let i = 0; i < attrs.length; i++) {
        const a = attrs[i];
        if (a.name && a.name.startsWith("data-")) dataAttrs.set(a.name, (dataAttrs.get(a.name) || 0) + 1);
      }
    }
  }
  out.classes = [...classFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 80)
    .map(([c]) => redact(c, 60));
  out.dataAttrs = [...dataAttrs.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 40)
    .map(([a]) => a);

  for (const t of doc.querySelectorAll("time[datetime]")) {
    if (out.timeSamples.length >= 20) break;
    const dt = attr(t, "datetime");
    if (dt) out.timeSamples.push(datePattern(dt.slice(0, 60)));
  }

  for (const [name, sel] of Object.entries(COUNTED)) {
    try {
      out.counts[name] = doc.querySelectorAll(sel).length;
    } catch {
      out.counts[name] = 0;
    }
  }
  return out;
}

/** Small stable string hash (FNV-1a, hex) for dedupe keys. */
export function hashString(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
