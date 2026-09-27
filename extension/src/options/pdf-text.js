// @ts-check
/*
  Options-page PDF -> text. W2's pdfText() dynamically imports pdfjs; because
  the bundle maps both imports to one module instance, setting workerSrc here
  covers it. Only extension pages load this — the worker file ships at
  dist/vendor/pdf.worker.min.mjs. Without a chrome.runtime (tests, preview)
  pdfjs falls back to its fake worker.
*/

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfText } from "../sources/outline/pdf.js";

let configured = false;

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function pdfToText(bytes) {
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
