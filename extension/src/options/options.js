// @ts-check
/*
  Options page. Phase 1 part A keeps it minimal: a theme choice (applied to
  the whole extension), then the Discovery recorder section — the controls
  the windows use while exploring sites. The richer settings UI arrives with
  part B.
*/

import { getSettings, setSettings } from "../core/store.js";
import { brandMark, esc } from "../ui/icons.js";
import { fmtAgo } from "../core/dates.js";
import { replaceRedactWords } from "../capture/redact.js";

const page = /** @type {HTMLElement} */ (document.getElementById("page"));

/** theme: "system" follows the OS; "light"/"dark" pin a look. */
function applyTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

/* ------------------------------------------------------------------ */
/* Discovery recorder                                                  */
/* ------------------------------------------------------------------ */

const DISCOVERY_SITES = [
  { id: "learn", label: "Learn" },
  { id: "outline", label: "Course outlines" },
  { id: "portal", label: "Portal" },
  { id: "waterlooworks", label: "WaterlooWorks" },
  { id: "discord", label: "Discord" },
  { id: "outlook", label: "Outlook" },
  { id: "gmail", label: "Gmail" },
];

async function getDiscoverySettings() {
  const { discoverySettings } = await chrome.storage.local.get("discoverySettings");
  const s = /** @type {any} */ (discoverySettings && typeof discoverySettings === "object" ? discoverySettings : {});
  return { enabled: s.enabled !== false, redactWords: Array.isArray(s.redactWords) ? s.redactWords : [] };
}

async function setDiscoverySettings(patch) {
  const cur = await getDiscoverySettings();
  await chrome.storage.local.set({ discoverySettings: { ...cur, ...patch } });
}

/** @param {{id:string, label:string}} site @param {any} d */
function discoRowHTML(site, d) {
  const net = d && d.net ? Object.keys(d.net).length : 0;
  const pages = d && d.pages ? Object.keys(d.pages).length : 0;
  const updated = d && d.updatedAt ? fmtAgo(d.updatedAt, new Date()) : "—";
  const off = d ? "" : "disabled";
  return `<tr data-disco-row="${site.id}">
    <td>${esc(site.label)}</td>
    <td class="num" data-disco-net>${net}</td>
    <td class="num" data-disco-pages>${pages}</td>
    <td data-disco-updated>${esc(updated)}</td>
    <td class="disco-actions">
      <button class="btn btn-quiet btn-sm" data-disco-dl="${site.id}" ${off}>Download discovery report</button>
      <button class="btn btn-quiet btn-sm" data-disco-clear="${site.id}" ${off}>Clear</button>
    </td>
  </tr>`;
}

/** @param {string} siteId @param {any} d */
function updateDiscoRow(siteId, d) {
  const tr = page.querySelector(`tr[data-disco-row="${siteId}"]`);
  if (!tr) return;
  /** @type {HTMLElement} */ (tr.querySelector("[data-disco-net]")).textContent = String(d && d.net ? Object.keys(d.net).length : 0);
  /** @type {HTMLElement} */ (tr.querySelector("[data-disco-pages]")).textContent = String(d && d.pages ? Object.keys(d.pages).length : 0);
  /** @type {HTMLElement} */ (tr.querySelector("[data-disco-updated]")).textContent = d && d.updatedAt ? fmtAgo(d.updatedAt, new Date()) : "—";
  for (const b of tr.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (b).disabled = !d;
}

async function downloadDiscovery(siteId) {
  const key = `discovery:${siteId}`;
  const data = /** @type {any} */ ((await chrome.storage.local.get(key))[key]);
  const { redactWords } = await getDiscoverySettings();
  const report = {
    kind: "wa1-discovery",
    version: 1,
    site: siteId,
    generatedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    browser: (/** @type {any} */ (navigator).userAgentData && /** @type {any} */ (navigator).userAgentData.brands) || null,
    net: data ? Object.values(data.net || {}) : [],
    pages: data ? Object.values(data.pages || {}) : [],
  };
  // Redact words can be added after captures; apply them to the whole report now.
  const text = replaceRedactWords(JSON.stringify(report, null, 2), redactWords);
  const day = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${siteId}-discovery-${day}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ------------------------------------------------------------------ */

async function render() {
  const settings = await getSettings();
  applyTheme(settings.theme);
  document.title = "Waterloo All-in-1 — Settings";
  const disco = await getDiscoverySettings();
  const discoData = /** @type {Record<string, any>} */ (await chrome.storage.local.get(DISCOVERY_SITES.map((s) => `discovery:${s.id}`)));

  page.innerHTML = `
    <header class="page-head">
      <span class="mark-tile">${brandMark(40)}</span>
      <div>
        <h1>Settings</h1>
      </div>
    </header>

    <div class="sheet">
      <section class="set-section" aria-labelledby="look-h">
        <h2 id="look-h">Look</h2>
        <div class="radio-list" role="radiogroup" aria-labelledby="look-h">
          <label class="radio"><input type="radio" name="theme" value="system" ${settings.theme === "system" ? "checked" : ""}><span><strong>Match my computer</strong></span></label>
          <label class="radio"><input type="radio" name="theme" value="light" ${settings.theme === "light" ? "checked" : ""}><span><strong>Light</strong></span></label>
          <label class="radio"><input type="radio" name="theme" value="dark" ${settings.theme === "dark" ? "checked" : ""}><span><strong>Dark</strong></span></label>
        </div>
      </section>
    </div>

    <div class="sheet">
      <section class="set-section" aria-labelledby="disco-h">
        <h2 id="disco-h">Discovery</h2>
        <p class="set-help">While you browse these sites, the extension records their structure — which URLs load, what shape the JSON answers have, and the page's landmarks — with names, emails and ids removed. Download a report for each site and send it to the developer so the extension can learn where everything lives. Nothing is sent anywhere automatically.</p>
        <label class="disco-toggle"><input type="checkbox" id="disco-enabled" ${disco.enabled ? "checked" : ""}> <strong>Record site structure (discovery)</strong></label>
        <label class="field-label" for="disco-words">Words to redact (one per line, e.g. your name)</label>
        <textarea class="input" id="disco-words" rows="3" spellcheck="false">${esc(disco.redactWords.join("\n"))}</textarea>
        <table class="disco-table">
          <thead><tr><th>Site</th><th class="num">Requests</th><th class="num">Pages</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            ${DISCOVERY_SITES.map((s) => discoRowHTML(s, discoData[`discovery:${s.id}`])).join("")}
          </tbody>
        </table>
      </section>
    </div>

    <p class="page-foot">Not affiliated with D2L or the University of Waterloo.</p>`;
}

page.addEventListener("click", async (e) => {
  const target = /** @type {HTMLElement | null} */ (e.target);
  const t = target && /** @type {HTMLButtonElement} */ (target.closest("[data-disco-dl], [data-disco-clear]"));
  if (!t) return;
  if (t.dataset.discoDl) {
    t.disabled = true;
    await downloadDiscovery(t.dataset.discoDl).catch(() => {});
    t.disabled = false;
    return;
  }
  if (t.dataset.discoClear) {
    await chrome.storage.local.remove(`discovery:${t.dataset.discoClear}`);
    updateDiscoRow(t.dataset.discoClear, null);
  }
});

page.addEventListener("change", async (e) => {
  const t = /** @type {HTMLInputElement} */ (e.target);
  if (!t || !t.matches) return;
  if (t.matches('input[name="theme"]')) {
    const theme = t.value === "light" || t.value === "dark" ? t.value : "system";
    applyTheme(theme);
    await setSettings({ theme });
    return;
  }
  if (t.matches("#disco-enabled")) {
    await setDiscoverySettings({ enabled: t.checked });
    return;
  }
  if (t.matches("#disco-words")) {
    await setDiscoverySettings({ redactWords: t.value.split("\n").map((w) => w.trim()).filter(Boolean) });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const theme = /** @type {any} */ (changes.wa1Settings && changes.wa1Settings.newValue);
  if (theme) applyTheme(theme.theme);
  for (const s of DISCOVERY_SITES) {
    const ch = changes[`discovery:${s.id}`];
    if (ch) updateDiscoRow(s.id, ch.newValue);
  }
});

render();
