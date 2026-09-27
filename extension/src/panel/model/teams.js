// @ts-check
/*
  Pure model for the Teams tab: one card per watched design-team server, built
  from Discord items (org = team name), the discord sourceState (unreadWatched,
  guilds, sweepQueue) and settings.sources.discord.watched. No DOM, no chrome.*.
*/

import { effectiveItem, isVisible } from "../../core/effective.js";

const DAY = 86400000;

/** Case/space-insensitive team-name key. */
const normTeam = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

/** Was this Discord item assigned to the user? */
export function assignedToMe(item) {
  if (item && item.meta && item.meta.assignedToMe) return true;
  const facts = (item && item.meta && item.meta.facts) || [];
  return facts.some(
    (f) => /^assigned to you$/i.test(String(f && f.label)) && /yes|true|1/i.test(String(f && f.value))
  );
}

/** Is the item a weekly recurring suggestion/meeting? */
const isWeekly = (item) =>
  !!(item && item.meta && item.meta.recurrence && /week/i.test(item.meta.recurrence.freq || "")) ||
  /\(weekly\)/i.test((item && item.title) || "");

const anchorMs = (item) => Date.parse(item.dueAt || item.startAt || "");

const isDeadlineish = (it) =>
  it.type === "deadline" || it.type === "quiz" || it.type === "task" ||
  it.type === "lab" || it.type === "application-deadline" || it.type === "offer-deadline";

/**
 * @param {Object} p
 * @param {Record<string, any>} p.items        merged items map
 * @param {Record<string, any>} p.userState
 * @param {Record<string, any>} p.sourceState  raw sourceState (discord state inside)
 * @param {any} p.settings                     resolved settings
 * @param {Date} p.now
 * @returns {{teams: any[], watchedEmpty: boolean}}
 *   teams: [{name, focus[], nextMeeting, weekly, tasks[], deadlines[],
 *            pendingCount, unread[], week[]}]
 */
export function teamCards({ items = {}, userState = {}, sourceState = {}, settings = {}, now = new Date() }) {
  const acceptPending = !!(settings.review && settings.review.showPending);
  const watched = (settings.sources && settings.sources.discord && settings.sources.discord.watched) || {};
  const watchedNames = Object.keys(watched).filter((k) => watched[k]);

  // Discord items grouped by team name (normalised).
  /** @type {Map<string, any[]>} */
  const byTeam = new Map();
  for (const raw of Object.values(items || {})) {
    if (!raw || raw.source !== "discord" || !raw.org) continue;
    const key = normTeam(raw.org);
    const list = byTeam.get(key) || [];
    list.push(raw);
    byTeam.set(key, list);
  }

  // Watched teams first; when nothing is watched, every team seen in items.
  const names = watchedNames.length
    ? watchedNames
    : [...new Set(Object.values(items || {})
        .filter((it) => it && it.source === "discord" && it.org)
        .map((it) => String(it.org)))].sort();

  const discState = (sourceState.discord && sourceState.discord.state) || {};
  const unreadWatched = Array.isArray(discState.unreadWatched) ? discState.unreadWatched : [];

  const nowMs = now.getTime();
  const weekEnd = nowMs + 7 * DAY;

  const teams = names.map((name) => {
    const key = normTeam(name);
    const focus = (watched[name] && watched[name].focus) || [];
    const raws = byTeam.get(key) || [];
    const effs = raws.map((r) => effectiveItem(r, userState[r.id], { acceptPending }));

    let pendingCount = 0;
    /** @type {any[]} */
    const tasks = [];
    /** @type {any[]} */
    const deadlines = [];
    /** @type {any[]} */
    const week = [];
    /** @type {any} */
    let nextMeeting = null;
    let nextMeetingMs = Infinity;
    let meetingWeekly = false;

    for (const it of effs) {
      if (!it) continue;
      // Pending items count toward "Needs review" but don't surface in the
      // card lists until accepted.
      if (it.review === "pending") pendingCount++;
      if (!isVisible(it, nowMs)) continue;
      const a = anchorMs(it);
      if (Number.isNaN(a)) {
        if (it.status === "open" && it.type === "task" && assignedToMe(it)) tasks.push(it);
        continue;
      }
      if ((it.type === "meeting" || it.type === "event") && it.startAt && a > nowMs && a < nextMeetingMs) {
        nextMeeting = it;
        nextMeetingMs = a;
        meetingWeekly = isWeekly(it);
      }
      if (it.status !== "open") continue;
      if (it.type === "task" && assignedToMe(it)) tasks.push(it);
      else if (it.dueAt && isDeadlineish(it)) deadlines.push(it);
      if (a >= nowMs && a < weekEnd) week.push(it);
    }

    tasks.sort((x, y) => anchorMs(x) - anchorMs(y));
    deadlines.sort((x, y) => anchorMs(x) - anchorMs(y));
    week.sort((x, y) => anchorMs(x) - anchorMs(y));

    const unread = unreadWatched.filter((c) => normTeam(c.guildName) === key);

    return {
      name,
      focus: Array.isArray(focus) ? focus : [],
      nextMeeting,
      weekly: meetingWeekly,
      tasks,
      deadlines,
      pendingCount,
      unread,
      week,
    };
  });

  return { teams, watchedEmpty: !watchedNames.length };
}
