# AGENTS.md — Waterloo All-in-1

Chrome/Edge MV3 extension that finds every dated thing in a UW student's life (Learn, outlines, Portal,
WaterlooWorks, Discord, Outlook, Gmail) and publishes it to one Google Calendar subscription with no duplicates.

- Canonical plan: `C:\Users\james\Downloads\waterloo extension guru\PLAN.md` (outside git, shared by all worktrees; only Window 1 edits it).
- Shared contract: `extension/src/core/contract.js` (frozen; only Window 1 edits it).
- Based on gurshh `uwlearn_assignment_extension` (MIT, history merged at 363054e) and WATnow (MIT, Eric Zou, 801a1b1). Keep both attributions (`licenses/`).

## Commands
- `npm install` (once per worktree)
- `npm run build`: esbuild bundles `extension/` into `dist/` (load `dist/` unpacked in Edge/Chrome)
- `npm run dev`: rebuild on change
- `npm test`: `node --test` over `test/**/*.test.js`, plus the server tests in `server/`
- `npm run typecheck`: `tsc --noEmit`. Files opt in with `// @ts-check`; all new files should opt in.
- Load in Edge: `edge://extensions` → Developer mode → Load unpacked → `<worktree>/dist`. After a rebuild: Reload the card, then refresh site tabs.

## Worktrees and branches
| Window | Folder | Branch | Owns |
|---|---|---|---|
| 1 lead | `waterloo all in 1 extension/` | `stream/core` (+ merges into `main`) | `extension/manifest.json`, `package.json`, `tools/build.mjs`, `tsconfig.json`, `extension/src/core/**`, `src/capture/**`, `src/calendar/**`, `src/background/**`, `src/panel/**`, `src/options/**`, `src/ui/**`, `extension/styles/**`, `AGENTS.md` |
| 2 academic | `wt-academic/` | `stream/academic` | `extension/src/sources/{learn,outline,portal,email}/**`, `extension/src/lib/textdates/**`, matching `test/` and `test/fixtures/` |
| 3 co-op | `wt-coop/` | `stream/coop` | `server/**`, `extension/src/sources/{waterlooworks,discord}/**`, matching `test/` and `test/fixtures/` |

`legacy/` is read-only reference (the original gurshh files).

## Collaboration rules
1. Edit only files you own. For anything else, add a request to your coordination file (`<root>/coordination/w<N>.md`, "Requests to W1/W2/W3"). The owner answers in theirs.
2. Before writing a helper or parser, check it doesn't already exist: `git log --oneline main stream/core stream/academic stream/coop -20` and `git grep -n "<name>" main stream/core stream/academic stream/coop`.
3. Commit small and often on your own branch. Never push, force, reset, rebase, or touch another branch or worktree. Never delete files you didn't create.
4. Checkpoints: write `READY CP<n>` in your coordination file → Window 1 merges into `main` (`--no-ff`, keeping both sides' useful code) and writes `MERGED CP<n> at <sha>` in `w1.md` → the other windows run `git merge main`.
5. Adapters return data (`SyncResult`) and never write `chrome.storage`. Only the core stores, merges, assigns calendar uids and publishes.
6. Discord is passive only: no requests to Discord, no token access, no automatic navigation.
7. Fixtures in git are redacted (no names, emails, student numbers, message bodies, tokens). Raw captures stay in `<root>/captures/` (outside git).
8. Dependencies: only Window 1 adds them, pinned to exact versions published at least 7 days earlier.

## Layout
```
extension/
  manifest.json  _locales/  icons/  styles/
  src/background/     service worker entry (baseline: WATnow background)
  src/core/           contract, store, model, dates, reminders (+ merge, uid map, scheduler in Phase 1)
  src/capture/        observer.main.js (page world), recorder.content.js, discovery store, relay, offscreen
  src/calendar/       feed publish client, ics download (Phase 2)
  src/sources/<id>/   index.js (Adapter), parsers.js, content.js (site content script)
  src/lib/textdates/  shared date extraction
  src/panel/  src/options/  src/ui/
server/               Cloudflare Worker calendar feed (from gurshh calendar-service)
legacy/gurshh/        original gurshh extension files (reference)
licenses/             upstream licenses
test/  tools/
```
