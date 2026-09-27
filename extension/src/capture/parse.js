// @ts-check
/*
  Runs a registered HTML parser ("<source>/<name>") in the offscreen document.
  Creates the document lazily, once, guarded against concurrent creation.
*/

const OFFSCREEN_URL = "src/capture/offscreen.html";

/** @type {Promise<void> | null} */
let creating = null;

async function hasDocument(url) {
  try {
    if (chrome.runtime.getContexts) {
      const ctxs = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [url],
      });
      return ctxs.length > 0;
    }
  } catch {
    /* fall through to hasDocument */
  }
  try {
    return await chrome.offscreen.hasDocument();
  } catch {
    return false;
  }
}

async function ensureOffscreen() {
  if (!creating) {
    creating = (async () => {
      const url = chrome.runtime.getURL(OFFSCREEN_URL);
      if (await hasDocument(url)) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["DOM_PARSER"],
        justification: "Parse HTML pages from UW sites",
      });
    })().finally(() => {
      creating = null;
    });
  }
  return creating;
}

/**
 * @param {string} html
 * @param {string} parser "<source>/<name>"
 * @param {Record<string, any>} [opts]
 */
export async function parseHtml(html, parser, opts) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", type: "parse", parser, html, opts });
}
