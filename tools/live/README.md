# tools/live — DevTools console for the debug Edge

`cdp.mjs` talks to the user's Edge over the DevTools protocol to debug the
extension against real pages: "does the tab see what the parser expects?",
"is storage actually updating?" — and to open the checklist pages the
extension needs visited.

## Setup

Since Chromium 136, Edge ignores `--remote-debugging-port` on the default
profile — it must run on a dedicated profile:

1. Start a dedicated profile (no need to close normal Edge):

   ```powershell
   & "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\wa1-edge-debug"
   ```

2. First run only: load the unpacked `dist/` in that profile and sign in to
   each site (logins persist in that folder).
3. Verify with `curl.exe http://127.0.0.1:9222/json/version`.

If the port isn't reachable, every command exits with a pointer back here.
`WA1_CDP` overrides the endpoint (default `http://127.0.0.1:9222`).

## Rules — navigation allowed, no actions

- **Allowed:** `open` creates a **new tab** for allowlisted pages only —
  every `url` on a `sources/probes.js` CHECKLIST row plus each adapter's
  home page (`origins[0]/`). The allowlist is built at runtime, and the
  tab always gets the clean allowlisted URL, never a typed query string.
  `close` and `scroll` only act on tabs the tool opened itself (recorded
  in `captures/live/.opened.json`).
- **Forbidden:** clicks, typing, form submits, any DevTools input event,
  navigating or closing the user's own tabs, and **anything on
  discord.com** — no open, no scroll; the user opens Discord pages. If a
  page isn't on the allowlist, ask the user to open it, or add its `url`
  to a CHECKLIST row first.
- A GET-only `fetch` from the page context is allowed for the feasibility
  checks in w1.md "v2 additions" section 4.
- One tab at a time for `dump`/`probe` reads.
- Dumps land in `captures/live/` which is gitignored. Captures contain real
  personal data: **never commit them, never paste bodies, names or addresses
  into chat or coordination files.** Evidence notes go in
  `captures/live/<source>-evidence.md` with redacted excerpts only.

## Commands

```sh
npm run live -- tabs                        # every page target: id, host, path
npm run live -- open portal:portal-open     # new tab -> https://portal.uwaterloo.ca/
npm run live -- open waterlooworks:interviews
npm run live -- open learn:home             # each adapter's home page
npm run live -- scroll <targetId> 2000      # window.scrollBy, tool-opened tabs only
npm run live -- close <targetId>            # only ids from .opened.json
npm run live -- close all-mine              # close every tab this tool opened
npm run live -- dump waterlooworks          # save tab HTML -> captures/live/<host>-<ts>.html
npm run live -- dump discord --name wato    # custom filename
npm run live -- probe discord               # dump + run the source's probe.js and
                                            # observe.parse offline; prints counts
npm run live -- storage                     # all storage keys + sizes + sourceState
npm run live -- storage items --source discord
npm run live -- storage sourceState         # per-source status/lastOk/lastRun/errors
npm run live -- watch --source waterlooworks --secs 120
```

`open` resolves its argument against the runtime allowlist and prints the
new tab's id, host+path and ready state. `scroll` defaults to 1200 px and
clamps to 1–20000. `close all-mine` also prunes `.opened.json` entries
whose tabs no longer exist.

`probe` picks the source from the tab's host (`SITE_BY_HOST`), runs its
`probe.js` for structural counts, then runs the same DOM-extract +
`observe.parse` recipe the verify drivers use, and prints item counts by type
plus up to five `type | Toronto date+time | title` rows. Learn and Portal are
passive API sources — they have no DOM extract, so `probe` reports that.

`storage`/`watch` locate the extension's own service worker: for each
`chrome-extension://` service-worker target the tool opens its websocket and
evaluates `chrome.runtime.getManifest().name`, keeping the ones that answer
`Waterloo All-in-1`. If several copies match (two unpacked `dist/` builds can
be loaded side by side), the command lists them and exits — pick one with
`--ext <id>` or the `WA1_EXT_ID` environment variable:

```sh
npm run live -- storage --ext maihpiennplbbcopdcklaobaoipbejjb
set WA1_EXT_ID=maihpiennplbbcopdcklaobaoipbejjb && npm run live -- watch
```

Nothing about the user's own tabs is ever touched.
