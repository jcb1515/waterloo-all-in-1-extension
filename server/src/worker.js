// Based on gurshh-rain/uwlearn_assignment_extension calendar-service (MIT, Gurshaan Gill)
//
// Waterloo All-in-1 calendar feed. The extension publishes its merged item
// list here (POST /v1/calendars, PUT /v1/calendars/<id>.ics); calendar clients
// such as Google Calendar subscribe to the returned .ics URLs (GET), including
// the per-group alias feeds. Feed state lives in Cloudflare D1.

const FEED_LIFETIME_SECONDS = 365 * 24 * 60 * 60;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 3000;
const MAX_SKIPPED = 20;
const MAX_ALARMS = 3;
const MAX_ALARM_MINUTES = 40320; // four weeks
const TOMBSTONE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_TOMBSTONES = 5000;
const DEFAULT_CALENDAR_NAME = "Waterloo All-in-1";
const DEFAULT_TIME_ZONE = "America/Toronto";
const UID_SUFFIX = "@waterloo-all-in-1";
const encoder = new TextEncoder();

// mirror of contract.js ITEM_TYPES
const ITEM_TYPES = new Set([
  "deadline", "quiz", "exam", "presentation", "class", "tutorial", "lab", "meeting",
  "interview", "application-deadline", "offer-deadline", "cycle-date", "task", "event", "term-date",
]);

const ITEM_STATUSES = new Set(["open", "submitted", "done", "cancelled"]);

const FEED_GROUPS = Object.freeze({
  classes: "Classes",
  deadlines: "Deadlines & exams",
  coop: "Co-op",
  teams: "Teams",
  other: "Other",
});

const TYPE_GROUPS = Object.freeze({
  class: "classes", tutorial: "classes", lab: "classes",
  deadline: "deadlines", quiz: "deadlines", exam: "deadlines", presentation: "deadlines", task: "deadlines",
  interview: "coop", "application-deadline": "coop", "offer-deadline": "coop", "cycle-date": "coop",
  meeting: "other", event: "other", "term-date": "other",
});

const TYPE_LABELS = Object.freeze({
  deadline: "Deadline", quiz: "Quiz", exam: "Exam", presentation: "Presentation",
  class: "Class", tutorial: "Tutorial", lab: "Lab", meeting: "Meeting", interview: "Interview",
  "application-deadline": "Application deadline", "offer-deadline": "Offer deadline",
  "cycle-date": "Cycle date", task: "Task", event: "Event", "term-date": "Term date",
});

const SOURCE_LABELS = Object.freeze({
  learn: "Learn", outline: "Course outline", portal: "Portal", waterlooworks: "WaterlooWorks",
  discord: "Discord", outlook: "Outlook", gmail: "Gmail", manual: "Added by you",
});

const STATUS_LABELS = Object.freeze({ submitted: "Submitted", done: "Done", cancelled: "Cancelled" });

// SQL kept as named constants so tests can dispatch on the exact strings.
export const SQL = Object.freeze({
  insertFeed:
    "INSERT INTO calendar_feeds (id, update_token_hash, calendar_json, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  selectFeedForRead:
    "SELECT calendar_json, expires_at, updated_at FROM calendar_feeds WHERE id = ?",
  selectFeedForWrite:
    "SELECT update_token_hash, calendar_json, updated_at FROM calendar_feeds WHERE id = ?",
  updateFeed:
    "UPDATE calendar_feeds SET calendar_json = ?, expires_at = ?, updated_at = ? WHERE id = ?",
  deleteFeed: "DELETE FROM calendar_feeds WHERE id = ?",
  deleteExpiredFeeds: "DELETE FROM calendar_feeds WHERE expires_at <= ?",
  countLiveFeeds: "SELECT COUNT(*) AS n FROM calendar_feeds WHERE expires_at > ?",
  insertAlias: "INSERT INTO calendar_feed_aliases (id, feed_id, feed_group) VALUES (?, ?, ?)",
  selectAlias: "SELECT feed_id, feed_group FROM calendar_feed_aliases WHERE id = ?",
  selectFeedAliases: "SELECT id, feed_group FROM calendar_feed_aliases WHERE feed_id = ?",
  deleteFeedAliases: "DELETE FROM calendar_feed_aliases WHERE feed_id = ?",
  deleteOrphanAliases:
    "DELETE FROM calendar_feed_aliases WHERE feed_id NOT IN (SELECT id FROM calendar_feeds)",
});

export default {
  async fetch(request, env, context) {
    try {
      return await routeRequest(request, env, context);
    } catch {
      return jsonResponse({ error: "Calendar service request failed." }, 500);
    }
  },
  async scheduled(event, env, context) {
    context.waitUntil((async () => {
      await env.DB.prepare(SQL.deleteExpiredFeeds).bind(Date.now()).run();
      await env.DB.prepare(SQL.deleteOrphanAliases).bind().run();
    })());
  }
};

async function routeRequest(request, env, context) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method === "GET" && url.pathname === "/health") {
    const row = await env.DB.prepare(SQL.countLiveFeeds).bind(Date.now()).first();
    return jsonResponse({ ok: true, feeds: row?.n ?? 0 });
  }
  if (request.method === "POST" && url.pathname === "/v1/calendars") {
    return createFeed(request, env, url.origin);
  }

  const match = url.pathname.match(/^\/v1\/calendars\/([A-Za-z0-9_-]{20,})\.ics$/);
  if (!match) return jsonResponse({ error: "Not found." }, 404);
  const feedId = match[1];
  if (request.method === "GET") return readFeed(feedId, env, context);
  if (request.method === "PUT") return updateFeed(request, feedId, env, url.origin);
  if (request.method === "DELETE") return deleteFeed(request, feedId, env);
  return jsonResponse({ error: "Method not allowed." }, 405);
}

async function createFeed(request, env, origin) {
  const parsed = await readPayload(request);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);

  const { state, accepted, skipped } = applyPublish(null, parsed.payload, new Date());
  const feedId = randomToken(24);
  const updateToken = randomToken(32);
  const updateTokenHash = await hashToken(updateToken);
  const now = Date.now();
  const expiresAt = now + FEED_LIFETIME_SECONDS * 1000;
  await env.DB.prepare(SQL.insertFeed)
    .bind(feedId, updateTokenHash, JSON.stringify(state), expiresAt, now).run();
  const aliases = await ensureAliases(env, feedId);

  return jsonResponse({
    feedId,
    updateToken,
    feedUrl: `${origin}/v1/calendars/${feedId}.ics`,
    groupFeeds: groupFeedsResponse(origin, aliases),
    expiresAt: new Date(expiresAt).toISOString(),
    accepted,
    skipped
  }, 201);
}

async function updateFeed(request, feedId, env, origin) {
  const record = await env.DB.prepare(SQL.selectFeedForWrite).bind(feedId).first();
  if (!record) return jsonResponse({ error: "Calendar feed not found." }, 404);
  if (!(await isAuthorized(request, record.update_token_hash))) {
    return jsonResponse({ error: "Invalid update token." }, 401);
  }

  const parsed = await readPayload(request);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
  const prevState = stateFromStored(safeJsonParse(record.calendar_json), record.updated_at);
  const { state, accepted, skipped } = applyPublish(prevState, parsed.payload, new Date());
  const now = Date.now();
  const expiresAt = now + FEED_LIFETIME_SECONDS * 1000;
  await env.DB.prepare(SQL.updateFeed)
    .bind(JSON.stringify(state), expiresAt, now, feedId).run();
  const aliases = await ensureAliases(env, feedId);

  return jsonResponse({
    feedId,
    feedUrl: `${origin}/v1/calendars/${feedId}.ics`,
    groupFeeds: groupFeedsResponse(origin, aliases),
    expiresAt: new Date(expiresAt).toISOString(),
    accepted,
    skipped
  });
}

async function readFeed(feedId, env, context) {
  let group;
  let record = await env.DB.prepare(SQL.selectFeedForRead).bind(feedId).first();
  if (!record) {
    const alias = await env.DB.prepare(SQL.selectAlias).bind(feedId).first();
    if (!alias) return jsonResponse({ error: "Calendar feed not found." }, 404);
    group = alias.feed_group;
    feedId = alias.feed_id;
    record = await env.DB.prepare(SQL.selectFeedForRead).bind(feedId).first();
    if (!record) return jsonResponse({ error: "Calendar feed not found." }, 404);
  }
  if (record.expires_at <= Date.now()) {
    context?.waitUntil((async () => {
      await env.DB.prepare(SQL.deleteFeed).bind(feedId).run();
      await env.DB.prepare(SQL.deleteFeedAliases).bind(feedId).run();
    })());
    return jsonResponse({ error: "Calendar feed expired." }, 410);
  }

  const state = stateFromStored(safeJsonParse(record.calendar_json), record.updated_at);
  const calendar = buildCalendar(state, group ? { group } : {});
  return new Response(calendar, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": "inline; filename=waterloo-all-in-1.ics",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function deleteFeed(request, feedId, env) {
  const record = await env.DB.prepare(SQL.selectFeedForWrite).bind(feedId).first();
  if (!record) return jsonResponse({ error: "Calendar feed not found." }, 404);
  if (!(await isAuthorized(request, record.update_token_hash))) {
    return jsonResponse({ error: "Invalid update token." }, 401);
  }
  await env.DB.prepare(SQL.deleteFeed).bind(feedId).run();
  await env.DB.prepare(SQL.deleteFeedAliases).bind(feedId).run();
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function ensureAliases(env, feedId) {
  const existing =
    (await env.DB.prepare(SQL.selectFeedAliases).bind(feedId).all()).results || [];
  const have = new Set(existing.map((alias) => alias.feed_group));
  const created = [];
  for (const group of Object.keys(FEED_GROUPS)) {
    if (have.has(group)) continue;
    const id = randomToken(24);
    await env.DB.prepare(SQL.insertAlias).bind(id, feedId, group).run();
    created.push({ id, feed_group: group });
  }
  return [...existing, ...created];
}

function groupFeedsResponse(origin, aliases) {
  const groupFeeds = {};
  for (const alias of aliases) {
    groupFeeds[alias.feed_group] = {
      feedId: alias.id,
      feedUrl: `${origin}/v1/calendars/${alias.id}.ics`
    };
  }
  return groupFeeds;
}

async function readPayload(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_PAYLOAD_BYTES) {
    return { ok: false, status: 413, error: "Calendar payload is too large." };
  }
  const text = await request.text();
  if (encoder.encode(text).length > MAX_PAYLOAD_BYTES) {
    return { ok: false, status: 413, error: "Calendar payload is too large." };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: "Request body must be valid JSON." };
  }

  let events = null;
  if (body && typeof body === "object" && Object.hasOwn(body, "events")) {
    if (Array.isArray(body.events)) events = body.events;
  } else if (body && Array.isArray(body.assignments)) {
    // legacy v1 payload from gurshh feeds
    events = convertLegacyAssignments(body.assignments);
  }
  if (!events) return { ok: false, status: 400, error: "events must be an array." };
  if (events.length > MAX_EVENTS) {
    return { ok: false, status: 413, error: `Too many events; the limit is ${MAX_EVENTS}.` };
  }
  return {
    ok: true,
    payload: {
      calendarName: body.calendarName,
      timeZone: body.timeZone,
      alarms: body.alarms,
      events
    }
  };
}

// gurshh assignment {id, courseId, name, courseName, dueDate, url} -> FeedEvent.
// Keeps the `${courseId}-${id}@learn.uwaterloo.ca` UIDs v1 feeds already published.
function convertLegacyAssignments(assignments) {
  return assignments.map((assignment) => {
    if (!assignment || typeof assignment !== "object") return assignment;
    const hasIds = assignment.id != null && assignment.courseId != null;
    return {
      id: hasIds ? `learn:${assignment.courseId}:${assignment.id}` : assignment.id,
      type: "deadline",
      title: assignment.name,
      org: assignment.courseName,
      dueAt: assignment.dueDate,
      url: assignment.url,
      source: "learn",
      calendar: hasIds
        ? { uid: `${assignment.courseId}-${assignment.id}@learn.uwaterloo.ca` }
        : undefined
    };
  });
}

/**
 * Merges a publish payload into the stored feed state. Pure (no D1) so tests
 * can drive it directly. Returns the next state plus publish stats.
 * @param {object|null} prevState
 * @param {object} payload  Raw request body fields: calendarName, timeZone, alarms, events
 * @param {Date} now
 */
export function applyPublish(prevState, payload, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIso = nowDate.toISOString();
  const body = payload && typeof payload === "object" ? payload : {};
  const calendarName = clampText(body.calendarName, 100) || DEFAULT_CALENDAR_NAME;
  const timeZone = validTimeZone(body.timeZone) || DEFAULT_TIME_ZONE;
  const typeAlarms = normalizeAlarmMap(body.alarms);

  const seenUids = new Set();
  const entries = [];
  const skipped = [];
  for (const raw of Array.isArray(body.events) ? body.events : []) {
    const result = normalizeEvent(raw, typeAlarms, seenUids);
    if (!result.event) {
      if (skipped.length < MAX_SKIPPED) {
        skipped.push({ id: result.skippedId, reason: result.reason });
      }
      continue;
    }
    seenUids.add(result.event.uid);
    entries.push(result);
  }

  const prev = prevState && typeof prevState === "object" ? prevState : {};
  const prevSeqs = prev.seqs && typeof prev.seqs === "object" ? prev.seqs : {};
  const tombstones = {
    ...(prev.tombstones && typeof prev.tombstones === "object" ? prev.tombstones : {})
  };

  const seqs = {};
  const events = [];
  for (const { event, clientSeq } of entries) {
    const hash = stableHash(JSON.stringify(event));
    const prevEntry = prevSeqs[event.uid];
    const tombstone = tombstones[event.uid];
    let seq;
    let at;
    if (prevEntry && prevEntry.hash === hash) {
      seq = Math.max(prevEntry.seq ?? 0, clientSeq);
      at = prevEntry.at || nowIso;
    } else if (prevEntry) {
      seq = Math.max((prevEntry.seq ?? 0) + 1, clientSeq);
      at = nowIso;
    } else if (tombstone) {
      seq = Math.max((tombstone.seq ?? 0) + 1, clientSeq);
      at = nowIso;
      delete tombstones[event.uid];
    } else {
      seq = clientSeq;
      at = nowIso;
    }
    seqs[event.uid] = { hash, seq, at };
    events.push(event);
  }

  for (const [uid, entry] of Object.entries(prevSeqs)) {
    if (seqs[uid] || tombstones[uid]) continue;
    tombstones[uid] = {
      hash: entry.hash,
      seq: entry.seq ?? 0,
      at: entry.at || nowIso,
      removedAt: nowIso
    };
  }
  pruneTombstones(tombstones, nowDate);

  return {
    state: { version: 2, calendarName, timeZone, events, seqs, tombstones },
    accepted: events.length,
    skipped
  };
}

function pruneTombstones(tombstones, now) {
  const cutoff = now.getTime() - TOMBSTONE_MAX_AGE_MS;
  const kept = [];
  for (const [uid, tombstone] of Object.entries(tombstones)) {
    const removedAt = Date.parse(tombstone.removedAt || "");
    if (Number.isFinite(removedAt) && removedAt < cutoff) {
      delete tombstones[uid];
    } else {
      kept.push([uid, Number.isFinite(removedAt) ? removedAt : 0]);
    }
  }
  if (kept.length > MAX_TOMBSTONES) {
    kept.sort((a, b) => a[1] - b[1]);
    for (const [uid] of kept.slice(0, kept.length - MAX_TOMBSTONES)) {
      delete tombstones[uid];
    }
  }
}

/**
 * Stored calendar_json -> feed state. Handles legacy v1 rows (a plain array of
 * gurshh assignments) so old feeds keep rendering with their original UIDs.
 */
function stateFromStored(json, updatedAt) {
  const base = {
    version: 2,
    calendarName: DEFAULT_CALENDAR_NAME,
    timeZone: DEFAULT_TIME_ZONE,
    events: [],
    seqs: {},
    tombstones: {}
  };
  if (Array.isArray(json)) {
    const at = new Date(Number(updatedAt) || Date.now()).toISOString();
    const seenUids = new Set();
    for (const raw of convertLegacyAssignments(json)) {
      const { event } = normalizeEvent(raw, {}, seenUids);
      if (!event) continue;
      seenUids.add(event.uid);
      base.events.push(event);
      base.seqs[event.uid] = { hash: "", seq: 0, at };
    }
    return base;
  }
  if (json && typeof json === "object" && json.version === 2 && Array.isArray(json.events)) {
    return {
      version: 2,
      calendarName: json.calendarName || DEFAULT_CALENDAR_NAME,
      timeZone: json.timeZone || DEFAULT_TIME_ZONE,
      events: json.events,
      seqs: json.seqs && typeof json.seqs === "object" ? json.seqs : {},
      tombstones: json.tombstones && typeof json.tombstones === "object" ? json.tombstones : {}
    };
  }
  return base;
}

function normalizeEvent(raw, typeAlarms, seenUids) {
  const source = raw && typeof raw === "object" ? raw : {};
  const skippedId =
    typeof source.id === "string" || typeof source.id === "number" ? String(source.id) : null;
  const fail = (reason) => ({ event: null, clientSeq: 0, skippedId, reason });

  const id = skippedId ? skippedId.trim().slice(0, 200) : "";
  if (!id) return fail("missing id");
  if (typeof source.type !== "string" || !ITEM_TYPES.has(source.type)) return fail("bad type");
  const title = clampText(source.title, 500);
  if (!title) return fail("missing title");
  const startAt = parseDateField(source.startAt);
  const dueAt = parseDateField(source.dueAt);
  if (!startAt && !dueAt) return fail("no valid date");

  const cal = source.calendar && typeof source.calendar === "object" ? source.calendar : {};
  const uid = feedUid(cal.uid, id);
  if (seenUids.has(uid)) return fail("duplicate uid");

  const event = { id, uid, type: source.type, title };
  const sourceId = clampText(source.source, 50);
  if (sourceId) event.source = sourceId;
  const org = clampText(source.org, 100);
  if (org) event.org = org;
  if (dueAt) event.dueAt = dueAt;
  if (startAt) event.startAt = startAt;
  const endAt = parseDateField(source.endAt);
  if (endAt) event.endAt = endAt;
  if (source.allDay === true) event.allDay = true;
  const location = clampText(source.location, 500);
  if (location) event.location = location;
  const url = safeHttpsUrl(source.url);
  if (url) event.url = url;
  event.status = ITEM_STATUSES.has(source.status) ? source.status : "open";
  event.confidence = source.confidence === "tentative" ? "tentative" : "exact";
  if (Number.isFinite(source.weight) && source.weight >= 0 && source.weight <= 100) {
    event.weight = source.weight;
  }
  const section = clampText(source.section, 50);
  if (section) event.section = section;
  const details = clampText(source.details, 2000);
  if (details) event.details = details;
  const seenIn = normalizeSeenIn(source.seenIn);
  if (seenIn) event.seenIn = seenIn;
  event.alarms = resolveAlarms(source, typeAlarms);
  event.feedGroup = feedGroupOf(source);

  const clientSeq = Number.isInteger(cal.seq) && cal.seq >= 0 ? cal.seq : 0;
  return { event, clientSeq, skippedId, reason: null };
}

/** Group an event lands in: explicit feedGroup > source default > type default. */
export function feedGroupOf(event) {
  if (
    event &&
    typeof event.feedGroup === "string" &&
    Object.hasOwn(FEED_GROUPS, event.feedGroup)
  ) {
    return event.feedGroup;
  }
  if (event?.source === "waterlooworks") return "coop";
  if (event?.source === "discord") return "teams";
  return Object.hasOwn(TYPE_GROUPS, event?.type) ? TYPE_GROUPS[event.type] : "other";
}

export function buildCalendar(state, { group } = {}) {
  const stored = state && typeof state === "object" ? state : {};
  const baseName = clampText(stored.calendarName, 100) || DEFAULT_CALENDAR_NAME;
  const timeZone = validTimeZone(stored.timeZone) || DEFAULT_TIME_ZONE;
  const groupLabel = group && Object.hasOwn(FEED_GROUPS, group) ? FEED_GROUPS[group] : null;
  const calendarName = groupLabel ? `${baseName} · ${groupLabel}` : baseName;
  const description = "Deadlines, classes and events published by Waterloo All-in-1";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Waterloo All-in-1//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(calendarName)}`,
    `X-WR-CALDESC:${escapeIcs(groupLabel ? `${description} · ${groupLabel}` : description)}`,
    `X-WR-TIMEZONE:${escapeIcs(timeZone)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H"
  ];
  for (const event of Array.isArray(stored.events) ? stored.events : []) {
    if (group && event.feedGroup !== group) continue;
    pushEvent(lines, event, stored.seqs?.[event.uid], timeZone);
  }
  lines.push("END:VCALENDAR", "");
  return lines.map(foldIcsLine).join("\r\n");
}

function pushEvent(lines, event, meta, timeZone) {
  const summary = summaryOf(event);
  const at = meta && meta.at ? new Date(meta.at) : new Date();
  const dtstamp = formatIcsDate(at);
  lines.push(
    "BEGIN:VEVENT",
    `UID:${escapeIcs(event.uid)}`,
    `DTSTAMP:${dtstamp}`,
    `SEQUENCE:${Number.isInteger(meta?.seq) ? meta.seq : 0}`,
    `LAST-MODIFIED:${dtstamp}`
  );
  pushEventDates(lines, event, timeZone);
  lines.push(`SUMMARY:${escapeIcs(summary)}`, `STATUS:${statusOf(event)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcs(event.location)}`);
  if (event.url) lines.push(`URL:${event.url}`);
  lines.push(`CATEGORIES:${escapeIcs(TYPE_LABELS[event.type] || event.type)}`);
  const description = descriptionLines(event);
  if (description.length) lines.push(`DESCRIPTION:${escapeIcs(description.join("\n"))}`);
  for (const minutes of event.alarms || []) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `TRIGGER:-PT${minutes}M`,
      `DESCRIPTION:${escapeIcs(summary)}`,
      "END:VALARM"
    );
  }
  lines.push("END:VEVENT");
}

function pushEventDates(lines, event, timeZone) {
  if (event.allDay) {
    const startDay = localDay(event.startAt || event.dueAt, timeZone);
    let endDay = event.endAt ? addDays(localDay(event.endAt, timeZone), 1) : null;
    if (!endDay || endDay <= startDay) endDay = addDays(startDay, 1);
    lines.push(`DTSTART;VALUE=DATE:${startDay}`, `DTEND;VALUE=DATE:${endDay}`);
    return;
  }
  if (event.startAt) {
    const startMs = Date.parse(event.startAt);
    let endMs = event.endAt ? Date.parse(event.endAt) : NaN;
    if (!(endMs > startMs)) {
      const dueMs = event.dueAt ? Date.parse(event.dueAt) : NaN;
      endMs = dueMs > startMs ? dueMs : startMs + 60 * 60 * 1000;
    }
    lines.push(`DTSTART:${formatIcsDate(new Date(startMs))}`);
    lines.push(`DTEND:${formatIcsDate(new Date(endMs))}`);
    return;
  }
  // Deadline: zero-duration event at the due time, no DTEND.
  lines.push(`DTSTART:${formatIcsDate(new Date(Date.parse(event.dueAt)))}`);
}

function summaryOf(event) {
  let summary = event.title;
  if (event.org && !event.title.toLowerCase().startsWith(event.org.toLowerCase())) {
    summary = `${event.org} · ${event.title}`;
  }
  if (event.status === "submitted" || event.status === "done") return `✓ ${summary}`;
  if (event.status === "cancelled") return `Cancelled: ${summary}`;
  return summary;
}

function statusOf(event) {
  if (event.status === "cancelled") return "CANCELLED";
  if (event.confidence === "tentative") return "TENTATIVE";
  return "CONFIRMED";
}

function descriptionLines(event) {
  const lines = [];
  if (event.details) lines.push(event.details);
  if (typeof event.weight === "number") lines.push(`Weight: ${event.weight}%`);
  if (event.section) lines.push(`Section: ${event.section}`);
  if (event.location) lines.push(`Location: ${event.location}`);
  if (STATUS_LABELS[event.status]) lines.push(`Status: ${STATUS_LABELS[event.status]}`);
  if (event.confidence === "tentative") lines.push("Date is tentative");
  const sources = eventSources(event);
  if (sources.length) lines.push(`Sources: ${sources.join(", ")}`);
  if (event.url) lines.push(`Open: ${event.url}`);
  return lines;
}

function eventSources(event) {
  const seen = new Set();
  const sources = [];
  const candidates = [event.source, ...(event.seenIn || []).map((entry) => entry && entry.source)];
  for (const source of candidates) {
    if (!source || seen.has(source)) continue;
    seen.add(source);
    sources.push(Object.hasOwn(SOURCE_LABELS, source) ? SOURCE_LABELS[source] : source);
  }
  return sources;
}

/** YYYYMMDD in the feed timezone; date-only input is taken literally. */
function localDay(value, timeZone) {
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.replace(/-/g, "");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(text));
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}${get("month")}${get("day")}`;
}

function addDays(day, count) {
  const date = new Date(
    Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8))) +
      count * 24 * 60 * 60 * 1000
  );
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Canonical form: "YYYY-MM-DD" stays literal, anything else parses to ISO Z or null. */
function parseDateField(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function feedUid(calendarUid, id) {
  let uid = clampText(calendarUid, 200) || id;
  if (!uid.includes("@")) uid += UID_SUFFIX;
  return uid;
}

function clampText(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim().slice(0, max);
  return text || undefined;
}

function safeHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function validTimeZone(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

function sanitizeAlarms(list) {
  if (!Array.isArray(list)) return null;
  return list
    .filter((minutes) => Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_ALARM_MINUTES)
    .slice(0, MAX_ALARMS);
}

function normalizeAlarmMap(alarms) {
  const map = {};
  if (alarms && typeof alarms === "object") {
    for (const [type, list] of Object.entries(alarms)) {
      if (!ITEM_TYPES.has(type)) continue;
      const clean = sanitizeAlarms(list);
      if (clean) map[type] = clean;
    }
  }
  return map;
}

// Per-event alarms (even an empty list) override the type-level list.
function resolveAlarms(source, typeAlarms) {
  if (Array.isArray(source.alarms)) return sanitizeAlarms(source.alarms);
  return sanitizeAlarms(typeAlarms[source.type]) || [];
}

function normalizeSeenIn(seenIn) {
  if (!Array.isArray(seenIn)) return undefined;
  const seen = new Set();
  const out = [];
  for (const entry of seenIn) {
    const source = clampText(entry && entry.source, 50);
    if (source && !seen.has(source)) {
      seen.add(source);
      out.push({ source });
    }
  }
  return out.length ? out : undefined;
}

function stableHash(text) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function formatIcsDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeIcs(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function foldIcsLine(line) {
  const chunks = [];
  let chunk = "";
  let bytes = 0;
  for (const character of line) {
    const characterBytes = encoder.encode(character).length;
    const limit = chunks.length ? 74 : 75;
    if (chunk && bytes + characterBytes > limit) {
      chunks.push(chunk);
      chunk = character;
      bytes = characterBytes;
    } else {
      chunk += character;
      bytes += characterBytes;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((value, index) => index ? ` ${value}` : value).join("\r\n");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function randomToken(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function isAuthorized(request, expectedHash) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return false;
  return (await hashToken(authorization.slice(7))) === expectedHash;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS"
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders()
    }
  });
}
