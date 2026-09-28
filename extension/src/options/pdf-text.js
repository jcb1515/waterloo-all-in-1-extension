// @ts-check
/*
  Options-page PDF -> text. pdfjs is ~1.9 MB, so it must never land in a
  static bundle: both this module and W2's pdfText() import it dynamically,
  and esbuild splits it into a lazy chunk loaded on first PDF import.
  Because the bundle maps both dynamic imports to one module instance,
  setting workerSrc here covers pdfText's documents too. Only extension
  pages load this — the worker file ships at dist/vendor/pdf.worker.min.mjs.
  Without a chrome.runtime (tests, preview) pdfjs falls back to its fake
  worker.
*/

import { pdfText } from "../sources/outline/pdf.js";

let configured = false;

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function pdfToText(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!configured) {
    configured = true;
    try {
      const rt = /** @type {any} */ (globalThis.chrome) && chrome.runtime;
      const src = rt && typeof rt.getURL === "function" ? rt.getURL("vendor/pdf.worker.min.mjs") : "";
      if (src) pdfjs.GlobalWorkerOptions.workerSrc = src;
    } catch {
      /* fake-worker fallback */
    }
  }
  return pdfText(bytes);
}

/** base64 -> bytes (the stored outlineFiles pdf payload). */
export function base64ToBytes(/** @type {string} */ base64) {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
