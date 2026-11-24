import assert from "node:assert/strict";
import { test } from "node:test";
import { latestEventAt, newest } from "@/lib/views/home/load";

const EARLY = new Date("2026-11-24T10:00:00.000Z");
const LATE = new Date("2026-11-24T11:00:00.000Z");

test("the newest of spans, events and SDK events is the last event", () => {
  assert.equal(newest(EARLY, LATE), LATE);
  assert.equal(newest(LATE, EARLY), LATE);
  assert.equal(newest(null, EARLY), EARLY);
  assert.equal(newest(null, null), null);
  const read = (event: Date | null, span: Date | null) =>
    latestEventAt({ latestEventAt: event, latestSpanAt: span } as Parameters<
      typeof latestEventAt
    >[0]);
  assert.equal(read(EARLY, LATE), LATE);
  assert.equal(read(LATE, null), LATE);
  assert.equal(read(null, null), null);
});
