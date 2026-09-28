// @ts-check
// WaterlooWorks in-tab refresh (T4). The passive snapshotter only sees the
// page the student is looking at, and WW's list data loads via session POSTs
// we can't replay. So while a /myAccount/ page is open and visible, a hidden
// same-origin iframe walks the dashboard, interviews and applications pages:
// WW's own JavaScript does every request inside that iframe — this code
// never fetches, never reads a token, and the only DOM action it takes is a
// click on the strict allowlist in `allowedClick` (read-only controls only).
//
// Snapshots go through buildSnapshot, which serialises only the observed
// element set and scrubs every on* attribute and javascript: href on a CLONE
// first — no buildForm token can ride into a payload.

import { detectPage, isLoggedOut } from "./parsers.js";

const MAX_BYTES = 1.5 * 1024 * 1024;
const OBSERVE_SEL = [
  "h1", "h2", "h3", "h4",
  "table",
  // label/value fallbacks: dl blocks and .label/.value-style pairs
  "dl", ".label", ".control-label", ".field-label",
  // dashboard: day headings sit in <strong> above each schedule table, and
  // the "Rank and Match" notice lives in .orbis-posting-actions
  "strong", ".orbis-posting-actions",
].join(",");

const THROTTLE_KEY = "wa1:ww-refresh-at";
const THROTTLE_MS = 30 * 60 * 1000;
// Same literal as core/store.js SETTINGS_KEY — the content bundle stays free
// of core imports.
const SETTINGS_KEY = "wa1Settings";
const POLL_MS = 300;
const STEP_TIMEOUT_MS = 15000;
const MAX_PAGE = 10;

const DASHBOARD_URL = "/myAccount/dashboard.htm";
const INTERVIEWS_URL = "/myAccount/co-op/full/interviews.htm";
const APPLICATIONS_URL = "/myAccount/co-op/full/applications.htm";

/** @type {Record<string, string>} Landing label for each allowed filter. */
const INTERVIEW_LABELS = {
  booked: "Booked Interviews",
  unscheduled: "Unscheduled Interviews",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const text = (el) =>
  String(el?.textContent ?? "").replace(/\s+/g, " ").trim();

const qsa = (root, sel) => {
  try {
    return [...(root?.querySelectorAll?.(sel) || [])];
  } catch {
    return [];
  }
};

const docText = (doc) =>
  String(
    doc?.body?.textContent ?? doc?.documentElement?.textContent ?? ""
  ).replace(/\s+/g, " ");

/**
 * A landing-row label with the live spelling normalised: WW writes the
 * applications summary row as "Total Submitted:" with a trailing colon.
 * @param {any} el
 */
const labelText = (el) => text(el).replace(/\s*:\s*$/, "");

const docOf = (frame) => {
  try {
    return frame?.contentDocument || frame?.contentWindow?.document || null;
  } catch {
    return null;
  }
};

const hrefOf = (frame) => {
  try {
    return String(frame?.contentWindow?.location?.href || "");
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------------------
// snapshot hygiene

/**
 * Serialise the observed element soup of `doc` — a top page or the refresh
 * iframe — into the same `<html data-wa1-complete>` envelope the parsers
 * expect. Elements are cloned and scrubbed first: every on* attribute and
 * every `javascript:` href is removed, so a View link's buildForm action
 * token can never reach a payload. Returns null when the snapshot would
 * exceed the size cap.
 * @param {any} doc
 * @param {boolean} [complete]
 * @returns {string|null}
 */
export function buildSnapshot(doc, complete = true) {
  if (!doc || typeof doc.querySelectorAll !== "function") return null;
  /** @type {any[]} */
  const targets = [];
  for (const el of doc.querySelectorAll(OBSERVE_SEL)) {
    // .label/.value pairs need their shared parent to keep the pairing.
    const target =
      el.matches?.(".label,.control-label,.field-label") && el.parentElement
        ? el.parentElement
        : el;
    if (!targets.includes(target)) targets.push(target);
  }
  // A target contained in another target would duplicate its tables.
  const unique = targets.filter(
    (t) => !targets.some((o) => o !== t && o.contains && o.contains(t))
  );
  const parts = [];
  for (const el of unique) {
    const clean =
      typeof el.cloneNode === "function" ? el.cloneNode(true) : el;
    scrubAttrs(clean);
    const html = clean.outerHTML;
    if (html && !parts.includes(html)) parts.push(html);
  }
  const snapshot =
    `<html data-wa1-complete="${complete ? "1" : "0"}"><head><title>` +
    `${String(doc.title || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")}` +
    `</title></head><body>${parts.join("")}</body></html>`;
  return snapshot.length <= MAX_BYTES ? snapshot : null;
}

/** Remove on* attributes and javascript: hrefs from an element subtree. */
function scrubAttrs(root) {
  if (!root || typeof root.removeAttribute !== "function") return;
  if (root.attributes) {
    for (const attr of [...root.attributes]) {
      const name = String(attr?.name || "");
      const value = String(attr?.value ?? "");
      if (/^on/i.test(name)) {
        // A View button's buildForm token dies with the attribute; the
        // digits-only eventId it carried survives on the row so the parser
        // can still key the event — nothing else from the handler is kept.
        const ev = /'eventId'\s*:\s*'(\d+)'/.exec(value);
        if (ev && typeof root.closest === "function") {
          const tr = root.closest("tr");
          if (tr && !tr.getAttribute?.("data-wa1-event-id")) {
            try {
              tr.setAttribute("data-wa1-event-id", ev[1]);
            } catch {
              /* readonly attr — ignore */
            }
          }
        }
        try {
          root.removeAttribute(name);
        } catch {
          // unreadable attr — leave it; the outerHTML below stays token-free
          // only if removal worked, so a failure here is acceptable rarity.
        }
      } else if (
        name.toLowerCase() === "href" &&
        /^\s*javascript\s*:/i.test(value)
      ) {
        try {
          root.removeAttribute(name);
        } catch {
          // unreadable attr — leave it; the outerHTML below stays token-free
          // only if removal worked, so a failure here is acceptable rarity.
        }
      }
    }
  }
  for (const child of qsa(root, "*")) scrubAttrs(child);
}

// ---------------------------------------------------------------------------
// click allowlist — the ONLY elements a refresh round may activate

/**
 * Whether the refresh may click `el` for `step`. Anything not explicitly
 * allowed returns false — the walker can only ever activate read-only
 * controls, never apply/withdraw/decline/book actions.
 * @param {any} el
 * @param {"interviews"|"applications"|"pagination"|"interview-detail"} step
 * @returns {boolean}
 */
export function allowedClick(el, step) {
  try {
    if (!el) return false;
    if (step === "pagination") {
      const cls = el.classList;
      if (!cls || typeof cls.contains !== "function") return false;
      if (!cls.contains("pagination__link")) return false;
      const label = text(el);
      if (!/^\d+$/.test(label)) return false;
      const n = Number.parseInt(label, 10);
      return n >= 2 && n <= MAX_PAGE;
    }
    if (String(el.tagName || "").toUpperCase() !== "A") return false;
    const onclick = String(
      (typeof el.getAttribute === "function"
        ? el.getAttribute("onclick")
        : el.onclick) || ""
    );
    if (!/buildForm\s*\(/.test(onclick)) return false;
    const row = typeof el.closest === "function" ? el.closest("tr") : null;
    if (step === "interview-detail") {
      // A grid row's "current tab" dropdown link: buildForm with EXACTLY
      // {action, interviewId} posting into this tab (empty target). Any
      // extra key, a _blank/"new tab" target, a different link text, or a
      // row outside the interviews grid fails.
      if (
        !/buildForm\s*\(\s*\{\s*action\s*:\s*'[^']+'\s*,\s*interviewId\s*:\s*'\d+'\s*\}\s*,\s*'[^']*'\s*,\s*''\s*\)/.test(
          onclick
        )
      ) {
        return false;
      }
      if (text(el) !== "current tab") return false;
      const tbody = row?.closest ? row.closest("tbody") : null;
      const table = row?.closest ? row.closest("table") : null;
      if (!tbody || !table) return false;
      return qsa(table, "th").some((th) =>
        /interview date|job id/i.test(text(th))
      );
    }
    const label = labelText(row?.cells?.[0] ?? row?.querySelector?.("td"));
    if (step === "interviews") {
      const m = onclick.match(
        /selectedFilter['"]?\s*:\s*['"]([A-Za-z]+)['"]/
      );
      const want = m ? INTERVIEW_LABELS[m[1].toLowerCase()] : undefined;
      // The row's label must match the filter in the onclick — a View on a
      // different row is not ours to click.
      return Boolean(want) && label === want;
    }
    if (step === "applications") {
      // Only the "Total Submitted" View — a per-status View would hide the
      // other statuses from the grid read, and its onclick carries a status
      // key.
      if (label !== "Total Submitted") return false;
      if (/['"]?status['"]?\s*:/i.test(onclick)) return false;
      return /^view$/i.test(text(el));
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// round orchestration

/**
 * The kill switch: `settings.sources.waterlooworks.autoRefresh` — absent
 * means on, only `false` turns it off; the source's own `enabled` flag
 * stops it too. Content scripts may read storage but never write it. A
 * storage read error fails closed: no refresh.
 * @returns {Promise<boolean>}
 */
async function refreshAllowed() {
  try {
    const got = /** @type {any} */ (
      await chrome.storage.local.get(SETTINGS_KEY)
    );
    const src = got?.[SETTINGS_KEY]?.sources?.waterlooworks;
    return !(
      src &&
      (src.enabled === false || src.autoRefresh === false)
    );
  } catch {
    return false;
  }
}

/**
 * WW serves a ~150-byte auto-submit stub before the real page, and the
 * frame can also sit on about:blank between navigations. Both are
 * transitions, never real pages: they must not satisfy a ready predicate
 * nor be read as signed-out.
 * @param {any} d
 */
const transitional = (d) => {
  try {
    if (!d || !d.documentElement) return true;
    if (docText(d)) return false;
    // No visible text but a form waiting to auto-submit — the WW
    // interstitial, not a page we can read or a signed-out screen.
    return qsa(d, "form").length > 0;
  } catch {
    return true;
  }
};

const signedOut = (frame) => {
  try {
    const href = hrefOf(frame);
    if (/notLoggedIn\.htm/i.test(href)) return true;
    const d = docOf(frame);
    if (!d || /^about:blank\b/i.test(href) || transitional(d)) return false;
    return isLoggedOut(d, href);
  } catch {
    return false;
  }
};

/** Thrown through the round when the iframe lands on a signed-out page. */
const SIGNED_OUT = Symbol("signed-out");

/** Resolves true on the frame's next load event, false on timeout. */
function waitForLoad(frame, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      frame.addEventListener("load", () => finish(true), { once: true });
    } catch {
      finish(false);
      return;
    }
    setTimeout(() => finish(false), ms);
  });
}

/** Poll the iframe document until `ready` holds or the deadline passes. */
async function pollReady(frame, ready, deadline) {
  for (;;) {
    if (signedOut(frame)) throw SIGNED_OUT;
    try {
      const d = docOf(frame);
      if (d && !transitional(d) && ready(d)) return true;
    } catch {
      // document mid-navigation — keep polling
    }
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/**
 * src navigation: wait for the load event, then poll until ready. WW
 * answers with an auto-submit stub first — it posts itself, the frame
 * loads again, and the poll keeps running until the real document
 * satisfies `ready` (the stub never can).
 * @returns {Promise<"ok"|"timeout"|"not-ready"|"error">}
 */
async function navigate(frame, url, ready) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  const loaded = waitForLoad(frame, STEP_TIMEOUT_MS);
  try {
    frame.src = url;
  } catch {
    return "error";
  }
  if (!(await loaded)) return "timeout";
  return (await pollReady(frame, ready, deadline)) ? "ok" : "not-ready";
}

/**
 * Click navigation. A View/detail click submits a WW form that replaces
 * the whole frame document — a load event follows, so wait for it before
 * polling: a ready check that runs while the pre-click document is still
 * present can pass on the page that is about to vanish, and the following
 * steps then run against a dead document. Pagination clicks only rewrite
 * the grid via WW's own page code and fire no load — for them the poll IS
 * the wait.
 * @returns {Promise<"ok"|"timeout"|"not-ready"|"not-allowed">}
 */
async function clickStep(el, step, frame, ready) {
  if (!allowedClick(el, step)) return "not-allowed";
  const before = docOf(frame);
  try {
    el.click();
  } catch {
    return "not-allowed";
  }
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  if (step === "pagination") {
    return (await pollReady(frame, ready, deadline)) ? "ok" : "not-ready";
  }
  // The document may already have changed by the time we look — a
  // same-document response, or a load that fired before the listener
  // could register. Then there is no load left to wait for.
  if (docOf(frame) === before && !(await waitForLoad(frame, STEP_TIMEOUT_MS))) {
    return "timeout";
  }
  return (await pollReady(frame, ready, deadline)) ? "ok" : "not-ready";
}

function sendFrame(frame) {
  const body = buildSnapshot(docOf(frame), true);
  if (!body) return false;
  chrome.runtime.sendMessage({
    type: "wa1:observed",
    payload: {
      source: "waterlooworks",
      kind: "dom",
      url: hrefOf(frame),
      body,
      at: new Date().toISOString(),
    },
  });
  return true;
}

// --- ready predicates -------------------------------------------------------

const readyDashboard = (d) =>
  /dashboard/i.test(String(d?.title || "")) && qsa(d, "table").length >= 1;

const rows = (d) => qsa(d, "tr");
const firstCell = (row) => row?.cells?.[0] ?? row?.querySelector?.("td");
const rowLabel = (row) => labelText(firstCell(row));

const readyInterviewsLanding = (d) =>
  rows(d).some((r) => rowLabel(r) === INTERVIEW_LABELS.booked);

const readyInterviewView = (d) => {
  for (const th of qsa(d, "th")) {
    if (/interview date/i.test(text(th))) return true;
  }
  return /no data to display/i.test(docText(d));
};

const readyInterviewDetail = (d) => detectPage(d, {}) === "interview-detail";

const readyAppsLanding = (d) => docText(d).includes("Total Submitted");

const readyAppsGrid = (d) => {
  if (qsa(d, "table tbody tr").length < 1) return false;
  for (const th of qsa(d, "th")) {
    if (/app status/i.test(text(th))) return true;
  }
  return false;
};

const firstRowText = (d) => text(qsa(d, "table tbody tr")[0]);

// --- steps ------------------------------------------------------------------

const makeFrame = (doc) => {
  const frame = doc.createElement("iframe");
  try {
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.style.position = "absolute";
    frame.style.left = "-9999px";
    frame.style.width = "1px";
    frame.style.height = "1px";
    frame.style.visibility = "hidden";
  } catch {
    // styling is best-effort — the iframe still works unstyled
  }
  return frame;
};

/** The Booked/Unscheduled landing rows with a nonzero count, in order. */
function interviewRows(d, done) {
  return rows(d).filter((r) => {
    const label = rowLabel(r);
    if (
      (label !== INTERVIEW_LABELS.booked &&
        label !== INTERVIEW_LABELS.unscheduled) ||
      done.has(label)
    ) {
      return false;
    }
    const count = Number.parseInt(text(r?.cells?.[1] ?? ""), 10);
    return Number.isFinite(count) && count > 0;
  });
}

const viewStepName = (label) =>
  label === INTERVIEW_LABELS.unscheduled
    ? "interviews-unscheduled"
    : "interviews-booked";

/** Detail visits allowed per round, across all interview views. */
const MAX_DETAILS = 10;

/** tbody rows of the interviews grid (Interview Date / Job ID headers). */
const interviewGridRows = (d) => {
  const table = qsa(d, "table").find((t) =>
    qsa(t, "th").some((th) => /interview date|job id/i.test(text(th)))
  );
  return table ? qsa(table, "tbody tr") : [];
};

const interviewIdOf = (a) => {
  const m = String(a?.getAttribute?.("onclick") || "").match(
    /interviewId\s*:\s*'(\d+)'/
  );
  return m ? m[1] : null;
};

/**
 * Visit each grid row's interview-detail page — the "current tab" link is
 * the only read-only way to the timeslot deadlines and booking details —
 * capped by `budget` across the whole round. After every detail the view
 * is re-entered (landing → its View row) so the next row's grid is back.
 */
async function interviewDetails(frame, send, runStep, viewLabel, budget) {
  for (let i = 0; ; i++) {
    const d = docOf(frame);
    if (!d) return;
    const rows = interviewGridRows(d);
    if (i >= rows.length || budget.used >= MAX_DETAILS) return;
    const link = qsa(rows[i], "a").find((a) =>
      allowedClick(a, "interview-detail")
    );
    if (!link) continue; // a row without a detail link — still on the view
    budget.used += 1;
    await runStep("interview-detail", async () => {
      const r = await clickStep(
        link,
        "interview-detail",
        frame,
        readyInterviewDetail
      );
      if (r !== "ok") return r;
      if (signedOut(frame)) throw SIGNED_OUT;
      send(frame);
      return "ok";
    });
    if (i + 1 >= rows.length) return; // no next row — leave via the caller
    // Re-enter this view (landing → its View row) before the next row.
    const back = await runStep("interviews-landing", async () => {
      const nav = await navigate(frame, INTERVIEWS_URL, readyInterviewsLanding);
      if (nav !== "ok") return nav;
      if (signedOut(frame)) throw SIGNED_OUT;
      return "ok";
    });
    if (back !== "ok") return;
    const reenter = await runStep(viewStepName(viewLabel), async () => {
      const d2 = docOf(frame);
      const vr =
        d2 &&
        interviewRows(d2, new Set()).find((r) => rowLabel(r) === viewLabel);
      const a =
        vr && qsa(vr, "a").find((x) => allowedClick(x, "interviews"));
      if (!a) return "not-ready";
      const r = await clickStep(a, "interviews", frame, readyInterviewView);
      if (r !== "ok") return r;
      if (signedOut(frame)) throw SIGNED_OUT;
      return "ok"; // already sent once — don't re-send the same view
    });
    if (reenter !== "ok") return;
  }
}

async function interviewViews(frame, send, runStep, budget) {
  const done = new Set();
  for (;;) {
    const d = docOf(frame);
    if (!d) return;
    const row = interviewRows(d, done)[0];
    if (!row) return;
    const label = rowLabel(row);
    done.add(label);
    const anchor = qsa(row, "a").find((a) => allowedClick(a, "interviews"));
    if (!anchor) continue;
    const view = await runStep(viewStepName(label), async () => {
      const r = await clickStep(anchor, "interviews", frame, readyInterviewView);
      if (r !== "ok") return r;
      if (signedOut(frame)) throw SIGNED_OUT;
      send(frame);
      return "ok";
    });
    if (view !== "ok") return;
    // Each grid row's detail page (timeslot deadlines / booking details).
    await interviewDetails(frame, send, runStep, label, budget);
    // Back to the landing before the next view.
    const back = await runStep("interviews-landing", async () => {
      const nav = await navigate(frame, INTERVIEWS_URL, readyInterviewsLanding);
      if (nav !== "ok") return nav;
      if (signedOut(frame)) throw SIGNED_OUT;
      return "ok";
    });
    if (back !== "ok") return;
  }
}

async function applicationsPages(frame, send, runStep) {
  const d = docOf(frame);
  if (!d) return;
  const row = rows(d).find((r) => rowLabel(r) === "Total Submitted");
  const anchor = row
    ? qsa(row, "a").find((a) => allowedClick(a, "applications"))
    : null;
  if (!anchor) return;
  const first = await runStep("apps-page-1", async () => {
    const r = await clickStep(anchor, "applications", frame, readyAppsGrid);
    if (r !== "ok") return r;
    if (signedOut(frame)) throw SIGNED_OUT;
    send(frame);
    return "ok";
  });
  if (first !== "ok") return;
  let prevFirst = firstRowText(docOf(frame));
  for (let n = 2; n <= MAX_PAGE; n++) {
    const doc = docOf(frame);
    if (!doc) return;
    const link = qsa(doc, ".pagination__link").find(
      (el) => text(el) === String(n)
    );
    if (!link) return; // no more pages
    const ready = (page) => {
      const t = firstRowText(page);
      return Boolean(t) && t !== prevFirst;
    };
    const page = await runStep(`apps-page-${n}`, async () => {
      const r = await clickStep(link, "pagination", frame, ready);
      if (r !== "ok") return r;
      if (signedOut(frame)) throw SIGNED_OUT;
      send(frame);
      return "ok";
    });
    if (page !== "ok") return;
    prevFirst = firstRowText(docOf(frame));
  }
}

/** sessionStorage key for the privacy-safe per-round summary. */
const LAST_KEY = "wa1:ww-refresh-last";

/**
 * One refresh round: dashboard → interviews → applications in the hidden
 * iframe, each step bounded and sequential. A timed-out step is skipped;
 * a signed-out page aborts the round; the kill switch stops between steps.
 * The iframe is always removed, and a privacy-safe per-step summary
 * (names, durations, failure reasons — never URLs, tokens or page text)
 * is written to sessionStorage["wa1:ww-refresh-last"] on every exit path.
 * @returns {Promise<{sent: number, steps: any[]}>}
 */
export async function runRefreshRound() {
  let sent = 0;
  /** @type {{step: string, ok: boolean, ms: number, reason?: string}[]} */
  const steps = [];
  let killed = false;
  const send = (frame) => {
    if (sendFrame(frame)) sent += 1;
  };
  /** Run one named bounded step, record it, and honour the kill switch. */
  const runStep = async (name, fn) => {
    if (killed) return "killed";
    const t = Date.now();
    try {
      if (!(await refreshAllowed())) {
        killed = true;
        steps.push({ step: name, ok: false, ms: Date.now() - t, reason: "killed" });
        return "killed";
      }
      const out = await fn();
      steps.push(
        out === "ok"
          ? { step: name, ok: true, ms: Date.now() - t }
          : { step: name, ok: false, ms: Date.now() - t, reason: String(out) }
      );
      return out;
    } catch (e) {
      steps.push({
        step: name,
        ok: false,
        ms: Date.now() - t,
        reason: e === SIGNED_OUT ? "signed-out" : `error:${/** @type {any} */ (e)?.name || "Error"}`,
      });
      throw e;
    }
  };
  const frame = makeFrame(document);
  const budget = { used: 0 };
  try {
    try {
      document.body?.appendChild?.(frame);
    } catch {
      // still works — an unattached iframe can navigate
    }
    // 1. Dashboard — skipped when the open page already is it.
    if (!/\/myAccount\/dashboard\.htm/i.test(String(location.href))) {
      await runStep("dashboard", async () => {
        const nav = await navigate(frame, DASHBOARD_URL, readyDashboard);
        if (nav !== "ok") return nav;
        if (signedOut(frame)) throw SIGNED_OUT;
        send(frame);
        return "ok";
      });
    } else {
      steps.push({ step: "dashboard", ok: true, ms: 0, reason: "skipped" });
    }
    // 2. Interviews landing, then each nonzero Booked/Unscheduled view.
    const landing = await runStep("interviews-landing", async () => {
      const nav = await navigate(frame, INTERVIEWS_URL, readyInterviewsLanding);
      if (nav !== "ok") return nav;
      if (signedOut(frame)) throw SIGNED_OUT;
      return "ok";
    });
    if (landing === "ok") await interviewViews(frame, send, runStep, budget);
    // 3. Applications landing → Total view → paginate.
    const apps = await runStep("apps-landing", async () => {
      const nav = await navigate(frame, APPLICATIONS_URL, readyAppsLanding);
      if (nav !== "ok") return nav;
      if (signedOut(frame)) throw SIGNED_OUT;
      return "ok";
    });
    if (apps === "ok") await applicationsPages(frame, send, runStep);
    return { sent, steps };
  } catch (e) {
    if (e !== SIGNED_OUT) throw e;
    return { sent, steps };
  } finally {
    try {
      if (typeof frame.remove === "function") frame.remove();
      else frame.parentNode?.removeChild?.(frame);
    } catch {
      // a frame that never attached has nothing to remove
    }
    try {
      window.sessionStorage?.setItem?.(
        LAST_KEY,
        JSON.stringify({ at: new Date().toISOString(), sent, steps })
      );
    } catch {
      // summary is diagnostics only — never let it break the round
    }
  }
}

let running = false;

/**
 * Gate + start a refresh round, if due. Called by content.js after the
 * page's own settled snapshot. Fire-and-forget safe.
 * @returns {Promise<{sent: number, steps?: any[]}|undefined>|undefined}
 */
export function maybeRefresh() {
  try {
    if (running) return undefined;
    if (window.top !== window) return undefined;
    const href = String(location.href || "");
    if (!/^https:\/\/waterlooworks\.uwaterloo\.ca\/myAccount\//.test(href)) {
      return undefined;
    }
    if (/notLoggedIn\.htm/i.test(href)) return undefined;
    if (document.visibilityState !== "visible") return undefined;
    // Block re-entry across the async settings read too.
    running = true;
    return (async () => {
      try {
        // The kill switch is read before anything else — a disabled refresh
        // never even stamps the throttle timestamp.
        if (!(await refreshAllowed())) return { sent: 0 };
        const ss = window.sessionStorage;
        const last = Number(ss?.getItem?.(THROTTLE_KEY) || 0);
        if (Number.isFinite(last) && Date.now() - last < THROTTLE_MS) {
          return { sent: 0 };
        }
        ss?.setItem?.(THROTTLE_KEY, String(Date.now()));
        return await runRefreshRound();
      } finally {
        running = false;
      }
    })().catch(() => ({ sent: 0 }));
  } catch {
    return undefined;
  }
}
