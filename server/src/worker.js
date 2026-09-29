// Waterloo All-in-1 calendar feed. The extension publishes its merged item
// list here (POST /v1/calendars, PUT /v1/calendars/<id>.ics); calendar clients
// such as Google Calendar subscribe to the returned .ics URLs (GET), including
// the per-group alias feeds. Feed state lives in Cloudflare D1.

const FEED_LIFETIME_SECONDS = 365 * 24 * 60 * 60;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 1900000; // D1 rejects rows over ~2,000,000 bytes
const DEFAULT_MAX_EVENTS = 3000;
const DEFAULT_CREATES_PER_IP_PER_DAY = 10;
const DEFAULT_RATE_SALT = "waterloo-all-in-1";
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
  // Rendered ICS cache: one row per public feed id (main id + each group
  // alias id), written at publish time so GET is a single row read.
  selectRender:
    "SELECT ics, etag, expires_at FROM calendar_renders WHERE feed_id = ?",
  upsertRender:
    "INSERT INTO calendar_renders (feed_id, calendar_id, ics, etag, expires_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(feed_id) DO UPDATE SET " +
    "ics = excluded.ics, etag = excluded.etag, expires_at = excluded.expires_at, " +
    "updated_at = excluded.updated_at",
  deleteCalendarRenders:
    "DELETE FROM calendar_renders WHERE calendar_id = ?",
  deleteStaleRenders:
    "DELETE FROM calendar_renders WHERE calendar_id = ? AND feed_id != ? " +
    "AND feed_id NOT IN (SELECT id FROM calendar_feed_aliases WHERE feed_id = ?)",
  deleteExpiredRenders: "DELETE FROM calendar_renders WHERE expires_at <= ?",
  // Per-IP create quota (migration 0004): key is a salted day-scoped hash.
  selectCreateLimit: "SELECT count FROM create_limits WHERE key = ?",
  upsertCreateLimit:
    "INSERT INTO create_limits (key, day, count) VALUES (?, ?, 1) " +
    "ON CONFLICT(key) DO UPDATE SET count = count + 1",
  deleteOldCreateLimits: "DELETE FROM create_limits WHERE day < ?",
});

/**
 * Optional wrangler `vars` knobs, validated — a missing or invalid value
 * falls back to the default so a typo can never break the worker.
 *   MAX_EVENTS              int 1..3000 (default 3000) — publish cap; keep
 *                           ~600 on the free plan so an oversized publish
 *                           gets a clean 413 instead of a CPU kill.
 *   MAX_FEEDS               int ≥1 (default unset = unlimited) — POSTs 503
 *                           once that many live feeds exist.
 *   CREATES_PER_IP_PER_DAY  int ≥1 (default 10) — per-IP POST quota.
 *   RATE_SALT               string — salt for the per-IP hash (set as a
 *                           secret; a fixed default keeps dev simple).
 */
export function serverConfig(env) {
  const int = (value, { min, max = Infinity, fallback }) => {
    const n =
      typeof value === "number" ? value : Number(String(value ?? "").trim());
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  return {
    maxEvents: int(env?.MAX_EVENTS, {
      min: 1,
      max: 3000,
      fallback: DEFAULT_MAX_EVENTS,
    }),
    maxFeeds: int(env?.MAX_FEEDS, { min: 1, fallback: null }),
    createsPerIpPerDay: int(env?.CREATES_PER_IP_PER_DAY, {
      min: 1,
      fallback: DEFAULT_CREATES_PER_IP_PER_DAY,
    }),
    rateSalt:
      typeof env?.RATE_SALT === "string" && env.RATE_SALT
        ? env.RATE_SALT
        : DEFAULT_RATE_SALT,
  };
}

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
      await env.DB
        .prepare(SQL.deleteExpiredRenders)
        .bind(new Date().toISOString())
        .run();
      await env.DB
        .prepare(SQL.deleteOldCreateLimits)
        .bind(utcDay())
        .run();
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
  if (request.method === "GET") return readFeed(request, feedId, env, context);
  if (request.method === "PUT") return updateFeed(request, feedId, env, url.origin);
  if (request.method === "DELETE") return deleteFeed(request, feedId, env);
  return jsonResponse({ error: "Method not allowed." }, 405);
}

const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

/** Seconds until the next UTC midnight (Retry-After on a 429). */
function secondsUntilUtcMidnight(now = new Date()) {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Per-IP create quota: the key is a salted SHA-256 of the client IP scoped
 * to the UTC day — raw IPs are never stored. Returns a 429 Response when
 * the quota is spent, else null after recording this create. No
 * CF-Connecting-IP header (local dev, tests) means no limit.
 */
async function checkCreateLimit(request, env, config) {
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) return null;
  const day = utcDay();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${ip}|${day}|${config.rateSalt}`)
  );
  const key = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  const row = await env.DB.prepare(SQL.selectCreateLimit).bind(key).first();
  if ((row?.count ?? 0) >= config.createsPerIpPerDay) {
    return jsonResponse(
      { error: "Too many calendars created from this network today." },
      429,
      { "Retry-After": String(secondsUntilUtcMidnight()) }
    );
  }
  await env.DB.prepare(SQL.upsertCreateLimit).bind(key, day).run();
  return null;
}

async function createFeed(request, env, origin) {
  const config = serverConfig(env);
  const limited = await checkCreateLimit(request, env, config);
  if (limited) return limited;
  if (config.maxFeeds != null) {
    const row = await env.DB.prepare(SQL.countLiveFeeds)
      .bind(Date.now())
      .first();
    if ((row?.n ?? 0) >= config.maxFeeds) {
      return jsonResponse({ error: "This server is full" }, 503);
    }
  }

  const parsed = await readPayload(request, config.maxEvents);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);

  const { state, accepted, skipped } = applyPublish(null, parsed.payload, new Date());
  const stored = serializeState(state);
  if (!stored.ok) {
    return jsonResponse({ error: "Calendar feed is too large to store." }, 413);
  }
  const feedId = randomToken(24);
  const updateToken = randomToken(32);
  const updateTokenHash = await hashToken(updateToken);
  const now = Date.now();
  const expiresAt = now + FEED_LIFETIME_SECONDS * 1000;
  await env.DB.prepare(SQL.insertFeed)
    .bind(feedId, updateTokenHash, stored.json, expiresAt, now).run();
  const aliases = await ensureAliases(env, feedId);
  await storeRenders(env, feedId, state, expiresAt);

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

  const config = serverConfig(env);
  const parsed = await readPayload(request, config.maxEvents);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
  const prevState = stateFromStored(safeJsonParse(record.calendar_json), record.updated_at);
  const { state, accepted, skipped } = applyPublish(prevState, parsed.payload, new Date());
  const stored = serializeState(state);
  if (!stored.ok) {
    return jsonResponse({ error: "Calendar feed is too large to store." }, 413);
  }
  const now = Date.now();
  const expiresAt = now + FEED_LIFETIME_SECONDS * 1000;
  await env.DB.prepare(SQL.updateFeed)
    .bind(stored.json, expiresAt, now, feedId).run();
  const aliases = await ensureAliases(env, feedId);
  await storeRenders(env, feedId, state, expiresAt);

  return jsonResponse({
    feedId,
    feedUrl: `${origin}/v1/calendars/${feedId}.ics`,
    groupFeeds: groupFeedsResponse(origin, aliases),
    expiresAt: new Date(expiresAt).toISOString(),
    accepted,
    skipped
  });
}

async function readFeed(request, feedId, env, context) {
  // Normal path: one prepared SELECT over the rendered-feed table — no
  // JSON parse, no rendering. Renders are written at publish time.
  const render = await env.DB.prepare(SQL.selectRender).bind(feedId).first();
  if (render) {
    if (Date.parse(render.expires_at) <= Date.now()) {
      return jsonResponse({ error: "Calendar feed expired." }, 410);
    }
    return icsResponse(request, render.ics, render.etag);
  }

  // Lazy backfill: feeds created before the renders migration have no
  // render row. Resolve the feed (or alias), render once, store, serve.
  const requestedId = feedId;
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
      await env.DB.prepare(SQL.deleteCalendarRenders).bind(feedId).run();
    })());
    return jsonResponse({ error: "Calendar feed expired." }, 410);
  }

  const state = stateFromStored(safeJsonParse(record.calendar_json), record.updated_at);
  const calendar = buildCalendar(state, group ? { group } : {});
  const etag = await etagOf(calendar);
  const renderStmt = env.DB.prepare(SQL.upsertRender).bind(
    requestedId,
    feedId,
    calendar,
    etag,
    new Date(record.expires_at).toISOString(),
    new Date().toISOString()
  );
  if (context?.waitUntil) context.waitUntil(renderStmt.run());
  else await renderStmt.run();
  return icsResponse(request, calendar, etag);
}

/** Strong quoted ETag over the ICS bytes: "sha256hex". */
async function etagOf(ics) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(ics));
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

/** Serve a stored ICS render, honouring If-None-Match. */
function icsResponse(request, ics, etag) {
  const headers = {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": "inline; filename=waterloo-all-in-1.ics",
    "Cache-Control": "private, max-age=900",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };
  const inm = request.headers.get("if-none-match");
  if (inm) {
    const tags = inm.split(",").map((t) => t.trim());
    if (tags.includes("*") || tags.includes(etag)) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": headers["Cache-Control"],
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer"
        }
      });
    }
  }
  return new Response(ics, { headers });
}

/**
 * Render the main feed plus every group alias and upsert one
 * calendar_renders row per public feed id (D1 batch), then delete render
 * rows for ids no longer published.
 */
async function storeRenders(env, feedId, state, expiresAtMs) {
  const aliases =
    (await env.DB.prepare(SQL.selectFeedAliases).bind(feedId).all()).results || [];
  const expiresIso = new Date(expiresAtMs).toISOString();
  const updatedIso = new Date().toISOString();
  const rendered = renderAllFeeds(state, aliases.map((a) => a.feed_group));
  const rows = [[feedId, rendered.get("")]];
  for (const alias of aliases) {
    rows.push([alias.id, rendered.get(alias.feed_group)]);
  }
  const statements = [];
  for (const [publicId, ics] of rows) {
    statements.push(
      env.DB
        .prepare(SQL.upsertRender)
        .bind(publicId, feedId, ics, await etagOf(ics), expiresIso, updatedIso)
    );
  }
  statements.push(
    env.DB.prepare(SQL.deleteStaleRenders).bind(feedId, feedId, feedId)
  );
  await env.DB.batch(statements);
}

async function deleteFeed(request, feedId, env) {
  const record = await env.DB.prepare(SQL.selectFeedForWrite).bind(feedId).first();
  if (!record) return jsonResponse({ error: "Calendar feed not found." }, 404);
  if (!(await isAuthorized(request, record.update_token_hash))) {
    return jsonResponse({ error: "Invalid update token." }, 401);
  }
  await env.DB.prepare(SQL.deleteFeed).bind(feedId).run();
  await env.DB.prepare(SQL.deleteFeedAliases).bind(feedId).run();
  await env.DB.prepare(SQL.deleteCalendarRenders).bind(feedId).run();
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

async function readPayload(request, maxEvents = DEFAULT_MAX_EVENTS) {
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
    // legacy v1 payload from v1 feeds
    events = convertLegacyAssignments(body.assignments);
  }
  if (!events) return { ok: false, status: 400, error: "events must be an array." };
  if (events.length > maxEvents) {
    return { ok: false, status: 413, error: `Too many events; the limit is ${maxEvents}.` };
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

// legacy v1 assignment {id, courseId, name, courseName, dueDate, url} -> FeedEvent.
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
    // timeZone changes all-day local dates, so it is part of the event hash.
    const hash = stableHash(`${JSON.stringify(event)}\n${timeZone}`);
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
    // Slim tombstones keep state small; only seq is needed on resurrection.
    // Older tombstones may still carry hash/at — they read back fine.
    tombstones[uid] = { seq: entry.seq ?? 0, removedAt: nowIso };
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
 * legacy v1 assignments) so old feeds keep rendering with their original UIDs.
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
  // A date-only value ("YYYY-MM-DD") implies an all-day event: parsing it as an
  // instant would land on UTC midnight, the previous evening in local time.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const primaryIsDateOnly = startAt
    ? dateOnly.test(startAt)
    : Boolean(dueAt && dateOnly.test(dueAt));
  if (source.allDay === true || primaryIsDateOnly) event.allDay = true;
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
  const facts = normalizeFacts(source.facts);
  if (facts) event.facts = facts;
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

export function buildCalendar(state, { group } = {}, blocks) {
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
  const parts = lines.map(foldIcsLine);
  for (const event of Array.isArray(stored.events) ? stored.events : []) {
    if (group && event.feedGroup !== group) continue;
    parts.push(
      blocks?.get(event.uid) ??
        renderEventBlock(event, stored.seqs?.[event.uid], timeZone)
    );
  }
  parts.push("END:VCALENDAR", "");
  return parts.join("\r\n");
}

/** One event's folded VEVENT text — group-independent, so it can be shared
 * across the main feed and every group feed of the same publish. */
function renderEventBlock(event, meta, timeZone) {
  const lines = [];
  pushEvent(lines, event, meta, timeZone);
  return lines.map(foldIcsLine).join("\r\n");
}

/** uid -> folded VEVENT text for every event in the state. */
function eventBlocksOf(state) {
  const stored = state && typeof state === "object" ? state : {};
  const timeZone = validTimeZone(stored.timeZone) || DEFAULT_TIME_ZONE;
  const blocks = new Map();
  for (const event of Array.isArray(stored.events) ? stored.events : []) {
    if (!blocks.has(event.uid)) {
      blocks.set(
        event.uid,
        renderEventBlock(event, stored.seqs?.[event.uid], timeZone)
      );
    }
  }
  return blocks;
}

/**
 * Render every public feed of a publish at once: the main feed (key "")
 * plus one per group id. Each VEVENT is built once and reused — the main
 * feed is all blocks; each group feed is a subset of the same strings.
 * @returns {Map<string, string>} feed key ("" or group id) -> ICS text
 */
export function renderAllFeeds(state, groupIds) {
  const blocks = eventBlocksOf(state);
  const feeds = new Map([["", buildCalendar(state, {}, blocks)]]);
  for (const group of groupIds) {
    feeds.set(group, buildCalendar(state, { group }, blocks));
  }
  return feeds;
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
    let endDay = event.endAt ? allDayEndDay(event.endAt, timeZone) : null;
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
  // Adapter-supplied facts render as "Label: value" — except a fact whose
  // label duplicates a line the event's own fields already render.
  const builtin = new Set();
  if (typeof event.weight === "number") builtin.add("weight");
  if (event.section) builtin.add("section");
  if (event.location) {
    builtin.add("location");
    builtin.add("where");
    builtin.add("room");
  }
  for (const fact of Array.isArray(event.facts) ? event.facts : []) {
    if (!fact || builtin.has(String(fact.label || "").toLowerCase())) continue;
    lines.push(`${fact.label}: ${fact.value}`);
  }
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

/**
 * All-day DTEND day (YYYYMMDD). The extension convention is an EXCLUSIVE end:
 * a full timestamp at exactly local midnight already means "the day after the
 * last day" and is used verbatim. Anything else — a date-only "YYYY-MM-DD" or
 * a non-midnight timestamp — is an inclusive last day, so DTEND is day + 1.
 */
function allDayEndDay(endAt, timeZone) {
  const text = String(endAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) && isLocalMidnight(text, timeZone)) {
    return localDay(text, timeZone);
  }
  return addDays(localDay(text, timeZone), 1);
}

/** True when the timestamp's wall clock in `timeZone` reads exactly 00:00:00. */
function isLocalMidnight(value, timeZone) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || ms % 1000 !== 0) return false;
  const parts = hmsFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return get("hour") % 24 === 0 && get("minute") === 0 && get("second") === 0;
}

/** YYYYMMDD in the feed timezone; date-only input is taken literally. */
function localDay(value, timeZone) {
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.replace(/-/g, "");
  const parts = ymdFormatter(timeZone).formatToParts(new Date(text));
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

const validTzCache = new Map();

function validTimeZone(value) {
  if (typeof value !== "string" || !value) return null;
  if (validTzCache.has(value)) return validTzCache.get(value);
  let ok = null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    ok = value;
  } catch {
    /* invalid zone */
  }
  validTzCache.set(value, ok);
  return ok;
}

// Intl.DateTimeFormat construction is expensive — cache one per timeZone.
const hmsFmtCache = new Map();
const ymdFmtCache = new Map();

function hmsFormatter(timeZone) {
  let fmt = hmsFmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    hmsFmtCache.set(timeZone, fmt);
  }
  return fmt;
}

function ymdFormatter(timeZone) {
  let fmt = ymdFmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    ymdFmtCache.set(timeZone, fmt);
  }
  return fmt;
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

const MAX_FACTS = 12;

/** [{label, value}] — trimmed, clamped, deduped by label (first wins). */
function normalizeFacts(facts) {
  if (!Array.isArray(facts)) return undefined;
  const seen = new Set();
  const out = [];
  for (const entry of facts) {
    if (out.length >= MAX_FACTS) break;
    const raw = entry && typeof entry === "object" ? entry : {};
    if (typeof raw.label !== "string" || typeof raw.value !== "string") continue;
    const label = clampText(raw.label, 40);
    const value = clampText(raw.value, 300);
    if (!label || !value) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, value });
  }
  return out.length ? out : undefined;
}

/** Serialize feed state for the calendar_json column, guarding the D1 row limit. */
export function serializeState(state) {
  const json = JSON.stringify(state);
  const bytes = encoder.encode(json).length;
  return { json, bytes, ok: bytes <= MAX_STATE_BYTES };
}

// Exported for tests that pin the hash to the previous BigInt version.
export function stableHash(text) {
  // 64-bit FNV-1a over UTF-8 bytes on 16-bit limbs (little-endian) —
  // identical output to BigInt arithmetic without a BigInt per byte.
  // Offset basis 0xcbf29ce484222325, prime 0x100000001b3 (limbs 0x01b3,
  // 0x0000, 0x0100, 0x0000 — the zero limbs are folded out below).
  let h0 = 0x2325, h1 = 0x8422, h2 = 0x9ce4, h3 = 0xcbf2;
  for (const byte of encoder.encode(text)) {
    h0 ^= byte;
    const a0 = h0, a1 = h1, a2 = h2, a3 = h3;
    let carry = a0 * 0x01b3;
    h0 = carry & 0xffff;
    carry = Math.floor(carry / 0x10000) + a1 * 0x01b3;
    h1 = carry & 0xffff;
    carry = Math.floor(carry / 0x10000) + a0 * 0x0100 + a2 * 0x01b3;
    h2 = carry & 0xffff;
    carry = Math.floor(carry / 0x10000) + a1 * 0x0100 + a3 * 0x01b3;
    h3 = carry & 0xffff;
  }
  return (
    h3.toString(16).padStart(4, "0") +
    h2.toString(16).padStart(4, "0") +
    h1.toString(16).padStart(4, "0") +
    h0.toString(16).padStart(4, "0")
  );
}

function formatIcsDate(date) {
  // "YYYY-MM-DDTHH:mm:ss.sssZ" -> "YYYYMMDDTHHMMSSZ" without regex work.
  const iso = date.toISOString();
  return (
    iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 11) +
    iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) + "Z"
  );
}

function escapeIcs(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

const ASCII_LINE_RE = /^[\x00-\x7f]*$/;

// Exported for tests that pin folding to the previous implementation.
export function foldIcsLine(line) {
  if (ASCII_LINE_RE.test(line)) {
    // ASCII octets are chars: fold at 75, then 74 (the continuation space
    // makes each following line 75 octets again).
    if (line.length <= 75) return line;
    let out = line.slice(0, 75);
    for (let i = 75; i < line.length; i += 74) {
      out += "\r\n " + line.slice(i, i + 74);
    }
    return out;
  }
  // Non-ASCII: UTF-8 octet length per code point, no TextEncoder.
  const chunks = [];
  let chunk = "";
  let bytes = 0;
  for (const character of line) {
    const cp = character.codePointAt(0);
    const characterBytes =
      cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
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

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
      ...corsHeaders()
    }
  });
}
