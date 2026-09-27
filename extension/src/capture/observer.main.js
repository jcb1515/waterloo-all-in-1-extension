// @ts-check
/*
  Page-world observer (manifest content script with world:"MAIN"). Wraps
  window.fetch and XMLHttpRequest so the discovery recorder (isolated world)
  sees which endpoints a site loads while the student browses. The page always
  gets its real response back untouched; bodies are read from a clone.

  Reports cross to the isolated world as CustomEvents on `document` with a
  JSON-string detail (structured clone across worlds is reliable for strings).
  Events that fire before the recorder is listening are kept in a ring buffer
  and replayed when it announces itself with "wa1:recorder-ready".

  Never touches WebSocket, never throws: every step is guarded so this script
  cannot break the page it runs in.
*/

import { PAGE_EVENT } from "../core/contract.js";

(() => {
  const MAX_BODY = 2000000;
  const BUFFER_MAX = 200;
  const READY_EVENT = "wa1:recorder-ready";

  /** @type {string[]} */
  const buffer = [];
  let ready = false;

  const absUrl = (u) => {
    try {
      return new URL(String(u), location.href).href;
    } catch {
      return String(u || "");
    }
  };

  function emit(payload) {
    let json;
    try {
      json = JSON.stringify(payload);
    } catch {
      return;
    }
    if (ready) {
      dispatch(json);
    } else {
      buffer.push(json);
      if (buffer.length > BUFFER_MAX) buffer.shift();
    }
  }

  function dispatch(json) {
    try {
      document.dispatchEvent(new CustomEvent(PAGE_EVENT, { detail: json }));
    } catch {
      /* never break the page */
    }
  }

  try {
    document.addEventListener(READY_EVENT, () => {
      if (ready) return;
      ready = true;
      for (const json of buffer.splice(0)) dispatch(json);
    });
  } catch {
    /* no document yet — events buffer until the listener attaches */
  }

  /** @param {{url: string, method: string, status: number, contentType: string, body: string | null, size: number}} p */
  function emitNet({ url, method, status, contentType, body, size }) {
    emit({ kind: "net", url, method, status, contentType, body, size, at: new Date().toISOString() });
  }

  const isWanted = (ct) => /json|html/i.test(String(ct || ""));

  function wrapFetch() {
    if (typeof window.fetch !== "function") return;
    const orig = window.fetch;
    window.fetch = function (...args) {
      const p = orig.apply(this, args);
      try {
        const req = /** @type {any} */ (args[0]);
        const init = /** @type {any} */ (args[1]);
        const method = String((init && init.method) || (req && req.method) || "GET").toUpperCase();
        const rawUrl = typeof req === "string" ? req : (req && req.url) || "";
        p.then((res) => {
          try {
            const clone = res.clone();
            const contentType = clone.headers.get("content-type") || "";
            const url = clone.url || absUrl(rawUrl);
            if (!isWanted(contentType)) {
              emitNet({ url, method, status: clone.status, contentType, body: null, size: 0 });
              return;
            }
            clone.text().then(
              (text) =>
                emitNet({
                  url,
                  method,
                  status: clone.status,
                  contentType,
                  body: text.length > MAX_BODY ? null : text,
                  size: text.length,
                }),
              () => {}
            );
          } catch {
            /* ignore */
          }
        }, () => {});
      } catch {
        /* ignore */
      }
      return p;
    };
  }

  function wrapXHR() {
    const proto = XMLHttpRequest.prototype;
    if (!proto || !proto.open || !proto.send) return;
    const origOpen = /** @type {any} */ (proto.open);
    const origSend = /** @type {any} */ (proto.send);

    proto.open = /** @type {any} */ (
      /** @this {any} */
      function (method, url, ...rest) {
        try {
          /** @type {any} */ (this).__wa1 = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
        } catch {
          /* ignore */
        }
        return origOpen.call(this, method, url, ...rest);
      }
    );

    proto.send = /** @type {any} */ (
      /** @this {any} */
      function (...args) {
        try {
          this.addEventListener("loadend", () => {
            try {
              const meta = /** @type {any} */ (this).__wa1 || {};
              const contentType = (this.getResponseHeader && this.getResponseHeader("content-type")) || "";
              /** @type {string | null} */
              let body = null;
              let size = 0;
              if (isWanted(contentType)) {
                /** @type {string | null} */
                let text = null;
                try {
                  if (this.responseType === "" || this.responseType === "text") text = String(this.responseText ?? "");
                  else if (this.responseType === "json") text = JSON.stringify(this.response);
                } catch {
                  text = null;
                }
                if (text != null) {
                  size = text.length;
                  if (text.length <= MAX_BODY) body = text;
                }
              }
              emitNet({
                url: absUrl(this.responseURL || meta.url || ""),
                method: meta.method || "GET",
                status: this.status,
                contentType,
                body,
                size,
              });
            } catch {
              /* ignore */
            }
          });
        } catch {
          /* ignore */
        }
        return origSend.apply(this, args);
      }
    );
  }

  try {
    wrapFetch();
    wrapXHR();
  } catch {
    /* never break the page */
  }
})();
