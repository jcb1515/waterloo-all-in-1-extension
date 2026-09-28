// Privacy & discovery: the recorder controls, per-site discovery table with
// Download/Clear, and the delete-everything danger zone.

import { useEffect, useRef, useState } from "preact/hooks";
import { Card, Field, Toggle } from "../bits.jsx";
import { IS_PREVIEW } from "../../panel/data.js";
import { previewState } from "../../panel/preview-fixtures.js";
import { replaceRedactWords } from "../../capture/redact.js";
import { enqueue, getLocal, mutateKey } from "../../core/store.js";
import { fmtAgo } from "../../panel/model/agenda.js";
import { AlertTriangleIcon } from "../../ui/icons.jsx";

const DISCOVERY_SITES = [
  { id: "learn", label: "Learn" },
  { id: "outline", label: "Course outlines" },
  { id: "portal", label: "Portal" },
  { id: "waterlooworks", label: "WaterlooWorks" },
  { id: "discord", label: "Discord" },
  { id: "outlook", label: "Outlook" },
  { id: "gmail", label: "Gmail" },
];

const discoDefaults = { enabled: true, redactWords: [] };

async function readDiscoverySettings() {
  if (IS_PREVIEW) return { ...discoDefaults, redactWords: [] };
  const s = await getLocal("discoverySettings");
  const o = s && typeof s === "object" ? s : {};
  return {
    enabled: o.enabled !== false,
    redactWords: Array.isArray(o.redactWords) ? o.redactWords : [],
  };
}

async function writeDiscoverySettings(patch) {
  if (IS_PREVIEW) return;
  await mutateKey("discoverySettings", (cur) => ({
    ...(cur && typeof cur === "object" ? cur : {}),
    ...patch,
  }));
}

async function readDiscoveryData() {
  if (IS_PREVIEW) return previewState(new Date()).discovery;
  /** @type {Record<string, any>} */
  const out = {};
  for (const s of DISCOVERY_SITES) {
    const v = await getLocal(`discovery:${s.id}`);
    if (v) out[s.id] = v;
  }
  return out;
}

async function downloadDiscovery(siteId, redactWords) {
  const data = IS_PREVIEW
    ? previewState(new Date()).discovery[siteId]
    : await getLocal(`discovery:${siteId}`);
  const version = IS_PREVIEW ? "preview" : chrome.runtime.getManifest().version;
  const report = {
    kind: "wa1-discovery",
    version: 1,
    site: siteId,
    generatedAt: new Date().toISOString(),
    extensionVersion: version,
    net: data ? Object.values(data.net || {}) : [],
    pages: data ? Object.values(data.pages || {}) : [],
  };
  const text = replaceRedactWords(JSON.stringify(report, null, 2), redactWords);
  const day = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${siteId}-discovery-${day}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * @param {{now: Date}} p
 */
export function PrivacySection({ now }) {
  const [disco, setDisco] = useState(discoDefaults);
  const [data, setData] = useState(/** @type {Record<string, any>} */ ({}));
  const [words, setWords] = useState("");
  const [confirming, setConfirming] = useState(false);
  const debounce = useRef(/** @type {any} */ (null));

  const load = () => readDiscoveryData().then(setData).catch(() => {});

  useEffect(() => {
    readDiscoverySettings().then((s) => {
      setDisco(s);
      setWords(s.redactWords.join("\n"));
    });
    load();
    if (IS_PREVIEW) return;
    const onChange = (changes, area) => {
      if (area !== "local") return;
      if (Object.keys(changes).some((k) => k.startsWith("discovery"))) load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const saveWords = (raw) => {
    const list = raw.split("\n").map((w) => w.trim()).filter(Boolean);
    writeDiscoverySettings({ redactWords: list });
  };

  const clearSite = async (id) => {
    if (IS_PREVIEW) {
      setData((d) => {
        const n = { ...d };
        delete n[id];
        return n;
      });
      return;
    }
    await enqueue(() => chrome.storage.local.remove(`discovery:${id}`));
    load();
  };

  const deleteEverything = async () => {
    if (!IS_PREVIEW) {
      // clear() isn't covered by the store helpers — enqueue it so a
      // pending write can't resurrect a key the user just wiped.
      await enqueue(() => chrome.storage.local.clear());
      location.reload();
    }
    setConfirming(false);
  };

  return (
    <div class="opt-stack">
      <Card title="Discovery recorder">
        <p class="help">
          While you browse these sites, the extension records their structure — which URLs load,
          what shape the JSON answers have, and the page's landmarks — with names, emails and ids
          removed. Download a report for a site and send it to the developer so the extension can
          learn where everything lives. Nothing is sent anywhere automatically.
        </p>
        <Toggle
          label="Record site structure (discovery)"
          checked={disco.enabled}
          onChange={(v) => {
            setDisco((d) => ({ ...d, enabled: v }));
            writeDiscoverySettings({ enabled: v });
          }}
        />
        <Field label="Words to always redact" help="One per line — names, emails, student numbers. Applied inside URLs and text.">
          <textarea
            class="textarea"
            value={words}
            placeholder={"Jane Doe\njdoe@uwaterloo.ca\n20123456"}
            onInput={(e) => {
              const v = /** @type {any} */ (e.target).value;
              setWords(v);
              if (debounce.current) clearTimeout(debounce.current);
              debounce.current = setTimeout(() => saveWords(v), 600);
            }}
          />
        </Field>
      </Card>

      <Card title="Recorded sites">
        <table class="edit-table disco-table">
          <thead>
            <tr>
              <th>Site</th>
              <th class="num">Requests</th>
              <th class="num">Pages</th>
              <th>Updated</th>
              <th class="row-act" />
            </tr>
          </thead>
          <tbody>
            {DISCOVERY_SITES.map((s) => {
              const d = data[s.id];
              const net = d && d.net ? Object.keys(d.net).length : 0;
              const pages = d && d.pages ? Object.keys(d.pages).length : 0;
              return (
                <tr key={s.id}>
                  <td>{s.label}</td>
                  <td class="num tabular">{net}</td>
                  <td class="num tabular">{pages}</td>
                  <td class="tabular">{d && d.updatedAt ? fmtAgo(d.updatedAt, now) : "—"}</td>
                  <td class="row-act">
                    <button
                      type="button"
                      class="btn btn-sm"
                      disabled={!d}
                      onClick={() => downloadDiscovery(s.id, disco.redactWords)}
                    >
                      Download
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-ghost"
                      disabled={!d}
                      onClick={() => clearSite(s.id)}
                    >
                      Clear
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title="Danger zone" danger>
        <div class="danger-row">
          <div>
            <strong>Delete all extension data</strong>
            <p class="help">Items, settings, source data, discovery records — everything on this computer.</p>
          </div>
          {confirming ? (
            <span class="danger-confirm">
              <button type="button" class="btn btn-danger" onClick={deleteEverything}>
                Yes, delete everything
              </button>
              <button type="button" class="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" class="btn btn-danger" onClick={() => setConfirming(true)}>
              <AlertTriangleIcon size={14} /> Delete all extension data
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}
