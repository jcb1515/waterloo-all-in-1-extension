// @ts-check
/*
  Temporary panel — Phase 1 part A shim only (part B replaces the whole UI).
  Renders the merged canonical `items` from chrome.storage.local as a dated
  list: check-off writes userState via wa1:set-user-state, a row opens its url
  via wa1:open, refresh triggers wa1:sync.
*/

import { esc, icon, brandMark, CATEGORY_ICON } from "../ui/icons.js";
import { fmtDate, fmtTime } from "../core/dates.js";
import { UI } from "../core/messages.js";

const bar = /** @type {HTMLElement} */ (document.getElementById("bar"));
const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const announce = document.getElementById("announce");

/** @type {Record<string, any>} */
let items = {};
/** @type {Record<string, any>} */
let userState = {};

const send = (/** @type {any} */ msg) =>
  chrome.runtime.sendMessage(msg).catch(() => null);

const anchor = (/** @type {any} */ i) => i.dueAt || i.startAt;

function say(text) {
  if (announce) announce.textContent = text;
}

/* ------------------------------ render ------------------------------ */

const DAY_MS = 86400000;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/** Group label for an anchor timestamp. */
function bucket(t) {
  const today = startOfDay(Date.now());
  if (t < today) return "overdue";
  if (t < today + DAY_MS) return "today";
  if (t < today + 2 * DAY_MS) return "tomorrow";
  return "later";
}

const GROUP_LABEL = { overdue: "Earlier", today: "Today", tomorrow: "Tomorrow", later: "Later" };

function whenText(it) {
  if (it.dueAt) return { top: "due", time: fmtTime(it.dueAt), date: fmtDate(it.dueAt) };
  if (it.allDay) return { top: "", time: "all day", date: fmtDate(it.startAt) };
  return { top: "", time: fmtTime(it.startAt), date: fmtDate(it.startAt) };
}

function render() {
  const now = Date.now();
  const visible = Object.values(items)
    .filter((i) => anchor(i) && !(userState[i.id] && userState[i.id].hidden))
    .sort((a, b) => Date.parse(anchor(a)) - Date.parse(anchor(b)) || String(a.title).localeCompare(String(b.title)));

  /** @type {Record<string, any[]>} */
  const groups = { overdue: [], today: [], tomorrow: [], later: [] };
  for (const it of visible) groups[bucket(Date.parse(anchor(it)))].push(it);

  let body = "";
  for (const key of ["overdue", "today", "tomorrow", "later"]) {
    const list = groups[key];
    if (!list.length) continue;
    body += `<section class="group" data-group="${key}">
      <div class="group-head"><h2 class="gh-title">${GROUP_LABEL[key]}</h2><span class="gh-sub">${list.length}</span></div>
      <ul class="rows">`;
    for (const it of list) {
      const done = it.status === "done";
      const w = whenText(it);
      const late = Date.parse(anchor(it)) < now && it.status === "open";
      body += `<li class="row${it.status === "submitted" ? " tone-submitted" : ""}">
        <button class="check" data-check="${esc(it.id)}" aria-pressed="${done}" title="${done ? "Reopen" : "Mark done"}"><span class="check-ring">${icon("check", 16, "check-mark")}</span></button>
        <button class="row-open" data-id="${esc(it.id)}">
          <span class="row-main">
            <span class="meta">
              <span class="type">${icon(CATEGORY_ICON[it.category] || "doc", 14)} ${esc(it.type)}</span>
              ${it.org ? `<span class="chip">${esc(it.org)}</span>` : ""}
              ${it.review === "pending" ? `<span class="chip">needs a look</span>` : ""}
            </span>
            <span class="title">${esc(it.title)}</span>
            ${it.moved ? `<span class="meta"><span class="type">${icon("alert", 14)} moved</span></span>` : ""}
          </span>
          <span class="due"><span class="due-top">${w.top ? `${esc(w.top)} ` : ""}<span class="due-time${late ? " is-odd" : ""}">${esc(w.time)}</span></span><span class="due-bottom">${esc(w.date)}</span></span>
        </button>
      </li>`;
    }
    body += `</ul></section>`;
  }
  app.innerHTML = body
    ? `<div class="groups">${body}</div>`
    : `<div class="empty">${icon("checklist", 30)}<h2>Nothing on the radar</h2><p>Sign in to a Waterloo site and hit Refresh — deadlines show up here.</p><button class="btn btn-quiet btn-sm" id="sync-empty">Check now</button></div>`;
}

/* ------------------------------ actions ------------------------------ */

let syncing = false;
async function syncNow() {
  if (syncing) return;
  syncing = true;
  say("Syncing");
  try {
    await send({ type: UI.SYNC });
  } finally {
    syncing = false;
    await load();
  }
}

bar.innerHTML = `${brandMark(20)}<div class="spacer"></div>`;
const refreshBtn = document.createElement("button");
refreshBtn.className = "btn btn-quiet btn-sm";
refreshBtn.id = "refresh";
refreshBtn.innerHTML = `${icon("refresh", 15)} Refresh`;
const settingsBtn = document.createElement("button");
settingsBtn.className = "icon-btn";
settingsBtn.title = "Settings";
settingsBtn.setAttribute("aria-label", "Settings");
settingsBtn.innerHTML = icon("sliders", 18);
bar.append(refreshBtn, settingsBtn);

refreshBtn.addEventListener("click", syncNow);
settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

app.addEventListener("click", (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (!target || !target.closest) return;
  if (target.closest("#sync-empty")) {
    syncNow();
    return;
  }
  const check = /** @type {HTMLElement | null} */ (target.closest("[data-check]"));
  if (check) {
    const id = check.getAttribute("data-check") || "";
    const it = items[id];
    if (!it) return;
    const done = it.status === "done";
    send({ type: UI.SET_USER_STATE, id, patch: { done: !done, doneAt: !done ? new Date().toISOString() : null } }).then(load);
    say(done ? "Reopened" : "Marked done");
    return;
  }
  const row = /** @type {HTMLElement | null} */ (target.closest(".row-open[data-id]"));
  if (row) {
    const it = items[row.getAttribute("data-id") || ""];
    if (it && it.url) send({ type: UI.OPEN, url: it.url });
  }
});

/* ------------------------------ load ------------------------------ */

async function load() {
  try {
    const all = await chrome.storage.local.get(["items", "userState"]);
    items = all.items && typeof all.items === "object" ? all.items : {};
    userState = all.userState && typeof all.userState === "object" ? all.userState : {};
  } catch {
    items = {};
    userState = {};
  }
  render();
}

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.items || changes.userState)) load();
  });
} catch {
  /* ignore */
}

load();
