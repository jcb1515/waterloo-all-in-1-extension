# Waterloo All-in-1

A Chrome/Edge extension that gathers every dated thing in a University of
Waterloo student's life — Learn deadlines, class times, course-outline
deliverables, WaterlooWorks applications and interviews — into one side
panel agenda, and (soon) one Google Calendar subscription, with no
duplicates.

It works with the logins you already have in your browser: no API keys, no
passwords, no OAuth setup.

## Features

**Works now**

- **Learn** — deadlines, announcements and class items, read with your own
  Learn session.
- **Course outlines** — paste an `outline.uwaterloo.ca` URL per course and
  the dated deliverables show up in the agenda.
- **WaterlooWorks** — applications and interview times update automatically
  while you browse the site (no sync button — just use WaterlooWorks).
- **Agenda panel** — click the toolbar icon for today's classes and
  deadlines, what's next, and a searchable, filterable list. Press `/` to
  search.

**In progress**

- Portal (auto-detected sections, tutorials and exam seats)
- Outlook / Gmail events
- Discord (dated messages in servers you choose — read-only, passive)
- The Google Calendar feed
- Reminders
- Week / month views

Chrome and Edge only (Manifest V3, `sidePanel`). No Firefox or Safari
support.

## Install from source

Requires **Node.js ≥ 20**.

```
npm ci
npm run build
```

Then:

1. Open `edge://extensions` (or `chrome://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → pick this repo's `dist/` folder.

To update later: `git pull`, `npm ci` (if dependencies changed),
`npm run build`, then press **Reload** on the extension card and refresh
your site tabs.

## First run

On install, the options page opens on a **Welcome** checklist that walks you
through the six setup steps: sign in to Learn in a tab, add your sections
under **Profile** (until Portal fills them in automatically), paste your
course-outline URLs under **Sources**, browse WaterlooWorks, and pick any
Discord servers to watch. Each step shows live status as it completes.

## Privacy

Everything is processed locally in your browser.

- Course data, merged agenda items, settings and source status live in
  `chrome.storage.local` on your device. Nothing else is sent anywhere
  today.
- Discord reading is **passive**: the extension only notes dated messages
  in channels you can already see while you browse. It makes **no requests
  to Discord** and never accesses your token.
- **No passwords or tokens** are stored — the extension reuses the sessions
  in your browser rather than handling credentials.
- Calendar sync (when it ships) is **opt-in** and sends only event data —
  titles, times, locations — to the feed server.

See [PRIVACY.md](PRIVACY.md) for the full policy.

## Calendar feed server

The `server/` directory contains a Cloudflare Worker that hosts the iCal
feed the extension eventually publishes to. It is designed to be
self-hosted — see [server/README.md](server/README.md) for setup.

## Development

```
npm ci               # once
npm run build        # bundle extension/ into dist/
npm run dev          # rebuild on change
npm test             # node --test over test/**, plus server tests
npm run typecheck    # tsc --noEmit (files opt in with // @ts-check)
node tools/preview.mjs shots   # headless screenshots of the UI
```

Repository layout:

```
extension/
  manifest.json  _locales/  icons/  styles/
  src/background/      service worker (scheduler, sync dispatch)
  src/core/            store, merge/dedup, contract, scheduler
  src/capture/         page observer, recorder, fetch relay, offscreen parse
  src/sources/<id>/    one adapter per site (learn, outline, waterlooworks, ...)
  src/lib/textdates/   shared date extraction
  src/panel/           agenda side panel (Preact)
  src/options/         options page (Preact)
server/                Cloudflare Worker calendar feed
licenses/              upstream licenses
test/  tools/          node --test suites, build + screenshot tools
```

### `dev-profile.json`

Tracked defaults ship blank. For development you can prefill your own
courses/sections/servers by copying `dev-profile.example.json` to
`dev-profile.json` (gitignored) at the repo root and rebuilding — the
values are baked into the bundle and merged over `DEFAULT_SETTINGS`. Your
saved settings still win over both.

## Disclaimer

Not affiliated with or endorsed by the University of Waterloo. The
extension reads only pages you can already see in your own browser — it is
your responsibility to use it in line with each site's terms of use. Use at
your own risk.

## Credits

Built on two MIT-licensed projects:

- [gurshh-rain/uwlearn_assignment_extension](https://github.com/gurshh-rain/uwlearn_assignment_extension)
  (Gurshaan Gill) — the original Learn-scraper idea and the Cloudflare
  Worker calendar feed in `server/`.
- [WATnow](https://github.com/EricJujianZou/watnow) by Eric Zou — the Learn
  side panel, reminders and live Learn reader foundations.

Icons are adapted from [Lucide](https://lucide.dev) (ISC).

Upstream licenses are in `licenses/`. This project is MIT-licensed — see
[LICENSE](LICENSE).
