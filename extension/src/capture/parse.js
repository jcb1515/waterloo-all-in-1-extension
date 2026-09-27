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

const PARSER_NAME = /^[a-z0-9_-]+\/[a-z0-9_-]+$/i;

/**
 * Runs a registered parser in the offscreen document and resolves with the
 * parser's own return value (the `{ok,result}` envelope is unwrapped).
 * Accepts either argument order — the contract order `(html, parser, opts)`
 * and the `(parser, html, opts)` order some adapters use.
 * @param {string} a html or parser name
 * @param {string} b parser name or html
 * @param {Record<string, any>} [opts]
 */
export async function parseHtml(a, b, opts) {
  await ensureOffscreen();
  const firstIsParser = PARSER_NAME.test(String(a || ""));
  const parser = firstIsParser ? a : b;
  const html = firstIsParser ? b : a;
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "parse", parser, html, opts });
  if (!res || res.ok !== true) throw new Error((res && res.error) || `parse failed: ${parser}`);
  return res.result;
}
