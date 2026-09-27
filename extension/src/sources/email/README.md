# Email adapter (Outlook web + Gmail) — T3, DOM only

Finds dated things in already-rendered mail: meeting/interview invites and
"important" mail (co-op, Learn, instructors, course-coded, keyworded) that
mention a date. **No network access of any kind**: OWA's tokened API and
Gmail's data endpoints were never captured, so there are no `urlPatterns`
and `sync` is a no-tab stub. Everything arrives as a serialised DOM extract
from `content.js` (a bundled IIFE; bundled separately by `tools/build.mjs`).

## Pipeline

- `content.js` — passive DOM reader. Runs on load, `hashchange`/`popstate`,
  and a MutationObserver debounced to 2s. Sends `MSG.OBSERVED` with
  `{source, kind: "dom", url, body: JSON.stringify(extract), at}` only when
  the extract has messages, deduped by body, capped at 2 MB, `.catch`-ed.
- `dom.js` — `extractFor(doc, href)` → `{v, provider, folder, view, messages}`,
  one per host. `Msg = {key, url, from, fromEmail, subject, preview?,
  receivedText?, receivedAt?, body?, links}`. Bodies exist only in message
  view (≤20,000 chars, `<br>`/block boundaries → `\n`), previews ≤200 chars,
  `receivedAt` = ISO Toronto from a title/text parse (omitted on failure),
  `links` = Teams/Zoom/Meet/WaterlooWorks hrefs with Google `url?q=` wrappers
  unwrapped.
- `rules.js` + `extract.js` — `itemsFromMessage(msg, …)` (pure):
  - **Invites → exact items.** Checked in order: the rendered **invite card**
    (`msg.invite`, when the client drew the RSVP card whose date Gmail/Outlook
    put outside the body), the Google-Calendar subject
    (`Invitation:|Updated invitation|Canceled event|Cancelled event( with note)?: <title> @ <when> (<tz>) (<email>)`),
    a `When:` body line, or a meeting link + timed date. The when-text is
    parsed with `textDates` (Toronto wall time; card separators `·`/`•`/`|` and
    `M/D/YYYY`/`YYYY-MM-DD` dates are normalised first); an absent or Eastern
    zone is `exact`/`auto`, anything else `tentative`/`pending` with `meta.tz`.
    `Canceled event:` keeps `status "cancelled"`. "interview" in the subject
    or a WaterlooWorks sender makes it an `interview`. `meta.facts` carries
    Organizer/Where/Join.
    - `id = <provider>:invite:<slug(title)>:<startAt>` — **not** the message
      key, so an Invitation / Updated invitation / reminder / forward / the
      matching Canceled event of the same meeting collapse to one item; a
      cancellation lands as `status "cancelled"` and the publisher drops it.
    - `meta.employer` = sender domain label (e.g. `acme`) on interviews and
      co-op mail, so core can link the item to a WaterlooWorks application.
    - Gmail invite items get `meta.onCalendar = "google"`: Google already puts
      Gmail invitations on the user's Google Calendar, so the publisher skips
      them (opt back in with `settings.gmailInvitesToFeed: true`).
  - **Important mail → review items.** Sender gate: WaterlooWorks/co-op,
    Learn, a `courses[].instructors[].email` match, a course code in the
    subject, or `settings.teams`/`settings.senders` substrings — OR a keyword
    in the subject. Keyword set: interview, offer, rank(ing), deadline, due,
    extension, midterm, exam, room change, cance(l)led, rescheduled, meeting,
    tapeout, design review, rsvp, invited, invitation, register, registration,
    event ∪ `settings.keywords`. Date hits come from
    `textDates(subject + "\n" + body|preview)`, confidence ≥0.6, not ended
    before `receivedAt − 1d`, and inside a keyword sentence; max 3 per
    message, one per Toronto day. Type maps off the keyword (interview,
    offer-deadline, cycle-date, exam, meeting, deadline, else event); timed
    hits give `startAt`/`endAt` or `dueAt` (all-day deadline → 23:59 ET).
    Always `tentative`/`pending`; `id = <provider>:mail:<key>:<instant>`.
    `exam` items take the outline/Portal titles ("Midterm"/"Final exam" when
    `classify` finds one in the sentence or subject) plus
    `details = "Email: " + cleanedSubject`, so they merge with the real exam.

## Settings

`{gmail?, outlook?, folders?, senders?, keywords?, teams?, gmailInvitesToFeed?}`

- `settings.gmail` / `settings.outlook` `=== false` → that provider returns
  an empty, incomplete result (`scope "email:off"`).
- `gmailInvitesToFeed: true` → Gmail invite items lose `meta.onCalendar` and
  publish normally (default: skipped, Google Calendar already has them).
- `folders` (default `["inbox"]`) — case-insensitive allow-list on the
  extract's folder; `"sent"` yields nothing unless configured. A null folder
  is allowed.
- `senders` / `teams` — case-insensitive substrings matched against the
  sender name/email for the gate; `teams` also supplies `org` fallback.
- `keywords` — extra word-bounded keywords for the hit filter and typing.

## Invite cards

Gmail and Outlook draw a Teams/Calendar invite card *above* the message — its
date never appears in the `.a3s`/message body, so without the card those mails
produce nothing. `dom.js` finds the smallest element inside `[role="main"]`
(Gmail falls back to the document, `.a3s` excluded) whose line text has a
`CARD_WHEN_RE` date plus a response cue (`Yes/No/Maybe/RSVP/Accept/…` button
text or a `<name> – Organizer` line). Lines are read in order; `On your Google
Calendar`/`Conflict with`/`Based on this email` stop the card — those describe
OTHER events and must never become items. First line after the when-line that
isn't UI/button text is the title; the next is the location. The result goes
to `messages[0].invite` (one card per thread).

## Guided mail scan ("scan my mail")

`startMailScan(state, {provider, now, days = 60, account = 0})` →
`{state, url, query}`. For Gmail `url` is a `#search/<query>` deeplink the UI
opens in the user's tab; Outlook web has no working search deeplink so `url`
is `null` and the UI shows `query` to paste. `stopMailScan(state)` clears
`scan`/`scanQueue` and keeps `scanned`.

While `state.scan` is for this provider and <24 h old:

- a `search` **list** view queues rows whose keys aren't in `state.scanned` or
  already queued → `{provider, key, subject ≤ 80 chars, url}` (cap 200; Gmail
  urls are `#all/<key>` deeplinks, Outlook `/mail/[0/]id/<key>`),
- **any** message view is allowed regardless of folder (the user opens queued
  threads from wherever they live).

Any message view, scan or not, drops its keys from the queue and records
`state.scanned[key] = at` (newest 1000 kept). Folder `"search"` is always
allowed. State grows only by `{scan, scanQueue, scanned}` — no content beyond
the 80-char queue subjects.

## Scope semantics

- A message view whose messages share one key → `email:<provider>:<key>`,
  which equals each item's `seenIn[].scope` — so a re-observed thread
  replaces only its own items.
- Any list view → `email:<provider>:list`, which no item ever carries, so a
  list observation can never delete message items.

## Privacy

- `content.js`/`dom.js`/`index.js` make no requests, no navigation, no
  storage, no token reads (enforced by a static test over `sources/email/*.js`).
- Message bodies, previews and sender emails are transient: items keep at
  most a ≤300-char keyword-sentence `evidence.snippet` plus sender *name*
  (`meta.fromName`, facts "From") — never `fromEmail`, never raw body text.
- Persisted `state` is `{lastSeenAt, counts: {[provider]: n}}` only.

## needs tuning (selectors — all best guesses)

Captured discovery was structural-only (no values); these are educated
guesses from common Gmail/OWA markup. Every reader fails soft.

- Gmail rows `tr.zA`, key `[data-legacy-thread-id]`, sender `.yW [email]`
  (name attr or text), subject `.bog`, preview `.y2` (leading `" - "` cut),
  time `.xW span[title]`; message view `h2.hP`, `div.adn` /
  `[data-legacy-message-id]`, sender `.gD[email]`, time `.g3[title]`,
  body `.a3s`; folder/view from `#<folder>/<id>` hash segments
  (`#search/<q>[/<id>]` → folder "search", id is the third segment; `#label/<n>[/<id>]`
  → label name); item URL rebuilt as `mail/u/<n>/#<folder>/<key>`.
- Invite cards: scope `[role="main"]`, detection regexes `CARD_WHEN_RE`,
  `CARD_CUE_RE`, `CARD_ORG_RE`, `CARD_UI_RE`, `CARD_STOP_RE`, the `M/D/YYYY`
  US-order assumption, one card per thread on the first Msg, and
  `<button>` counting as a line boundary.
- Scan: `GMAIL_SCAN_QUERY`/`OUTLOOK_SCAN_QUERY` strings, the 24 h scan TTL,
  `#all/<key>` and `/mail/[0/]id/<key>` queue deeplinks, 200/1000 caps.
- Outlook rows `[data-convid]` (prefer `[role=option]`), sender
  `span[title*="@"]`, time `time[datetime]` or a time-ish text line, subject
  = first non-sender/non-time line; message view `[role="main"]` with
  `[role="heading"]`, `[aria-label="Message body"]`,
  `[data-testid="SentReceivedSavedTime"]`, key from the
  `[aria-selected="true"]` row else the `/id/<id>` URL segment; folder from
  `data-folder-name` else the `/mail/` path (skip `0`).
- Link keep-list: `teams.microsoft.com/l/meetup-join`, `zoom.us/j/`,
  `meet.google.com/`, `waterlooworks.uwaterloo.ca`.
- Outlook message views may contain more than one `[data-convid]` doc (e.g.
  a thread pane); the single-key rule in `index.js` then falls back to the
  list scope rather than over-removing.

`parsers.js` stays a stub — there is no fetch tier to parse.
