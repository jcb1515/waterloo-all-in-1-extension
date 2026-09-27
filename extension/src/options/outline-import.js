// @ts-check
/*
  Outline file import (Settings -> Sources -> Course outlines). Saved outline
  pages (Ctrl+S) and PDFs are stored under the `outlineFiles` storage key and
  handed to the outline adapter at sync time.

  HTML is sanitized before storing: scripts, styles and event handlers are
  stripped so nothing executable sits in storage. PDFs keep their base64 and
  also store extracted `text` (via pdf-text.js) so the outline adapter can
  parse them at sync time; a failed extraction flags `textError`.
*/

import { pdfToText } from "./pdf-text.js";

export const OUTLINE_FILES_KEY = "outlineFiles";
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

const STRIP_TAGS = new Set(["script", "style", "noscript", "iframe", "link", "svg"]);

/**
 * Remove scripts, styles, noscript/iframes, <link> and <svg> plus inline
 * on* attributes from a parsed outline document, and return sanitized HTML.
 * Pure — pass a DOM Document (DOMParser in the page, linkedom in tests).
 * @param {Document} doc
 * @returns {string}
 */
export function sanitizeOutlineHtml(doc) {
  if (!doc || !doc.documentElement) return "";
  for (const tag of STRIP_TAGS) {
    for (const el of Array.from(doc.querySelectorAll(tag))) el.remove();
  }
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes || [])) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  }
  return doc.documentElement.outerHTML;
}

/**
 * Turn a picked File into an outlineFiles entry.
 * @param {File} file
 * @returns {Promise<{id: string, name: string, kind: "html"|"pdf", size: number,
 *   addedAt: string, html?: string, base64?: string, text?: string, textError?: boolean}>}
 */
export async function fileToEntry(file) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name} is over 8 MB`);
  }
  const name = file.name || "outline";
  const isPdf = /\.pdf$/i.test(name);
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    kind: /** @type {"html"|"pdf"} */ (isPdf ? "pdf" : "html"),
    size: file.size,
    addedAt: new Date().toISOString(),
  };
  if (isPdf) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    }
    entry.base64 = btoa(bin);
    try {
      entry.text = await pdfToText(buf);
    } catch {
      entry.textError = true;
    }
  } else {
    const text = await file.text();
    const doc = new DOMParser().parseFromString(text, "text/html");
    entry.html = sanitizeOutlineHtml(doc);
  }
  return entry;
}
