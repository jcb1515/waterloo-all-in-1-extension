// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { parseWwDate, parseWwRange, parseWwTimeRange } from "../../extension/src/sources/waterlooworks/dates.js";

test("parseWwDate converts Toronto wall times to UTC (EDT, -04:00)", () => {
  assert.equal(parseWwDate("Oct 02, 2026 04:00 PM ET"), "2026-10-02T20:00:00.000Z");
  assert.equal(parseWwDate("Sep 29, 2026 9:00 AM"), "2026-09-29T13:00:00.000Z");
  assert.equal(parseWwDate("September 30, 2026 09:00 AM"), "2026-09-30T13:00:00.000Z");
  assert.equal(parseWwDate("Sep 15, 2026 4:12 PM"), "2026-09-15T20:12:00.000Z");
});

test("parseWwDate handles EST (-05:00) and 12-hour edge cases", () => {
  // Nov 30, 2026 is after the Nov 1 fallback: EST, UTC-5.
  assert.equal(parseWwDate("Nov 30, 2026 09:00 AM"), "2026-11-30T14:00:00.000Z");
  assert.equal(parseWwDate("Nov 30, 2026 11:59 PM"), "2026-12-01T04:59:00.000Z");
  assert.equal(parseWwDate("Sep 29, 2026 12:00 AM"), "2026-09-29T04:00:00.000Z"); // midnight
  assert.equal(parseWwDate("Sep 29, 2026 12:00 PM"), "2026-09-29T16:00:00.000Z"); // noon
});

test("parseWwDate accepts the MM/DD/YYYY inbox format", () => {
  assert.equal(parseWwDate("09/25/2026 12:01 PM"), "2026-09-25T16:01:00.000Z");
  assert.equal(parseWwDate("09/25/2026"), "2026-09-25");
});

test("parseWwDate returns date-only values literally", () => {
  assert.equal(parseWwDate("Oct 2, 2026"), "2026-10-02");
  assert.equal(parseWwDate("October 5, 2026"), "2026-10-05");
});

test("parseWwDate handles weekday prefixes and garbage", () => {
  assert.equal(
    parseWwDate("Saturday, September 26, 2026 6:53 PM"),
    "2026-09-26T22:53:00.000Z"
  );
  assert.equal(parseWwDate("Thursday, October 1, 2026"), "2026-10-01");
  assert.equal(parseWwDate("garbage"), null);
  assert.equal(parseWwDate(""), null);
  assert.equal(parseWwDate(null), null);
  assert.equal(parseWwDate(42), null);
});

test("parseWwRange parses 'date from X to Y'", () => {
  assert.deepEqual(parseWwRange("Oct 2, 2026 from 4:00 PM ET to 4:30 PM ET"), {
    startAt: "2026-10-02T20:00:00.000Z",
    endAt: "2026-10-02T20:30:00.000Z",
  });
  assert.equal(parseWwRange("no range here"), null);
});

test("parseWwTimeRange combines a day-header date with row times", () => {
  assert.deepEqual(
    parseWwTimeRange("Thursday, October 1, 2026", "12:30 PM ET to 01:00 PM ET"),
    { startAt: "2026-10-01T16:30:00.000Z", endAt: "2026-10-01T17:00:00.000Z" }
  );
  assert.equal(parseWwTimeRange("Thursday, October 1, 2026", "no times"), null);
});
