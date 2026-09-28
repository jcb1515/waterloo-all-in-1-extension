# tools/live — read-only DevTools console

`cdp.mjs` talks to the user's Edge over the DevTools protocol to debug the
extension against real pages: "does the tab see what the parser expects?" and
"is storage actually updating?"

## Setup

Remote debugging must be enabled once per Edge session:

1. Close **every** Edge window (check the tray too) — the flag only applies to a
   fresh process.
2. Start Edge with the debug port:

   ```powershell
   & "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
   ```

3. Reload the unpacked extension (`edge://extensions`) if it was rebuilt.

If the port isn't reachable, every command exits with a pointer back here.
`WA1_CDP` overrides the endpoint (default `http://127.0.0.1:9222`).

## Rules — READ-ONLY, no exceptions

- **No `Input.*`, no `Page.navigate`, no clicks, no scroll, no typing.**
- **Never close tabs.** One tab at a time.
- **Never automate Discord** — reads only, same as its content scripts.
- The only page-side call is a side-effect-free `Runtime.evaluate`
  (`document.documentElement.outerHTML`, or `chrome.storage.local.get` in the
  extension service worker).
- Dumps land in `captures/live/` which is gitignored. Captures contain real
  personal data: **never commit them, never paste bodies, names or addresses
  into chat or coordination files.** Evidence notes go in
  `captures/live/<source>-evidence.md` with redacted excerpts only.

## Commands

```sh
npm run live -- tabs                        # every page target: id, host, path
npm run live -- dump waterlooworks          # save tab HTML -> captures/live/<host>-<ts>.html
npm run live -- dump discord --name wato    # custom filename
npm run live -- probe discord               # dump + run the source's probe.js and
                                            # observe.parse offline; prints counts
npm run live -- storage                     # all storage keys + sizes + sourceState
npm run live -- storage items --source discord
npm run live -- storage sourceState         # per-source status/lastOk/lastRun/errors
npm run live -- watch --source waterlooworks --secs 120
```

`probe` picks the source from the tab's host (`SITE_BY_HOST`), runs its
`probe.js` for structural counts, then runs the same DOM-extract +
`observe.parse` recipe the verify drivers use, and prints item counts by type
plus up to five `type | Toronto date+time | title` rows. Learn and Portal are
passive API sources — they have no DOM extract, so `probe` reports that.

`storage`/`watch` locate the extension's own service worker (a
`chrome-extension://` target whose manifest name is `Waterloo All-in-1`) and
read `chrome.storage.local`. Nothing is ever written.
