import { test } from "node:test";
import assert from "node:assert/strict";

import { localDateParts } from "../src/local-time.js";

const NY = "America/New_York";

const LATE_ON_26_AUGUST_IN_NEW_YORK = Date.parse("2026-08-27T03:30:00Z");
const BEFORE_CLOCKS_JUMP_FORWARD = Date.parse("2026-03-08T06:30:00Z");
const AFTER_CLOCKS_JUMP_FORWARD = Date.parse("2026-03-08T07:30:00Z");

test("buckets a timestamp by local date, not by UTC date", () => {
  const parts = localDateParts(LATE_ON_26_AUGUST_IN_NEW_YORK, NY);

  assert.deepEqual(parts, { date: "2026-08-26", time: "23:30:00" });
});

test("buckets a timestamp on either side of a daylight-saving boundary", () => {
  assert.deepEqual(localDateParts(BEFORE_CLOCKS_JUMP_FORWARD, NY), {
    date: "2026-03-08",
    time: "01:30:00",
  });
  assert.deepEqual(localDateParts(AFTER_CLOCKS_JUMP_FORWARD, NY), {
    date: "2026-03-08",
    time: "03:30:00",
  });
});

test("applies the offset in force on the day, not a fixed offset", () => {
  const standard = localDateParts(Date.parse("2026-03-07T18:00:00Z"), NY);
  const daylight = localDateParts(Date.parse("2026-03-09T18:00:00Z"), NY);

  assert.equal(standard.time, "13:00:00");
  assert.equal(daylight.time, "14:00:00");
});

test("buckets midnight local as that day, not the previous one", () => {
  assert.deepEqual(localDateParts(Date.parse("2026-08-27T04:00:00Z"), NY), {
    date: "2026-08-27",
    time: "00:00:00",
  });
});
