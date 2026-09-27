# Waterloo All-in-1

A Chrome/Edge extension that gathers every dated thing in a University of
Waterloo student's life — Learn deadlines, class times, course-outline
deliverables, WaterlooWorks applications and interviews — into one side
panel agenda, and one Google Calendar subscription, with no duplicates.

It works with the logins you already have in your browser: no API keys, no
passwords, no OAuth setup.

## Features

**Works now**

- **Learn** — deadlines, announcements and class items, read with your own
  Learn session.
- **Course outlines** — paste an `outline.uwaterloo.ca` URL per course, or
  import a saved outline page or PDF syllabus (Ctrl+S), and the dated
  deliverables show up in the agenda.
- **Portal** — class and exam schedules fill in sections, tutorials and exam
  seats automatically as you browse.
- **WaterlooWorks** — applications and interview times update automatically
  while you browse the site (no sync button — just use WaterlooWorks).
- **Discord** — meetings, tasks and deadlines in design-team servers you
  watch. Read-only and passive; optional host permission.
- **Agenda panel** — click the toolbar icon for today's classes and
  deadlines, what's next, and a searchable, filterable list. Press `/` to
  search, `+` to quick-add your own items.
- **Calendar, Co-op, Courses and Teams tabs** — a week/month grid with
  clash outlines, WaterlooWorks interview prep checklists, per-course grade
  calculators, and one card per watched team.
- **Reminders** — per-type lead times, quiet hours, a morning briefing and
  a weekly digest notification.
- **Google Calendar feed** — publish the agenda to a private iCal feed
  (opt-in, self-hosted server — see below) and subscribe from Google
  Calendar, Apple Calendar or Outlook. Or use the one-off .ics download in
  Settings → Calendar.
- **Backup** — Settings → About exports/imports your settings, item edits,
  manual items and outline files.

**In progress**

- Outlook / Gmail events

Chrome and Edge only (Manifest V3, `sidePanel`). No Firefox or Safari
support.

## Install from a release zip

Download `waterloo-all-in-1-<version>.zip` from the release, unzip it, then:

1. Open `edge://extensions` (or `chrome://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → pick the unzipped folder (it contains
   `manifest.json`).

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
through the setup steps: sign in to Learn in a tab, check your sections,
add outline URLs or files under **Sources**, browse WaterlooWorks, allow
discord.com and pick the servers to watch, and set up the calendar feed.
Each step shows live status as it completes.

## Permissions

The extension asks for the smallest set it can work with:

- **Required hosts** are all University of Waterloo sites it reads on your
  behalf as you browse: Learn, the course-outline site, Portal (and its
  API), WaterlooWorks, and the public co-op dates page.
- **Optional hosts** are asked for only when you enable the source:
  `discord.com` for the Teams view, and the Outlook/Gmail hosts for email
  invites (coming soon). Grant them from Settings → Sources, the panel's
  Sources overlay or the Welcome checklist; revoke them any time from the
  browser's extension details.
- `storage`, `alarms` and `notifications` keep your data on-device, run
  background syncs and fire reminders. `tabs` lets "Open site" focus an
  existing tab. `scripting` registers content scripts for the optional
  hosts after you grant them.

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
- Calendar sync is **opt-in** and sends only event data — titles, times,
  locations — to the feed server you configure.

See [PRIVACY.md](PRIVACY.md) for the full policy.

## Calendar feed

The `server/` directory contains a Cloudflare Worker that hosts the iCal
feed the extension publishes to. It is designed to be self-hosted — see
[server/README.md](server/README.md) for setup.

Two settings worth knowing:

- **Class window** — classes publish only within a rolling window
  (one week back, `classWeeks` ahead — default 8) to keep the feed small.
  Tune "Weeks of classes ahead" in Settings → Calendar.
- **One-off .ics** — Settings → Calendar → "Download a calendar file"
  exports the same events with the same IDs as the feed. It's for a
  one-time copy — don't import it into a calendar you already subscribe
  to, or events will appear twice.

## Development

```
npm ci               # once
npm run build        # bundle extension/ into dist/
npm run dev          # rebuild on change
npm test             # node --test over test/**, plus server tests
npm run typecheck    # tsc --noEmit (files opt in with // @ts-check)
npm run package      # release build (no dev profile, minified) + zip in release/
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

A released build can also ship a hosted feed server as the default:
set `WA1_CALENDAR_SERVICE_URL` in the environment at build time and it's
baked in as `calendar.serviceUrl`. Again, the user's saved setting wins.

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
