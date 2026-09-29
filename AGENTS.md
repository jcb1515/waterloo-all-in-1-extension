# AGENTS.md — Waterloo All-in-1

Chrome/Edge MV3 extension that finds every dated thing in a UW student's life (Learn, outlines, Portal,
WaterlooWorks, Discord, Outlook, Gmail) and publishes it to one Google Calendar subscription with no duplicates.

- Shared contract: `extension/src/core/contract.js` (frozen; coordinate before changing it).
- An optional local design plan `PLAN.md` may live next to the repo root (outside git). Treat it as
  read-only context if present.
- Based on gurshh `uwlearn_assignment_extension` (MIT, history merged at 363054e). Keep its attribution (`licenses/`).

## Commands
- `npm ci` (once per checkout)
- `npm run build`: esbuild bundles `extension/` into `dist/` (load `dist/` unpacked in Edge/Chrome)
- `npm run dev`: rebuild on change
- `npm test`: `node --test` over `test/**/*.test.js`, plus the server tests in `server/`
- `npm run typecheck`: `tsc --noEmit`. Files opt in with `// @ts-check`; all new files should opt in.
- `npm run package`: release build into `dist/` + a verified zip in `release/`. Release builds set `WA1_RELEASE=1`, which ignores `dev-profile.json` (personal defaults must never ship), minifies, and must pass the dist checks (no dev-profile strings, no upstream names outside `licenses/`, no localhost feed URL). Rebuild a dev `dist/` afterwards.
- Load in Edge: `edge://extensions` → Developer mode → Load unpacked → `<root>/dist`. After a rebuild: Reload the card, then refresh site tabs.

## File ownership (parallel work)

When several agents work in parallel on separate streams, these ownership
boundaries keep merges clean. In a single-stream checkout they are simply
the module map.

| Stream | Owns |
|---|---|
| core | `extension/manifest.json`, `package.json`, `tools/build.mjs`, `tsconfig.json`, `extension/src/core/**`, `src/capture/**`, `src/calendar/**`, `src/background/**`, `src/panel/**`, `src/options/**`, `src/ui/**`, `extension/styles/**`, `AGENTS.md` |
| academic | `extension/src/sources/{learn,outline,portal,email}/**`, `extension/src/lib/textdates/**`, matching `test/` and `test/fixtures/` |
| co-op | `server/**`, `extension/src/sources/{waterlooworks,discord}/**`, matching `test/` and `test/fixtures/` |

`legacy/` is read-only reference (the original gurshh files).

## Collaboration rules
1. Edit only files you own. For anything else, leave a note for the owning stream.
2. Before writing a helper or parser, check it doesn't already exist: `git log --oneline -20` and `git grep -n "<name>"` on the relevant branches.
3. Commit small and often. Never push, force, reset or rebase shared history. Never delete files you didn't create.
4. Adapters return data (`SyncResult`) and never write `chrome.storage`. Only the core stores, merges, assigns calendar uids and publishes.
5. Discord is passive only: no requests to Discord, no token access, no automatic navigation.
6. Fixtures in git are redacted (no names, emails, student numbers, message bodies, tokens). Raw captures stay outside git (`captures/` is gitignored).
7. Personal defaults live in the gitignored `dev-profile.json` (see `dev-profile.example.json`); tracked `DEFAULT_SETTINGS` stays blank.
8. Dependencies: pin to exact versions published at least 7 days earlier.

## Layout
```
extension/
  manifest.json  _locales/  icons/  styles/
  src/background/     service worker entry (scheduler, sync dispatch)
  src/core/           contract, store, merge, scheduler, uid map
  src/capture/        observer.main.js (page world), recorder.content.js, discovery store, relay, offscreen
  src/calendar/       feed publish client, ics download
  src/sources/<id>/   index.js (Adapter), parsers.js, content.js (site content script)
  src/lib/textdates/  shared date extraction
  src/panel/  src/options/  src/ui/
server/               Cloudflare Worker calendar feed (from gurshh calendar-service)
legacy/gurshh/        original gurshh extension files (reference)
licenses/             upstream licenses
test/  tools/
```
