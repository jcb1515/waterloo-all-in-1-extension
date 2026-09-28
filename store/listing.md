# Store listing — Waterloo All-in-1

Copy for the Chrome/Edge add-ons listing. Not shipped with the extension.

## Short description (≤132 chars)

Every Waterloo deadline, class, interview and meeting in one side panel and one Google Calendar — no duplicates.

## Full description

Waterloo All-in-1 pulls the dated things in a UW student's life into one place:

- **Agenda** — today, this week and what's next, merged from Learn, course outlines, Portal and WaterlooWorks, with a due-date search and per-day estimate totals.
- **Calendar week and month** — classes, labs and deadlines on a real grid; clashes outlined, loaded days shaded, tentative dates dashed.
- **Co-op** — WaterlooWorks applications by stage, interview prep cards with checklists, offer and ranking deadlines, and mail invites linked to the application they belong to.
- **Email (Outlook + Gmail)** — calendar invites and dated mail (interviews, offers, course mail) read passively in mail tabs you open; each provider is a separate optional permission.
- **Courses** — per-course assessment timelines, grading schemes, a needed-on-remaining calculator and office hours.
- **Teams** — Discord design-team servers: meetings, assigned tasks, deadlines and watched channels (read-only, passive).
- **One Google Calendar feed** — opt-in publishing to a single private subscription feed you host or choose; or a one-off .ics download.
- **Reminders** — per-type lead times, quiet hours, a morning briefing and a weekly digest.

**Privacy-first.** Everything is extracted and stored locally in your browser. Nothing leaves your device unless you turn on calendar sync, and even then only event data goes to the feed server you configured. No accounts, no analytics, no ads.

**Not affiliated with or endorsed by the University of Waterloo.**

## Category

Productivity

## Single-purpose statement

Waterloo All-in-1 consolidates University of Waterloo deadlines, classes,
co-op items and events into a single side-panel agenda and a single calendar
feed.

## Permission justifications

Required permissions:

- `sidePanel` — the extension's main UI lives in the browser side panel.
- `storage` — extracted items, settings and sync state are stored in `chrome.storage.local` on the device.
- `unlimitedStorage` — course-outline imports and PDF syllabi can exceed the default storage quota.
- `alarms` — schedules background syncs, reminder notifications, the daily briefing and weekly digest.
- `notifications` — deadline reminders, the briefing and the digest.
- `offscreen` — an offscreen document parses imported PDF outlines and page captures.
- `tabs` — opening a source site focuses an existing tab instead of duplicating it; "Open site"/channel links use it.
- `scripting` — registers content scripts dynamically for hosts the user grants as optional permissions (Discord, email).

Required host permissions (University of Waterloo sites the extension reads):

- `https://learn.uwaterloo.ca/*` — reads deadlines, quizzes and announcements from Learn.
- `https://outline.uwaterloo.ca/*` — reads assessment tables from official course outlines.
- `https://portal.uwaterloo.ca/*` and `https://portalapi2.uwaterloo.ca/*` — reads the class and exam schedule API the Portal pages call.
- `https://waterlooworks.uwaterloo.ca/*` — reads applications, interviews and offer deadlines from WaterlooWorks.
- `https://uwaterloo.ca/co-operative-education/*` — reads the public co-op dates page (term dates, work-term milestones).

Optional host permissions (requested only when the user enables the source):

- `https://discord.com/*` — passive, read-only capture of dated messages and events in Discord servers the user watches. The extension never posts and never reads the account token.
- `https://outlook.office.com/*`, `https://outlook.cloud.microsoft/*`, `https://outlook.live.com/*` — reads calendar invites and dated mail in Outlook web tabs the user opens (requested separately from Gmail).
- `https://mail.google.com/*` — the same passive reading for Gmail tabs (requested separately from Outlook).
- `https://calendar.google.com/*` — the optional "skip events already on my calendar" duplicate check. Reads event titles and times from the user's own calendars only — never subscribed calendars and never the extension's own published feed — purely to avoid publishing duplicates. Nothing read there is transmitted. Off by default; the browser prompt appears only when the user turns the feature on.

## Data-use disclosures

- The extension does not collect, transmit, sell or share user data.
- All extracted items and settings stay in `chrome.storage.local` on the user's device.
- If the user enables Google Calendar sync, event data (titles, times, locations) is sent to a feed server the user configures themselves (self-hosted Cloudflare Worker; see `server/`).
- No analytics, advertising, or third-party trackers. No credentials, tokens, or message bodies are stored.
- Optional permissions (Discord, email) are requested in-context only when the user enables those sources, and can be revoked from the browser at any time.

## Assets

- `store/screenshots/01-agenda.png` … `05-settings-calendar.png` — 1280×800 store screenshots (fake preview data only).
- `store/promo-small-440x280.png` — small promo tile.
- `store/icon-128.png` — 128 px store icon.
