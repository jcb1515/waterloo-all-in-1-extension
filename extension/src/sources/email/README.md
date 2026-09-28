# Email adapter (Outlook web + Gmail) — T3, DOM + one feed

Finds dated things in already-rendered mail: meeting/interview invites and
"important" mail (co-op, Learn, instructors, course-coded, keyworded) that
mention a date. The only network access is Gmail's unread-mail Atom feed
(see **Network**); OWA's tokened API was never captured, so Outlook stays
DOM-only and there are no `urlPatterns`. Everything arrives as a serialised
DOM extract from `content.js` (a bundled IIFE; bundled separately by
`tools/build.mjs`).

## Pipeline

- `content.js` — passive DOM reader. Runs on load, `hashchange`/`popstate`,
  and a MutationObserver debounced to 2s. Sends `MSG.OBSERVED` with
  `{source, kind: "dom", url, body: JSON.stringify(extract), at}` only when
  the extract has messages, deduped by body, capped at 2 MB, `.catch`-ed.
- `dom.js` — `extractFor(doc, href, {now})` → `{v, provider, folder, view,
  messages}`, one per host. `Msg = {key, url, from, fromEmail, subject,
  preview?, receivedText?, receivedAt?, body?, links, fromMe?}`. Bodies exist
  only in message view (≤20,000 chars, `<br>`/block boundaries → `\n`),
  previews ≤200 chars, `links` = Teams/Zoom/Meet/WaterlooWorks + booking
  hrefs with Google `url?q=` wrappers unwrapped. `receivedAt` = ISO Toronto
  from `parseListLabel` (short mail labels: `"3:14 PM"` → today, `"Fri
  [4:34 PM]"` → the most recent such weekday, `"Sep 25"` → this year else
  last, `"9/25/26"` → M/D/Y with YY = 20YY) against the extract's `now`,
  falling back to the textdates parse for full labels — so "tomorrow at
  3pm" in a week-old row resolves against its received date, not the
  machine clock. It also reads the signed-in **account address**
  (`accountEmail` — Gmail's `a[aria-label^="Google Account:"]` label's
  parenthesised email, Outlook's me-control) to flag `Msg.fromMe` and blank
  `fromEmail` on the user's own messages (Gmail's `"me"` sender text counts
  too); the address is compared in memory only, never serialised.
  Quoted-history containers (`.gmail_quote`, `blockquote`,
  `[id^="divRplyFwdMsg"]`) are excluded from body text.
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
    - `meta.employer` = `employerOf(fromEmail, fromName)`: the sender domain
      label (e.g. `acme`), or — on a personal domain (gmail, outlook,
      yahoo, icloud, proton, …) — the cleaned display name ("Sam Lee"),
      never `"gmail"`. Set on interviews and co-op mail so core can link the
      item to a WaterlooWorks application.
    - Gmail invite items get `meta.onCalendar = "google"`: Google already puts
      Gmail invitations on the user's Google Calendar, so the publisher skips
      them (opt back in with `settings.gmailInvitesToFeed: true`).
  - **Important mail → review items.** A message qualifies when
    `gate.ok || !isBulk(msg)`: `senderGate` covers WaterlooWorks/co-op,
    Learn, a `courses[].instructors[].email` match, a course code in the
    subject, `settings.teams`/`settings.senders` substrings, and — via
    `ctx.applications` (array or id-keyed map of
    `{employer, jobTitle, jobId, status}`) — an employer match
    (`titleSimilarity(employer, display-name-or-domain-label) >= 0.6`, or a
    ≥4-char domain label equal to an employer token →
    `{ok, coop, employer, jobId}`; items then carry `org = employer`,
    `meta.employer`, `meta.jobId`). `isBulk` is a no-reply/newsletter-style
    local part or footer boilerplate (`unsubscribe`, `view … in browser`,
    `manage … preferences`); bulk + ungated → `[]`, so a newsletter's own
    dates never reach the calendar while `noreply@learn.uwaterloo.ca` still
    does. The old subject-keyword requirement is gone — a date's *sentence*
    must still contain a keyword. Keyword set: interview, offer, rank(ing),
    deadline, due, extension, midterm, exam, room change, cance(l)led,
    rescheduled, meeting, tapeout, design review, rsvp, invited, invitation,
    register, registration, event, meet, call, phone (screen), chat, coffee
    chat, sync, catch up, availab(le|ility), (re)schedule, office hours,
    info session, workshop, assessment, coding/online assessment, hirevue,
    onsite, zoom, teams/google meet, calendly, book, confirm, reminder,
    action required, plus case-sensitive `\bOA\b` ∪ `settings.keywords`.
    Date hits come from `textDates(subject + "\n" + body|preview)`,
    confidence ≥0.6, not ended before `receivedAt − 1d`; max 3 per message,
    one per Toronto day. `TYPE_RULES` order: interview (interview|phone
    screen|screen(ing)|hirevue|onsite) → offer-deadline → cycle-date →
    rsvp/register-by deadline → assessment (online assessment|coding
    challenge|`\bassessment\b`|`\bOA\b` → deadline + `category
    "assessment"`) → exam → meeting (meet(ing)|call|phone|chat|coffee|sync|
    catch up|zoom|teams/google meet|design review|tapeout|availab|
    (re)schedul; promoted to `interview` when the gate is co-op/employer or
    the subject says interview|screen) → event (office hours|info session|
    workshop) → deadline (due|deadline|extension) → event. Timed hits give
    `startAt`/`endAt` or `dueAt` (all-day deadline → 23:59 ET). Always
    `tentative`/`pending`; `id = <provider>:mail:<key>:<instant>`.
    `exam` items take the outline/Portal titles ("Midterm"/"Final exam" when
    `classify` finds one in the sentence or subject) plus
    `details = "Email: " + cleanedSubject`, so they merge with the real exam.
  - **Reply-needed tasks.** `taskItems` scans each message view's
    non-from-me, non-invite-producing, `gate.ok || !isBulk` messages for an
    ask — `REPLY_RE` phrasing (`please reply|respond|confirm`, `let me
    know`, `get back to me`, `are you available|free`, `what times work`,
    `when are|would you be free|available`, `rsvp`) or a sentence ending in
    `?` that mentions `you` — with the body first cut at quoted-history
    lines (`On … wrote:`, `From: …`, `--- Original Message ---`). The
    latest ask wins → `<provider>:reply:<threadKey>`, type `task`,
    category `reply`, title `"Reply to <name>: <cleaned subject>"`,
    `dueAt` = an explicit `by <date>` in the ask sentence (all-day → 23:59
    ET) else `askedAt + 2 days` at 17:00 Toronto, `review` auto when gated
    else pending. State: `state.replies[key] = {id, title, dueAt, askedAt,
    review, url, status, doneAt?}` (cap 300, newest by askedAt). **Done**
    when a from-me message follows the ask (later `receivedAt`, or later
    DOM order when times are missing), a sent-folder list row (`sent`,
    `sentitems`, `sent items` — which never produce other items) carries a
    known open key, or a message view of only from-me messages revisits a
    known key. A done reply reopens only on a newer ask (`askedAt >
    doneAt`).
  - **Book-a-call tasks.** An eligible message with a booking link
    (`calendly.com/`, `calendar.app.google/`,
    `calendar.google.com/calendar/appointments`,
    `outlook.office.com/bookwithme`, `outlook.office365.com/owa/calendar/…/bookings`,
    `/bookings/`) or wording (`BOOK_RE`: `schedule a call|time|meeting|
    chat`, `book a time|call|slot|meeting`, `pick a time`, `find a time`)
    yields `<provider>:book:<threadKey>`, `type task`,
    `category "book-call"`, `url` = the booking link, same default due and
    review rule. A message that produced an invite item emits none. State:
    `state.bookings[key] = {id, title, dueAt, url, senderHash, review,
    status}` — `senderHash` is `hashString(fromEmail)` so the address is
    never stored (cap 200). **Done** when an invite item arrives from the
    same threadKey, or from a message whose sender hash matches — the
    invite answers the ask.

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
- Bulk/gate regexes: the `no-?reply|do-?not-?reply|notifications?|
  newsletters?` local part, the `unsubscribe|view … in browser|manage …
  preferences` footer set, `PERSONAL_DOMAINS`, the case-sensitive `\bOA\b`,
  the `titleSimilarity >= 0.6` employer threshold, and `parseListLabel`'s
  label formats + "this year else last" year pick.
- Account/privacy: `ACCOUNT.gmail` (the `aria-label^="Google Account:"`
  anchor's parenthesised email), `ACCOUNT.outlook` (`#mectrl_…secondary`,
  `[data-testid=…]`, `header button[aria-label*="@"]`), Gmail's literal
  `"me"` sender text, `QUOTE_SEL` (`.gmail_quote`, `blockquote`,
  `[id^="divRplyFwdMsg"]`) and the `QUOTE_CUT_RE` line patterns.
- Reply/book triggers: `REPLY_RE`, the "?"-sentence-with-`you` rule,
  `BOOK_RE` wording, `BOOK_LINK` hosts (incl. the generic `/bookings/`
  path), `SENT_FOLDERS`, the +2-days-at-17:00-ET default due, and the
  300/200 reply/booking caps.
- Outlook message views may contain more than one `[data-convid]` doc (e.g.
  a thread pane); the single-key rule in `index.js` then falls back to the
  list scope rather than over-removing.

`parsers.js` stays a stub — there is no fetch tier to parse.

## Network

`atom.js` is the one exception to the passive rule, and only on
`mail.google.com`: the user's own unread-mail feed. While a Gmail tab is
open and not frozen, `atomRound` does **one** request — `GET
/mail/u/<n>/feed/atom` (the `<n>` comes from the page path, default 0) —
same-origin relative URL, `credentials: "same-origin"`, 15 s timeout. A
response that isn't `200` + XML content-type, or that redirected (the
sign-in page), stops the round and sends nothing.

Entries map to the same `Msg` shape list rows produce (`key` = the
`message_id=` link param or `<id>` tail, `subject` = `<title>`, `preview` =
`<summary>`, `receivedAt` = `<issued>`, `from`/`fromEmail` =
`<author>`) and are replayed as the exact `wa1:observed` `kind:"dom"`
payload the passive reader sends, with `view: "atom"` and `folder:
"inbox"`. The observe scope is `email:gmail:atom` — no item's `seenIn`
scope ever equals it, so an entry leaving the unread feed can never delete
its item (entries are additive; opening the thread upgrades them in place
because the ids are the same `gmail:<key>:…` family).

Privacy: the feed-level `<title>`/`<tagline>` contain the account address
and are never read — only `<entry>` children are parsed. `author/email`
feeds the same sender/bulk gates as list rows and is never stored in items
or state. There are no tokens and no `chrome.storage` writes; the throttle
is a `sessionStorage["wa1:gmail:atomAt"]` stamp (`{at, ok}`: 30 min after a
success, 5 min retry after any failure). A Page Lifecycle `freeze` bumps a
generation so an in-flight fetch that settles late is dropped, never
double-sent; `resume`/`visibilitychange` continue where the tab left off.

`content.js` wires this only for `location.hostname === "mail.google.com"`;
the static test in `test/email/adapter.test.js` fails on any other
`fetch(`/XHR/URL in `email/**`.

## Probe / checklist

`probe.js` (`probe(doc, href)` → `{page, counts, ok, hints}`) backs W1's
"Check readers" screen — selector-hit **counts only**, never text, names,
ids or addresses. Page kinds mirror `extractFor`'s view split:
`gmail-list`/`gmail-message`/`outlook-list`/`outlook-message` (plus
`-other` for a known host on a non-mail path, `unknown` for anything else).
`ok` needs the selectors each view actually parses (list: rows + subjects;
message: messages + a body). `account` counts 1 when the signed-in address
was detected (compare-only, never emitted). `CHECKLIST` lists the pages a
user should open — `{id, label, how, page}` where `page` is the probe page
kind that ticks the item.
