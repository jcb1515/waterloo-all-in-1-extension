# Waterloo All-in-1

A Chrome/Edge extension that finds every dated thing in a University of
Waterloo student's life — deadlines, classes, exams, co-op interviews,
info sessions, email invites and team meetings — and puts them in one
side panel and one Google Calendar subscription, with no duplicates.

It works with the logins you already have in your browser: no API keys,
no passwords, no OAuth setup.

**What you can use it for**

- One place for every deadline, class, exam, co-op interview, info
  session, email invite and team meeting — from Learn, course outlines,
  Portal, WaterlooWorks, Discord, Outlook and Gmail.
- One Google Calendar with all of it on — and nothing twice, even if the
  same thing appears in two places or is already on your calendar.
- A To-do list built from all of it: study tasks before exams, replies to
  send, applications to submit, plus anything you add yourself.

## Quick start

1. [Install the extension](#install-from-a-release-zip).
2. Pin it to your toolbar and click it to open the side panel.
3. Sign in to **Learn** once — deadlines start showing up within minutes.
4. Add your course outlines (Courses → **Add outline**) and open
   **Portal** once — your class and exam schedule fills in.
5. Browse **WaterlooWorks** as usual, and turn on email or Discord
   reading under **Sources → Setup** if you want them.
6. Turn on the calendar feed in **Settings → Calendar** and subscribe
   from Google Calendar.

The **Welcome** checklist in Settings walks you through the same steps
with live status for each one.

## Install from a release zip

Download `waterloo-all-in-1-<version>.zip` from the
[latest release](https://github.com/jcb1515/waterloo-all-in-1-extension/releases/latest),
unzip it, then in Chrome or Edge:

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped folder — the one that
   contains `manifest.json`.
4. Pin the extension (puzzle-piece menu → pin) so the side panel is one
   click away.

**Updating:** updates are not automatic for unpacked installs. Download
the new zip, unzip it over the same folder (replace the contents), press
**Reload** (⟳) on the extension card, then refresh any open site tabs
(Learn, Outlook, etc.) so they pick up the new version. Your data and
settings carry over.

## Setting up each source

Everything below happens under the side panel's **Sources** tab —
**Setup** has the switches for each source, **Picked up** shows what was
found, and **Check** shows read status. The same optional permissions can
also be granted from the Settings → **Welcome** checklist.

### Learn

- **What it reads:** deadlines, quizzes, announcements and class items
  from every course you're enrolled in, using Learn's own data feed.
- **Setup:** sign in to `learn.uwaterloo.ca` in a normal tab. Nothing
  else — it uses your existing session.
- **How often:** every 30 minutes in the background, plus each time you
  open a Learn page, plus **Check now**.
- **You get:** deadlines and dated announcements in Upcoming, courses in
  the Courses tab.

### Course outlines

- **What it reads:** the assessment/deliverable tables (names, weights,
  due dates) on `outline.uwaterloo.ca` pages, and saved outline pages or
  PDF syllabi you import.
- **Setup:** open **Courses → Add outline** and paste the outline URL for
  each course — or save an outline page or PDF (Ctrl+S) and import it
  the same way. The outline site sits behind UW sign-in, so sign in once
  if the import asks.
- **How often:** stored outlines are re-read about once a day, and at
  most every 6 hours while an outline tab is open.
- **You get:** outline deliverables in Upcoming and per-course grading
  schemes in Courses.

### Portal

- **What it reads:** your enrolments, class schedule, exam schedule and
  the university calendar, through the same requests the Portal pages
  make.
- **Setup:** open any `portal.uwaterloo.ca` page while signed in. It's
  fully passive — there is nothing to connect.
- **How often:** only while a Portal tab is open, at most once every
  30 minutes.
- **You get:** your real lecture/tutorial/lab times, exam seats and term
  dates — this is what puts classes on the calendar.

### WaterlooWorks

- **What it reads:** your applications, booked and unscheduled
  interviews, upcoming events/workshops, saved jobs and co-op important
  dates — the pages and lists you can already see.
- **Setup:** just use WaterlooWorks while signed in. The extension
  re-reads your dashboard, interviews and applications while a
  WaterlooWorks tab is open; turn that off under **Sources →
  WaterlooWorks → "Refresh WaterlooWorks automatically"** if you prefer
  it to read only pages you actually visit.
- **How often:** the public co-op dates page is fetched at most once a
  day; your own pages are read while you browse or while a tab is open
  (at most every 30 minutes per tab), plus **Check now**.
- **You get:** interviews, application deadlines and events in Upcoming,
  the whole Co-op tab, and "Apply" to-dos for saved jobs that are still
  open.

### Gmail

- **What it reads:** the first page of your inbox (up to 50
  conversations) for invites and dated mail, exactly as your tab shows
  it. Full text is read only for mail that looks relevant — see
  [Email filters](#email-filters).
- **Setup:** **Sources → Email → "Read Gmail"** — the browser asks for
  `mail.google.com` access at that moment. Then open Gmail once.
- **How often:** when a Gmail tab loads, every 30 minutes while it stays
  open, and on **Check now**.
- **You get:** interview invites, deadlines and dated course mail as
  items; optionally Gmail invitations on the feed too.

### Outlook

- **What it reads:** your newest inbox messages — 100 by default; choose
  50, 100 or 200 under **Sources → Email → "Messages to check"** —
  through Outlook's own mail API inside the tab.
- **Setup:** **Sources → Email → "Read Outlook"** (asks for the Outlook
  hosts only), then open Outlook once.
- **How often:** same as Gmail — on tab load, every 30 minutes while
  open, and on **Check now**.
- **You get:** the same kinds of dated mail items as Gmail.

### Discord

- **What it reads:** dated messages, meetings and events **in channels
  you open yourself** in servers you watch. It is passive and read-only:
  it makes **no requests to Discord**, never opens Discord for you, and
  never touches your account token.
- **Setup:** **Sources → Discord → "Allow discord.com"**, open Discord
  once so your server list is seen, then pick servers under **Watched
  servers** and optionally narrow to specific channels. Mentions of you
  are always picked up.
- **How often:** only while you're looking at a watched channel. **Check
  now** just reports whether a Discord tab is open — it never opens one.
- **You get:** team meetings, deadlines and reply to-dos in the Teams
  tab and To-do.

### Google Calendar (duplicate check)

- **What it reads:** event titles and start/end times only (never
  descriptions, guests or locations), purely to avoid publishing
  something that's already on your calendar:
  - your **own** calendars, from the same export file Google Calendar's
    Settings → Export gives you (about a week back to four months ahead);
  - **other calendars you've added** (for example a UW Flow or Quest
    schedule), from the weeks shown on screen while a Google Calendar tab
    is open.
  This extension's own feed is always ignored, and nothing it reads
  leaves your browser.
- **Setup:** **Sources → Google Calendar → "Allow calendar.google.com"**,
  then open Google Calendar once. If a calendar is missing from the
  export you can paste its secret iCal address under **Sources → Google
  Calendar → "Private iCal addresses"**.
- **How often:** about every 6 hours in the background, plus **Check
  now**.
- **You get:** classes and events already on your Google Calendar are
  skipped on the feed and marked "Already on your Google Calendar" in
  the panel.

## Using it

Click the toolbar icon to open the side panel. Tabs along the top:
**Upcoming**, **To-do**, **Calendar**, **Sources**, and a **More** menu
for **Courses**, **Co-op**, **Teams** and **Projects**. Header buttons:
search, **+** (Quick add), review (badge counts what's waiting),
updates (bell), and the gear for Settings. Keys: `/` searches, `1`–`4`
switch the main tabs, `Esc` closes any overlay.

### Upcoming

Everything dated, day by day — classes, deadlines, exams, meetings,
interviews. Filter chips cover Exams, Deadlines, Classes, Meetings,
Co-op and Clashes; the dropdowns filter by course/team and by source;
the search box ("Search titles, courses, rooms…") matches titles,
courses and rooms. Click an item to open its item sheet.

- **"Found, not added yet"** — at the bottom: items the extension found
  but that wait for your review (email deadlines, Discord dates, other
  tentative finds). Add them to your calendar or To-do from their item
  sheet, or review them in bulk on the **Review** screen.
- Banners at the top flag a source that needs attention ("Needs a
  visit", "Get set up", "Calendar publish failed").
- Estimates: give items a time estimate on their sheet and busy days
  show summed totals.

### To-do

Auto-built and manual tasks in groups: **Overdue**, **Today**, **This
week**, **Later**, **No date** and **Done**. Filter chips: Auto, School,
Co-op, Teams, Projects, Replies & calls, Mine.

- The extension creates study to-dos before quizzes, exams and
  presentations; co-op actions (offers, rankings, timeslots); reply
  to-dos for mail and Discord messages that look like they need an
  answer; and application to-dos. Each kind can be turned off in
  **Settings → General → To-dos**.
- **Add a task** writes your own; **+** in the header opens the full
  Quick add sheet.
- Each row can be marked done/not done, snoozed ("Snooze until tomorrow
  8 AM"), opened at its source, or pinned from its item sheet.
- **"Put to-dos on the calendar feed"** (Settings → General) also places
  dated to-dos on your calendar. Undated to-dos never go on the feed.

### Calendar

A real grid: **Week** and **Month** views with Previous/Next/Today.
Classes, deadlines and events render on their days; clashing items are
outlined; a **workload heat** legend shades loaded days. The **+** on a
day opens Quick add preset to that date. The **"What's included"**
section mirrors the feed toggles, and the feed status line shows
"Calendar sync on", "Publishing…" or "Publish failed" with a **Copy
link** for your feed address.

### Co-op

Your WaterlooWorks life: the next 14 days of co-op items up top,
interview **prep cards** with a persistent checklist (research the
company, review the posting, prepare questions, test camera and mic —
check them off or add your own), then applications grouped by status:
All / Applied / Interviewing / Offers / Closed. "Open posting" jumps to
the WaterlooWorks posting.

### Courses

One card per course: sections and tutorials to confirm, the grading
scheme parsed from the outline, a needed-on-remaining grade calculator,
instructor and office-hours info, and that course's upcoming items.
**Add outline** lives here.

### Teams

One card per watched Discord server: meetings, assigned tasks, deadlines
and unread-channel counts, with review counts for anything that needs
your call.

### Projects

Group manual items and to-dos into projects (**Active**, **Done**,
**Archived**). Each project has tasks and milestones with due dates and
an **"Included in the calendar feed"** switch to keep a project's items
off the feed. Type `#project-name` at the start of a Quick add line to
file the item straight into a project.

### Review

The review screen (badge in the header) lists dates the extension found
in text — mail, Discord, announcements — that need your judgement. Each
card shows the sentence it came from, the proposed date and the source,
with **Add**, **Edit** and **Dismiss**; **"Dismiss all past"** clears
out-of-date finds; **Undo** is offered after each action. Nothing goes
on your calendar from here without an Add.

### Quick add

The **+** button opens a single text line that parses as you type —
"CS136 midterm Oct 21 7pm" fills in title, type, date and time — then
shows editable fields: Title, Course or team, Type (task, deadline,
quiz, exam, presentation, meeting, interview, event, lab, class), Date,
Start/Due time, End time, Location, and a project. **Save** adds it as a
manual item.

### The item sheet

Clicking any item opens its sheet: when and where it is, which source
found it, the exact sentence or record it came from, and:

- **Add to calendar** — for a pending item, accepts it so it lands in
  Upcoming and the feed. **Remove from calendar** undoes that: an item
  you added goes back to "Found, not added yet"; for items a source
  added on its own (like Learn deadlines) it just takes them off the
  feed while they stay in Upcoming. Both offer **Undo**.
- **Edit & add** — fix the title/date/location first, then accept.
- **Already on your Google Calendar** — shown instead of the add button
  when the duplicate check found it on Google.
- **Add to To-do** / **Remove from To-do** — pin it into your To-do list
  ("Pinned to your to-do list"), or take it off again.
- **Mark done**, **Hide** (find it again under Settings → General →
  Hidden and snoozed items), **Delete** for manual items.
- **Private notes** (saved only on this computer), a **custom time
  estimate** in minutes, **Snooze** presets, and a **checklist** you can
  fill in.

### Sources

Three segments per source tile. **Picked up** shows the items that
source found ("Nothing picked up yet" until it reads something).
**Setup** has that source's switches and permissions. **Check** shows
recent reads and the **Check readers** checklist ("What should the
reader have seen?") with "What it saw" evidence, **Save page structure**
for bug reports, and **Download check report**.

Each tile shows a status badge — Connected, Needs a visit, Signed out,
Stale · open site to refresh, Not read yet · open the site, Needs
permission, Coming soon — plus an **Enabled** switch, **Open site**, and
**Check now**.

### Check now

**Check now** (on a source's Check segment, or via `npm run live` in
development) runs an immediate read instead of waiting for the schedule.
Learn, outlines and the Google duplicate check run in the background;
Portal, Gmail, Outlook, WaterlooWorks and Discord reuse a tab you
already have open (opening one only if needed — never for Discord). The
result line reports what happened, e.g. "Checked 50 · no new items ·
just now", "Signed out of Outlook", "Open Portal to check", or "Didn't
finish — try again".

### Updates

The bell opens a feed of what changed: new items, moved or cancelled
dates, status changes and review counts. **Clear all** empties it;
**Open item** jumps to the item sheet.

### Reminders and notifications

Settings → **Reminders**: a master switch, then per-type lead times —
separate chips for deadlines, quizzes, exams, presentations, interviews,
application and offer deadlines, meetings, tasks, lab reports, classes,
tutorials, events and co-op cycle dates (from 15 minutes to 1 week
before). Plus "Include tentative dates", **Quiet hours** (reminders
wait; anything already past is dropped), a **Morning briefing**
notification with today's classes and deadlines, a **Weekly digest**
with the next seven days and the busiest day, and **Send test
notification**. These come from the extension — Google Calendar ignores
reminders in subscribed feeds.

## Google Calendar feed

Turn it on in **Settings → Calendar → "Publish to a calendar feed"**.
Publishing uses the shared Waterloo All-in-1 server by default (a
Cloudflare Worker run by the maintainer); a different server URL can be
entered above the toggle, or you can self-host — see
[server/README.md](server/README.md).

Once published, the feed link appears with an **Add to Google Calendar**
button (or **Manual steps**: Google Calendar → Other calendars "+" →
From URL → paste the link). The link is private — treat it like a
password: anyone with it can see your calendar. **Publish now** forces
an update; **Stop syncing and delete feed** removes it.

**What gets published:** dated items that are on your calendar —
accepted or source-added deadlines, classes, exams, meetings and events.

**What doesn't:** pending and dismissed items, hidden or cancelled
items, items already on your Google Calendar, items you removed from
the calendar, per-project opt-outs, undated to-dos (their "due" is a
guess), to-dos unless **"Put to-dos on the calendar feed"** is on
(Settings → General), and classes outside a rolling window (a week back,
"**Weeks of classes ahead**" ahead — default 8). The Include toggles —
**Classes, tutorials and labs**, **Tentative items**, **Completed
items**, **Term dates** — trim further; **"Reminders in the feed"** adds
alarms Apple/Outlook honours (Google ignores them), and **"Separate
calendars by type"** gives per-type feed links (subscribe to one set or
the other, not both).

**Timing:** the side panel is always instant; the feed republishes about
a minute after changes. Google polls subscribed feeds on its own
schedule — often hours, up to about a day — so new items can take a
while to appear in Google Calendar.

### Already imported UW Flow or Quest into Google Calendar?

Turn on the duplicate check (**Sources → Google Calendar → "Allow
calendar.google.com"**) and open Google Calendar once. Classes that
match by course code, class type and start time are skipped on the
feed. Copies the extension already published disappear from the feed
after your next publish and Google's next refresh (up to about a day).

- If the schedule was **imported** into one of your own calendars, the
  whole term is covered by the export.
- If it's a **subscribed** calendar, the extension only sees the weeks
  you've viewed in Google Calendar. Switch to Month view and page through
  the term once.

### Prefer a file? (.ics)

Settings → Calendar → **"Download a calendar file" → "Download .ics"**
exports the same events with the same IDs. It's a one-time copy — don't
import it into the same Google calendar you subscribe to, or events
appear twice.

## Email filters

Under **Sources → Email → Setup** (and Settings → Advanced for extras):

- **Course and co-op senders only** — limit reads to school/co-op mail.
- **Always count (allow list)** — comma-separated addresses or domains;
  mail from them always counts as important.
- **Never count (block list)** — same format; a block wins over
  everything, including the allow list.
- **Keywords** — words added to the built-in ones (interview, deadline,
  exam…).
- **Messages to check** — Outlook reads the newest 50, 100 or 200 inbox
  messages (default 100); Gmail reads the first inbox page (50).
- **Also read Sent** — so replying closes the matching to-do.
- **Also put Gmail invitations on the calendar** — off by default since
  Google adds invites itself.
- **Folders** (Settings → Advanced) — extra folders beyond the inbox.

**Never read or stored:** your mail password or session tokens (Outlook's
token is used only as the header of read requests while a check runs and
is never saved), the bodies of irrelevant mail (full text is fetched only
for relevant-looking messages, ≤20 requests/minute, and kept in memory
only while dates are extracted — what's stored is the title, date, the
matching sentence and a link back to the message). The extension cannot
send, move, delete or mark mail, and a check never changes what's unread.
Details: [PRIVACY.md](PRIVACY.md).

## Permissions

Required at install — all University of Waterloo reading:

- `learn.uwaterloo.ca` — deadlines and announcements from Learn.
- `outline.uwaterloo.ca` — course-outline assessment tables.
- `portal.uwaterloo.ca` + `portalapi2.uwaterloo.ca` — your class/exam
  schedule via the Portal API.
- `waterlooworks.uwaterloo.ca` — applications, interviews, offers,
  events.
- `uwaterloo.ca/co-operative-education/*` — the public co-op dates page.

Asked for only when you enable the source:

- `discord.com` — passive, read-only watching of the servers you pick.
- `outlook.office.com`, `outlook.cloud.microsoft`, `outlook.live.com` —
  Outlook mail reading.
- `mail.google.com` — Gmail reading.
- `calendar.google.com` — the own-calendar duplicate check.

Browser permissions:

- `sidePanel` — the panel itself. `storage` + `unlimitedStorage` — all
  data stays on your device; outline/PDF imports can exceed the default
  quota. `alarms` — scheduled syncs and reminders. `notifications` —
  reminders, briefing, digest. `offscreen` — parses imported PDFs.
  `tabs` — "Open site" focuses an existing tab instead of duplicating,
  and **Check now** reuses an open site tab or opens a background one
  (closing it again afterwards).
  `scripting` — registers the readers for optional hosts you grant, and
  reconnects them to site tabs that were already open after an update.

## Privacy

Everything is extracted and stored locally in `chrome.storage.local` on
your device. By default nothing is sent anywhere — no analytics, no
trackers, no credentials or tokens are stored. Discord is passive and
makes no requests. If you turn on calendar sync, only event data
(titles, times, locations) goes to the feed server so Google can
subscribe; the feed link is unguessable but anyone holding it can read
that feed, and you can delete it any time. Full policy:
[PRIVACY.md](PRIVACY.md).

## Troubleshooting

What the status texts mean and what to do:

- **"Not read yet · open the site"** / **"Not read yet — open
  Gmail/Outlook once"** — the source has never read anything. Open the
  site while signed in once.
- **"Signed out"** or **"Signed out of \<source\>"** — your session
  expired. Open the site, sign back in, then Check now.
- **"Didn't finish — try again"** / **"last check didn't finish"** — a
  check run never reported back. Press **Check now** again; if it
  repeats, refresh the site tab and retry.
- **"Stale · open site to refresh"** — the last successful read is too
  old (or never happened). Open the site or press Check now.
- **"Needs a visit"** — you've never opened the site since installing;
  open it once.
- **"Needs permission"** — an optional host grant is missing; the tile
  names it and the button re-asks.
- **Duplicates on Google Calendar** — if a class appears twice, you
  likely subscribed to the feed *and* kept a UW Flow/Quest import: allow
  `calendar.google.com` (see above) so matching items are skipped. Also
  don't subscribe to both the single feed and the per-type feeds, and
  don't .ics-import into a subscribed calendar.
- **A missing class or deadline** — check Sources → the source's
  **Check** segment and the **Check readers** checklist; it shows what
  the reader expected and what it saw. Then Check now. For outline
  items, make sure the outline was added under Courses.
- **Check now does nothing right after an update** — refresh the site
  tab once so it runs the new version, then Check now again. (Since
  1.4.1 an already-open tab is reconnected automatically; the refresh is
  the fallback.)

## Reporting problems

Open an issue at
<https://github.com/jcb1515/waterloo-all-in-1-extension/issues> with:

- your program/year and which source is misbehaving,
- what you expected vs what you saw,
- a screenshot of the side panel or the source page,
- and, if a reader missed something, the **"Download check report"** /
  **"Save page structure"** output from Sources → Check.

Don't paste email text, grades or student numbers — the report tools
already redact, and structure is usually enough.

## Development

Requires **Node.js ≥ 20**.

```
npm ci               # once per checkout
npm run build        # bundle extension/ into dist/ — load dist/ unpacked
npm run dev          # rebuild on change
npm test             # node --test over test/**, plus server tests
npm run typecheck    # tsc --noEmit (files opt in with // @ts-check)
npm run verify       # fixture audit: duplicates, invalid dates, wrangler config
npm run package      # release build (ignores dev-profile, minified) + zip in release/
node tools/preview.mjs shots   # headless screenshots of the UI
```

`npm run package` runs release checks (no dev-profile strings, no
upstream names outside `licenses/`, no localhost feed URL, dist
verification, and the `server/wrangler.jsonc` placeholder check) and
writes `release/waterloo-all-in-1-<version>.zip`. Rebuild a dev `dist/`
afterwards.

Repository layout:

```
extension/
  manifest.json  _locales/  icons/  styles/
  src/background/     service worker (scheduler, check-now, sync dispatch)
  src/core/           store, merge/dedup, contract, scheduler, uid map
  src/capture/        page observer, recorder, fetch relay, offscreen parse
  src/calendar/       feed publish client, ics download
  src/sources/<id>/   one adapter per site (learn, outline, portal, email, ...)
  src/lib/textdates/  shared date extraction
  src/panel/          side panel (Preact)   src/options/  options page
server/               Cloudflare Worker calendar feed
legacy/               upstream reference (read-only)
licenses/             upstream licenses
test/  tools/         node --test suites, build + verification tools
```

### `dev-profile.json`

Tracked defaults ship blank. For development you can prefill your own
courses/sections/servers by copying `dev-profile.example.json` to
`dev-profile.json` (gitignored) at the repo root and rebuilding — the
values are baked into the bundle and merged over `DEFAULT_SETTINGS`.
Your saved settings still win over both.

A released build can ship a different hosted feed default: set
`WA1_CALENDAR_SERVICE_URL` in the environment at build time and it's
baked in as `calendar.serviceUrl` (empty for none). A saved setting
always wins over the built-in URL.

The `server/` Worker deploys with Wrangler; `server/wrangler.jsonc` in
git keeps a placeholder `database_id` — `npm run verify` and
`npm run package` fail if a real ID, `vars`, or `account_id` is
committed there, so keep real values in an untracked local config.

## Disclaimer

Not affiliated with or endorsed by the University of Waterloo. The
extension reads only pages you can already see in your own browser — it
is your responsibility to use it in line with each site's terms of use.
Use at your own risk.
