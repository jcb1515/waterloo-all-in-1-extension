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
- `/api/v*/guilds/:id/messages/search` — search results

DOM extracts (`{v:1, type, location, ...}` sent by `content.js`):

- `inventory` — guild rail + channel sidebar (names, categories, types,
  unread/mention badges)
- `messages` — rendered chat messages of the open channel; `<time>`
  elements are re-inserted as `<t:unix>` markers so DOM and REST paths
  produce identical item ids
- `location` — on `/channels/@me/*` this is ALL that is sent (DM content
  is never read)
- `events` — TODO(events): scheduled-events modal, pending real captures

Every parse returns `scope: "discord"` with the filtered union plus
recurring suggestions, so the core's scope-mode fold keeps the store
atomic with the adapter's cache. `readOk: ["discord"]` marks a parsed
payload; `session: "signed-in"` on a 2xx REST read, `"signed-out"` on 401,
omitted for DOM payloads. `sync()` returns the cached union with
`session: "no-tab"`.

## Watched servers and channels

`rules.js` `SERVERS`: UWASIC, UWHPC, WATonomous (focus: electrical),
Waterloo Aerial Robotics Group / WARG (focus: electrical), ECE Waterloo '31.
Matched by guild name, case-insensitive exact match.

Channel score (name + category words): announcements/events/meetings/
schedule/deadlines/tasks/todo +3, general +2, electrical words +3 (+2 more
when the category also matches) for electrical-focus guilds, other subteam
words −2, off-topic/memes/bots/etc −5, voice/stage never suggested.
Suggested = score ≥ 3, top 12 per guild by score then sidebar order.

Settings (`ctx.settings`, W1's `wa1Settings.sources.discord`):

| Key | Effect |
|---|---|
| `enabled` | `false` disables output entirely |
| `watched` | `{[guildName]: {focus?, channels?}}` — a listed guild is watched even if not in SERVERS (team = guild name); a non-empty `channels` list REPLACES suggestions for that guild (names or ids) |
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
  messagesSeen, datesFound } } }
state.dmChannels = [channelId, …]              // ids seen under @me (cap 500)
state.lastGood.messages = { items, at }        // keyed by meta.messageId,
                                               // 45-day prune, cap 600
state.watch[guildId] = { channelIds, from }    // "settings" | "suggested"
state.sweep = { startedAt, done: {channelId: iso} }
state.sweepQueue = [{guildId, guildName, channelId, name, url}]
state.unreadWatched = [{guildId, guildName, channelId, name, url, mentions}]
state.unreadGuilds = [{guildId, name, mentions}]
state.meetingLog = [{guildId, channelId, key, startAt?, endAt?, url, at,
                     fromText?, weekday?, hhmm?}]   // cap 300, 120 days
state.identity = { selfId?, roleIds: [], evidence: n }
```

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
- Scheduled events: `TODO(events)` hooks in dom.js/content.js/index.js.
