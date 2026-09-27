// CPU benchmark: JSON.parse + applyPublish + buildCalendar for realistic
// 400- and 3000-event feeds, in Node as a proxy for Worker CPU time.
// Prints medians; asserts only generous ceilings so CI is never flaky.
import test from "node:test";
import assert from "node:assert/strict";
import { applyPublish, buildCalendar } from "../src/worker.js";

const GROUPS = ["classes", "deadlines", "coop", "teams", "other"];
const RUNS = 7;

const TYPES = ["class", "deadline", "meeting", "exam", "tutorial", "lab", "event"];
const ORGS = ["ECE 105", "MATH 135", "CS 136", "Robotics Club", "Employer Inc", "STAT 230"];

function realisticEvents(n) {
  const base = Date.parse("2026-10-01T00:00:00.000Z");
  const events = [];
  for (let i = 0; i < n; i++) {
    const type = TYPES[i % TYPES.length];
    const start = base + (i % 120) * 3600_000;
    const e = {
      id: `learn:${1000 + i}:assign-${i}`,
      type,
      title: `${ORGS[i % ORGS.length]} ${type} ${i}: deliverable with a reasonably long title`,
      org: ORGS[i % ORGS.length],
      source: ["learn", "discord", "waterlooworks", "outline"][i % 4],
      location: `E7-${1000 + (i % 500)}`,
      details: `Details line one for event ${i}.\nDetails line two with some more text.`,
      url: `https://learn.uwaterloo.ca/d2l/item/${i}`
    };
    if (i % 5 === 0) {
      // 20% all-day
      e.allDay = true;
      e.startAt = `2026-10-${String((i % 28) + 1).padStart(2, "0")}`;
    } else {
      e.startAt = new Date(start).toISOString();
      e.endAt = new Date(start + 80 * 60_000).toISOString();
    }
    if (i % 3 === 0) e.alarms = [30, 1440];
    if (i % 7 === 0) e.seenIn = [{ source: "learn" }, { source: "outline" }];
    events.push(e);
  }
  return events;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function bench(n) {
  const body = JSON.stringify({
    version: 2,
    calendarName: "Waterloo All-in-1",
    timeZone: "America/Toronto",
    events: realisticEvents(n)
  });
  const parseMs = [];
  const publishMs = [];
  const renderMs = [];
  // One warm-up pass so JIT doesn't dominate the median.
  applyPublish(null, JSON.parse(body), new Date());
  for (let i = 0; i < RUNS; i++) {
    let t0 = performance.now();
    const parsed = JSON.parse(body);
    parseMs.push(performance.now() - t0);

    t0 = performance.now();
    const { state } = applyPublish(null, parsed, new Date());
    publishMs.push(performance.now() - t0);

    t0 = performance.now();
    buildCalendar(state);
    for (const group of GROUPS) buildCalendar(state, { group });
    renderMs.push(performance.now() - t0);
  }
  return {
    bytes: body.length,
    parse: median(parseMs),
    publish: median(publishMs),
    render: median(renderMs)
  };
}

for (const n of [400, 3000]) {
  test(`bench: ${n}-event feed (parse / applyPublish / render x6)`, () => {
    const r = bench(n);
    const total = r.parse + r.publish + r.render;
    // eslint-disable-next-line no-console
    console.log(
      `  [bench] ${n} events, ${(r.bytes / 1024).toFixed(0)} KiB payload:` +
        ` JSON.parse ${r.parse.toFixed(1)} ms,` +
        ` applyPublish ${r.publish.toFixed(1)} ms,` +
        ` buildCalendar x6 ${r.render.toFixed(1)} ms,` +
        ` total ${total.toFixed(1)} ms`
    );
    // Generous ceiling: real medians are tens of ms; this only guards
    // against a catastrophic regression, not perf noise.
    assert.ok(total < 30_000, `${n}-event publish path took ${total} ms`);
  });
}
