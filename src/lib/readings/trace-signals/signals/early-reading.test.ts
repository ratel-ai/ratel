import assert from "node:assert/strict";
import { test } from "node:test";
import {
  awaitsFullReading,
  EARLY_PROGRESS_MAX,
  EARLY_REFRESH_AFTER_MS,
  earlyProgress,
  earlyRefreshDue,
  isEarlyReading,
  isEarlyReadingSummary,
  QUICK_FIRST_READING_DAYS,
  quickWindowDays,
} from "@/lib/readings/trace-signals/signals/early-reading";
import { earlyReadingCopy } from "@/lib/views/health/page-state-copy";

const FLOOR = 50;
const full = { status: "completed", turnsScanned: 400, summary: {} };
const thin = { status: "completed", turnsScanned: 12, summary: {} };
const early = { status: "completed", turnsScanned: 120, summary: { earlyReading: true } };

test("the quick first reading reads a week, which is also the page's default window", () => {
  assert.equal(QUICK_FIRST_READING_DAYS, 7);
});

test("a project waits for its full reading until a completed, non-early one has enough turns", () => {
  assert.equal(awaitsFullReading(null, FLOOR), true);
  assert.equal(awaitsFullReading({ status: "failed", turnsScanned: 0 }, FLOOR), true);
  assert.equal(awaitsFullReading(thin, FLOOR), true);
  assert.equal(awaitsFullReading(early, FLOOR), true);
  assert.equal(awaitsFullReading(full, FLOOR), false);
});

test("only a project without a reading the page shows gets the quick week, and only once", () => {
  assert.equal(quickWindowDays(null, 90, FLOOR), 7);
  assert.equal(quickWindowDays({ status: "failed", turnsScanned: 0 }, 90, FLOOR), 7);
  assert.equal(quickWindowDays(thin, 30, FLOOR), 7, "a thin reading is still the collecting meter");
  assert.equal(quickWindowDays(early, 90, FLOOR), null, "after an early reading, the full window");
  assert.equal(
    quickWindowDays({ ...thin, summary: { earlyReading: true } }, 90, FLOOR),
    null,
    "even a thin early one",
  );
  assert.equal(quickWindowDays(full, 90, FLOOR), null);
  assert.equal(quickWindowDays(null, 7, FLOOR), null, "nothing quicker than a week-long window");
});

test("a run is early only while the full reading is awaited, and for one of three reasons", () => {
  const none = { awaitingFull: true, quick: false, partial: false, importing: false };
  assert.equal(isEarlyReading(none), false);
  assert.equal(isEarlyReading({ ...none, quick: true }), true);
  assert.equal(isEarlyReading({ ...none, partial: true }), true);
  assert.equal(isEarlyReading({ ...none, importing: true }), true);
  assert.equal(
    isEarlyReading({ awaitingFull: false, quick: true, partial: true, importing: true }),
    false,
  );
});

test("the early marker is read defensively", () => {
  assert.equal(isEarlyReadingSummary({ earlyReading: true }), true);
  assert.equal(isEarlyReadingSummary({ earlyReading: "yes" }), false);
  assert.equal(isEarlyReadingSummary(null), false);
  assert.equal(isEarlyReadingSummary("earlyReading"), false);
});

test("a caught-up build asks for the next reading only after an early one has stood a while", () => {
  const at = new Date("2026-11-04T10:00:00Z");
  const finished = (msAgo: number) => ({ ...early, finishedAt: new Date(at.getTime() - msAgo) });
  assert.equal(earlyRefreshDue(finished(EARLY_REFRESH_AFTER_MS - 1), at), false);
  assert.equal(earlyRefreshDue(finished(EARLY_REFRESH_AFTER_MS), at), true);
  assert.equal(
    earlyRefreshDue({ ...full, finishedAt: new Date(0) }, at),
    false,
    "a full reading is not early",
  );
  assert.equal(earlyRefreshDue({ ...early, finishedAt: null }, at), false);
});

test("the early reading's words: a first look, still processing, will fill in and may change", () => {
  const week = earlyReadingCopy({ signalWindowDays: 7, importing: false, updating: true });
  assert.equal(week.title, "Early reading: we are still processing");
  assert.match(week.body, /most recent runs \(the last 7 days\)/);
  assert.match(week.body, /the rest of your history/);
  assert.match(week.body, /will fill in and may change/);
  assert.match(week.body, /being built now, and this page updates on its own/);

  const importing = earlyReadingCopy({ signalWindowDays: 90, importing: true, updating: false });
  assert.match(importing.body, /the runs we have processed so far/);
  assert.match(importing.body, /the rest of your import as it comes in/);
  assert.match(importing.body, /Come back soon to see it/);

  for (const copy of [week, importing])
    assert.doesNotMatch(`${copy.title} ${copy.body}`, /—/, "no em dashes");
});

test("an early reading's progress: runs read of the runs there are, never shown as done", () => {
  assert.deepEqual(earlyProgress(1_055, 5_315), { read: 1_055, total: 5_315, percent: 19 });
  assert.equal(
    earlyProgress(5_315, 5_315).percent,
    EARLY_PROGRESS_MAX,
    "the full reading is what says 100",
  );
  assert.equal(earlyProgress(3, 10_000).percent, 1, "something read shows something");
  assert.deepEqual(
    earlyProgress(80, 50),
    { read: 80, total: 80, percent: EARLY_PROGRESS_MAX },
    "a total the read outgrew is the read",
  );
  assert.equal(earlyProgress(0, 0).percent, 1);
});
