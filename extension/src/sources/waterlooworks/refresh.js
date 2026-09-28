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

import { isLoggedOut } from "./parsers.js";

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
      if (
        /^on/i.test(name) ||
        (name.toLowerCase() === "href" &&
          /^\s*javascript\s*:/i.test(value))
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
 * @param {"interviews"|"applications"|"pagination"} step
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
    const label = text(row?.cells?.[0] ?? row?.querySelector?.("td"));
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

/** Clicks only elements allowedClick accepts; returns whether it clicked. */
function clickAllowed(el, step) {
  if (!allowedClick(el, step)) return false;
  try {
    el.click();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// round orchestration

const signedOut = (frame) => {
  try {
    const href = hrefOf(frame);
    if (/notLoggedIn\.htm/i.test(href)) return true;
    const d = docOf(frame);
    return d ? isLoggedOut(d, href) : false;
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
      if (d && ready(d)) return true;
    } catch {
      // document mid-navigation — keep polling
    }
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/** src navigation: wait for the load event, then poll until ready. */
async function navigate(frame, url, ready) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  const loaded = waitForLoad(frame, STEP_TIMEOUT_MS);
  try {
    frame.src = url;
  } catch {
    return false;
  }
  if (!(await loaded)) return false;
  return pollReady(frame, ready, deadline);
}

/** Click navigation: poll until ready (grid steps may not raise a load). */
async function clickStep(el, step, frame, ready) {
  if (!clickAllowed(el, step)) return false;
  return pollReady(frame, ready, Date.now() + STEP_TIMEOUT_MS);
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

const readyInterviewsLanding = (d) =>
  rows(d).some(
    (r) => text(firstCell(r)) === INTERVIEW_LABELS.booked
  );

const readyInterviewView = (d) => {
  for (const th of qsa(d, "th")) {
    if (/interview date/i.test(text(th))) return true;
  }
  return /no data to display/i.test(docText(d));
};

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
    const label = text(firstCell(r));
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

async function interviewViews(frame, send) {
  const done = new Set();
  for (;;) {
    const d = docOf(frame);
    if (!d) return;
    const row = interviewRows(d, done)[0];
    if (!row) return;
    done.add(text(firstCell(row)));
    const anchor = qsa(row, "a").find((a) => allowedClick(a, "interviews"));
    if (!anchor) continue;
    if (!(await clickStep(anchor, "interviews", frame, readyInterviewView))) {
      return;
    }
    if (signedOut(frame)) return;
    send(frame);
    // Back to the landing before the next view.
    if (!(await navigate(frame, INTERVIEWS_URL, readyInterviewsLanding))) {
      return;
    }
    if (signedOut(frame)) return;
  }
}

async function applicationsPages(frame, send) {
  const d = docOf(frame);
  if (!d) return;
  const row = rows(d).find((r) => text(firstCell(r)) === "Total Submitted");
  const anchor = row
    ? qsa(row, "a").find((a) => allowedClick(a, "applications"))
    : null;
  if (!anchor) return;
  if (!(await clickStep(anchor, "applications", frame, readyAppsGrid))) return;
  if (signedOut(frame)) return;
  send(frame);
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
    if (!(await clickStep(link, "pagination", frame, ready))) return;
    if (signedOut(frame)) return;
    send(frame);
    prevFirst = firstRowText(docOf(frame));
  }
}

/**
 * One refresh round: dashboard → interviews → applications in the hidden
 * iframe, each step bounded and sequential. A timed-out step is skipped;
 * a signed-out page aborts the round. The iframe is always removed.
 * @returns {Promise<{sent: number}>}
 */
export async function runRefreshRound() {
  let sent = 0;
  const send = (frame) => {
    if (sendFrame(frame)) sent += 1;
  };
  const frame = makeFrame(document);
  try {
    try {
      document.body?.appendChild?.(frame);
    } catch {
      // still works — an unattached iframe can navigate
    }
    // 1. Dashboard — skipped when the open page already is it.
    if (!/\/myAccount\/dashboard\.htm/i.test(String(location.href))) {
      if (await navigate(frame, DASHBOARD_URL, readyDashboard)) {
        if (signedOut(frame)) return { sent };
        send(frame);
      }
    }
    // 2. Interviews landing, then each nonzero Booked/Unscheduled view.
    if (await navigate(frame, INTERVIEWS_URL, readyInterviewsLanding)) {
      if (signedOut(frame)) return { sent };
      await interviewViews(frame, send);
      if (signedOut(frame)) return { sent };
    }
    // 3. Applications landing → Total view → paginate.
    if (await navigate(frame, APPLICATIONS_URL, readyAppsLanding)) {
      if (signedOut(frame)) return { sent };
      await applicationsPages(frame, send);
    }
    return { sent };
  } catch (e) {
    if (e === SIGNED_OUT) return { sent };
    throw e;
  } finally {
    try {
      if (typeof frame.remove === "function") frame.remove();
      else frame.parentNode?.removeChild?.(frame);
    } catch {
      // a frame that never attached has nothing to remove
    }
  }
}

let running = false;

/**
 * Gate + start a refresh round, if due. Called by content.js after the
 * page's own settled snapshot. Fire-and-forget safe.
 * @returns {Promise<{sent: number}|undefined>|undefined}
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
    const ss = window.sessionStorage;
    const last = Number(ss?.getItem?.(THROTTLE_KEY) || 0);
    if (Number.isFinite(last) && Date.now() - last < THROTTLE_MS) {
      return undefined;
    }
    ss?.setItem?.(THROTTLE_KEY, String(Date.now()));
    running = true;
    return runRefreshRound()
      .catch(() => ({ sent: 0 }))
      .finally(() => {
        running = false;
      });
  } catch {
    return undefined;
  }
}
