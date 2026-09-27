# Discord adapter

Passive-only adapter that turns Discord chatter in watched design-team
servers into candidate calendar items (meetings, deadlines, tasks, events)
plus weekly-meeting suggestions.

## Hard rules — enforced by code, not convention

1. **Never send a request to Discord.** No `fetch`, `XMLHttpRequest`, or
   `WebSocket` anywhere in `discord/` — not in `content.js`, not in
   `index.js`. All data arrives as `wa1:observed` payloads.
2. **Never read or store the user's token.** No `localStorage`,
   `sessionStorage`, `document.cookie`, or webpack-module access.
3. **No automatic navigation or clicks.** `content.js` only reads the DOM.
4. **Message bodies are never persisted.** Only a ≤300-char snippet (the
   sentence containing the matched date/trigger) lands on an item.
5. **No author names/ids are persisted** — except the user's own inferred
   self id (`state.identity.selfId`).

`test/discord/static.test.js` greps the sources for the forbidden APIs.

## Data flow

```
Discord page ──REST responses──> recorder.content.js ──net payload──┐
              └─DOM extracts──> sources/discord/content.js ──dom payload──┤
                                        │                               ▼
                            core/scheduler.js → adapter.observe.parse(payload, ctx)
                                        │
                                        ▼
                       applyResult(raw, result, {mode:"scope", scope:"discord"})
```

`observe.urlPatterns` (GET only; non-GET and non-2xx are ignored, 401 means
`session: "signed-out"`):

- `/api/v*/channels/:id/messages` — channel history (sweep reads)
- `/api/v*/channels/:id/messages/pins` — pins
- `/api/v*/users/@me/mentions` — pings; also drives identity inference
- `/api/v*/users/@me/scheduled-events` — the user's RSVP'd event ids
  (`state.rsvps`); an event whose id is listed counts as Interested even
  when the DOM button heuristic fails
- `/api/v*/guilds/:id/messages/search` — search results

DOM extracts (`{v:1, type, location, ...}` sent by `content.js`):

- `inventory` — guild rail + channel sidebar (names, categories, types,
  unread/mention badges)
- `messages` — rendered chat messages of the open channel; `<time>`
  elements are re-inserted as `<t:unix>` markers so DOM and REST paths
  produce identical item ids
- `location` — on `/channels/@me/*` this is ALL that is sent (DM content
  is never read)
- `events` — the scheduled-events modal (`{modal:"list"|"detail",
  guildName, cards:[{lines:[{text,heading,icon}], interested, eventRef}]}`).
  Event definitions travel over the gateway, so the recorder never sees
  them — `content.js` reads the open `[role="dialog"]` instead. Cards are
  split by each card's "Copy Link" button; `Created by` lines and
  Interested-tab member rows are dropped at extraction so no names leave
  the page.

Every parse returns `scope: "discord"` with the filtered union plus
recurring suggestions, so the core's scope-mode fold keeps the store
atomic with the adapter's cache. `readOk: ["discord"]` marks a parsed
payload; `session: "signed-in"` on a 2xx REST read, `"signed-out"` on 401,
omitted for DOM payloads. `sync()` returns the cached union with
`session: "no-tab"`.

## Watched servers and channels

There is no built-in server list — the adapter works for any student's
servers. The watched set comes entirely from settings:

- `settings.watched` empty/missing → **every** guild seen in the rail is
  watched, no focus (channel suggestions + pings only; team = guild name).
- `settings.watched` non-empty → **only** those guilds are watched. Guild
  names match case-insensitively after trimming; `team` = the name as
  written in settings; `focus` comes from the entry. The user's own list
  lives in the gitignored dev-profile as
  `sources.discord.watched = {"<guild name>": {focus: [...], channels: []}}`.

Channel score (name + category words): announcements/events/meetings/
schedule/deadlines/tasks/todo +3, general +2, focus words +3 (+2 more
when the category also matches) for focused guilds, other-subteam words
−2 (a word the guild focuses on is never penalised — `focus:
["mechanical"]` boosts mech channels), off-topic/memes/bots/etc −5,
voice/stage never suggested. `focus: ["electrical"]` expands to a
vocabulary (elec, ee, hardware, pcb, embedded, firmware, …); any other
focus word matches itself. Suggested = score ≥ 3, top 12 per guild by
score then sidebar order. Sweep order: `settings.watched` insertion
order, then the remaining guilds alphabetically.

Settings (`ctx.settings`, W1's `wa1Settings.sources.discord`):

| Key | Effect |
|---|---|
| `enabled` | `false` disables output entirely |
| `watched` | `{[guildName]: {focus?, channels?}}` — non-empty = exclusive watch list (see above); a non-empty `channels` list REPLACES suggestions for that guild (names or ids) |
| `userId` | overrides inferred self id |
| `roleIds` | extends inferred role ids |
| `keywords` | extra trigger words (act as meeting triggers) |

## Candidate extraction (`messages.js`)

For each default/reply message: exact `<t:unix[:style]>` dates (d/D styles
become all-day on the Toronto day) plus textdates hits (confidence ≥ 0.6,
not > 1 day before the message). Triggers decide the type — first match
wins: assigned task verb → `task`; deadline word or "by <date>" →
`deadline`; meeting word → `meeting`; bare `<t:>` in a watched channel →
`event`. No trigger → no item. An assigned task with no date gets
`dueAt = sent + 7d` with `meta.undated`. All items are `review: "pending"`.

Assigned-to-me = direct mention of selfId, a role ping of a known role,
the DOM "mentioned" highlight, or any mentions-endpoint message that isn't
a bare @everyone.

Identity inference (`identity.js`): mentions-endpoint messages that ping
the user directly intersect their `mentions[].id` sets to a single selfId;
once known, mentions messages not mentioning selfId are role pings.

## State shape

```js
state.guilds[guildId] = { name, team|null, focus?, unread, mentions,
  lastInventoryAt, channels: { [channelId]: { name, type, category,
  limited, unread, mentions, order, oldestSeenId, newestSeenId,
  messagesSeen, datesFound } } }   // caps: 50 guilds, 250 channels per guild
state.dmChannels = [channelId, …]              // ids seen under @me (cap 500)
state.lastGood.messages = { items, at }        // keyed by meta.messageId,
                                               // 45-day prune, cap 600
state.watch[guildId] = { channelIds, from }    // "settings" | "suggested"
state.sweep = { startedAt, done: {channelId: iso} }  // done capped at 12 500
state.sweepQueue = [{guildId, guildName, channelId, name, url}]
state.unreadWatched = [{guildId, guildName, channelId, name, url, mentions}]
state.unreadGuilds = [{guildId, name, mentions}]
state.meetingLog = [{guildId, channelId, key, startAt?, endAt?, url, at,
                     fromText?, weekday?, hhmm?}]   // cap 300, 120 days
state.rsvps = [eventId, …]                          // cap 500
state.lastGood.events[guildId] = { items, at }      // scheduled events;
                                                    // 50 guilds, 100 items each
state.identity = { selfId?, roleIds: [], evidence: n }
```

Scheduled events (`events.js`): a list-modal read replaces the guild's
event set wholesale; a detail read replaces only that `meta.series`.
Items are `type:"meeting", category:"scheduled-event"` with ids
`discord:event:<guild>:<slug>` (one-shot) or `…:<YYYY-MM-DD>` (series).
Interested (button or RSVP list) → `review:"auto"`, every listed
occurrence plus weekly-generated tentative ones up to 6 weeks out;
otherwise one pending item for the next occurrence
(`meta.pendingSeries`). A series suppresses message-derived recurring
suggestions on the same (guild, weekday, HH:MM) slot.

Items from a channel the inventory hasn't mapped yet are stored (a REST
read before the first inventory isn't lost) but hidden from output and
expired after 2 days. DM-channel items are purged on sight and never
re-stored. The output filter shows an item when its guild is watched AND
(its channel is watched OR the message pinged me OR that guild has no
channel inventory yet); org/url/location are re-resolved at output.

`resetSweep(state, now)` restarts the sweep; `inventoryReport(state)`
returns the no-ids/no-text tuning report (guild/channel names, scores,
watch source, message/date counts, identity status).

## Recurring suggestions (`recurring.js`)

Meeting candidates logged in `meetingLog` group by (guild, normalized key,
Toronto weekday, HH:MM); ≥ 2 distinct ISO weeks → one weekly suggestion
(`meta.recurrence = {freq:"WEEKLY", byDay, time, tz, weeks, occurrences}`).
An explicit "every Tuesday at 6pm" line in a meeting-trigger message is a
suggestion on its own (`weeks: 0, fromText: true`).

## Needs tuning at CP2

- Every selector in `selectors.js` is a best guess from the discovery
  report + accessibility attributes — verify against live DOM.
- Whether Discord renders `<t:>` markers as `<time datetime>` inside
  message content is UNVERIFIED. `dom.js` collects those `time` elements
  into `times`; if the attribute/element guess is wrong the DOM path still
  extracts dates from the rendered text (tentative confidence), it just
  loses the exact-instant fast path.
- `settings.keywords` classify as meeting triggers; if users expect a
  keyword to make deadlines, split the setting.
- Only the FIRST date hit per message produces an item; multi-date
  messages ("Monday and Wednesday") collapse to the first.
- Guild/channel names come from aria-label prefixes — locale strings other
  than en need their own `GUILD_LABEL_PREFIX_RE`.
- Events modal markup is unverified against live Discord: card split via
  "Copy Link" buttons, `INTERESTED_ON_RE` class heuristic, heading/icon
  line flags, and the member-list skip selector
  (`EVENT_MEMBER_ROW_SEL`) all need tuning at CP2. If Interested-button
  state is unreliable the RSVP REST read covers it.
- `Time:`/`Location:` announcement lines upgrade an all-day date hit to a
  timed, located item (timezone labels ignored — always Toronto wall
  time).

## Maintaining

**Where the selectors and regexes live.** `selectors.js` holds every DOM
selector and regex: the guild rail / channel sidebar rows, message rows,
the events-modal card structure (`EVENT_*`, `INTERESTED_ON_RE`), the
REST `OBSERVE_URL_PATTERNS`, and the events-modal date-line grammar.
`dom.js` reads those selectors into extracts; `events.js`,
`messages.js` and `recurring.js` turn extracts into Items; `rules.js`
owns the watch config, channel scoring and trigger vocabulary; `time.js`
holds the loose "5:00 PM" clock parser shared by messages and recurring.
`content.js` is extraction only (no imports, no requests).

**Turning a saved page into a fixture.** Save the page with the relevant
DOM open (guild rail + sidebar, the chat pane, or the events modal),
redact, then drop it into `test/fixtures/discord/`. Redaction rules: no
real server or channel names (placeholders like "Robotics Club",
`#general`); no user names, avatars or ids; no message bodies —
placeholder text only; no tokens or CDN urls carrying auth params; use
placeholder snowflakes (`100000000000000001`). Raw captures stay outside
git in `captures/` (gitignored).

**Tests.** `node --test "test/discord/*.test.js"` runs everything; one
file with `node --test test/discord/<name>.test.js`. `dom.test.js` — the
DOM readers against the html fixtures; `events.test.js` — events-modal
parsing and items; `messages.test.js` — candidate extraction including
the `Time:`/`Location:` upgrades; `normalize.test.js` — REST body
normalization; `recurring.test.js` — weekly suggestions;
`rules.test.js` — watch config + channel scoring; `identity.test.js` —
selfId/role inference; `adapter.test.js` — end-to-end parse/sync and the
REST-vs-DOM dedupe; `static.test.js` — greps the sources for forbidden
APIs (the passive-only guarantee); `fuzz.test.js` — ~300 malformed
payloads plus a 1000-read growth bound.

**Open / needs tuning.** The list above is current — highlights: the
events-modal markup is unverified against live Discord, the
Interested-button state heuristic may misread, whether `<t:>` markers
render as `<time datetime>` in message content is unconfirmed, and the
sidebar aria-label attributes are en-only guesses.
