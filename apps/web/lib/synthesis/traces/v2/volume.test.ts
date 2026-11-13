import assert from "node:assert/strict";
import { test } from "node:test";
import {
  axisLabels,
  BAR_GAP,
  barLayout,
  bucketLabel,
  buildVolumeModel,
  canSelectDays,
  MAX_BAR_WIDTH,
  MAX_VOLUME_BUCKETS,
  MIN_ERROR_HEIGHT,
  needsHourlyVolume,
  selectionDays,
  selectionTotals,
  selectionWindow,
  stackHeights,
  volumeStepHours,
  withDefaultRange,
  withSelectedDays,
} from "./volume";

const plain = (text: string) => text.replaceAll("\u00a0", " ");

test("the bucket grows with the window so bars stay thin and never pass a hundred", () => {
  assert.equal(volumeStepHours(1), 1, "a day reads by the hour");
  assert.equal(volumeStepHours(7), 2, "a week by two hours");
  assert.equal(volumeStepHours(14), 6);
  assert.equal(volumeStepHours(30), 12);
  assert.equal(volumeStepHours(92), 24, "a quarter by the day");
  assert.equal(volumeStepHours(365), 168, "a year by the week");
  for (const days of [1, 2, 7, 14, 30, 31, 92, 365, 372]) {
    assert.ok(Math.ceil((days * 24) / volumeStepHours(days)) <= MAX_VOLUME_BUCKETS, `${days} days`);
  }
  assert.equal(needsHourlyVolume(7), true);
  assert.equal(needsHourlyVolume(92), false);
});

test("hourly points land in their bucket and points outside the window are dropped", () => {
  const model = buildVolumeModel({
    from: "2026-10-09",
    to: "2026-10-15",
    points: [
      { day: "2026-10-09", hour: 11, count: 36, errorCount: 2 },
      { day: "2026-10-09", hour: 12, count: 24, errorCount: 0 },
      { day: "2026-10-08", hour: 23, count: 99, errorCount: 9 },
    ],
  });
  assert.equal(model.stepHours, 2);
  assert.equal(model.buckets.length, 84);
  assert.deepEqual(
    model.buckets.flatMap((bucket, index) =>
      bucket.count > 0 ? [[index, bucket.count, bucket.errorCount]] : [],
    ),
    [
      [5, 36, 2],
      [6, 24, 0],
    ],
    "11:00 is in the 10:00 bucket, 12:00 in the next",
  );
  assert.deepEqual(model.totals, { count: 60, errorCount: 2 });
  assert.equal(model.scaleMax, 50, "the top gridline is a clean number above the peak");
});

test("a daily series draws daily buckets even when the window asked for hours", () => {
  const model = buildVolumeModel({
    from: "2026-10-09",
    to: "2026-10-15",
    points: [{ day: "2026-10-09", count: 60, errorCount: 0 }],
  });
  assert.equal(model.stepHours, 24);
  assert.equal(model.buckets.length, 7);
  assert.equal(model.buckets[0].count, 60);
});

test("an empty window still has its buckets, all at zero", () => {
  const model = buildVolumeModel({ from: "2026-10-15", to: "2026-10-15", points: [] });
  assert.equal(model.buckets.length, 24);
  assert.deepEqual(model.totals, { count: 0, errorCount: 0 });
});

test("a selection covers whole UTC days, the URL contract the v1 brush wrote", () => {
  const model = buildVolumeModel({ from: "2026-10-09", to: "2026-10-15", points: [] });
  assert.deepEqual(selectionDays(model.buckets, [5, 6]), { from: "2026-10-09", to: "2026-10-09" });
  assert.deepEqual(
    selectionDays(model.buckets, [30, 5]),
    { from: "2026-10-09", to: "2026-10-11" },
    "either drag direction",
  );
  const search = withSelectedDays("?range=7d&errorOnly=1&cursor=abc&peek=t1", {
    from: "2026-10-09",
    to: "2026-10-11",
  });
  const params = new URLSearchParams(search);
  assert.equal(params.get("range"), "custom");
  assert.equal(params.get("from"), "2026-10-09");
  assert.equal(params.get("to"), "2026-10-11");
  assert.equal(params.get("errorOnly"), "1", "filters survive the zoom");
  assert.equal(params.has("cursor"), false, "the old page does not");
  assert.equal(params.has("peek"), false, "nor does the open row");
});

test("selecting bars narrows the window only when there are days to narrow to", () => {
  const week = buildVolumeModel({ from: "2026-10-09", to: "2026-10-15", points: [] });
  assert.equal(canSelectDays(week.buckets), true);
  assert.deepEqual(
    selectionWindow(week.buckets, [5, 6]),
    { from: "2026-10-09", to: "2026-10-09" },
    "hours inside a day show that day",
  );
  assert.equal(
    selectionWindow(week.buckets, [0, week.buckets.length - 1]),
    null,
    "the whole window changes nothing",
  );
  const today = buildVolumeModel({ from: "2026-10-15", to: "2026-10-15", points: [] });
  assert.equal(today.stepHours, 1);
  assert.equal(canSelectDays(today.buckets), false, "one UTC day has nothing narrower in the URL");
  assert.equal(selectionWindow(today.buckets, [3, 9]), null);
});

test("resetting a zoom returns to the default window", () => {
  const params = new URLSearchParams(
    withDefaultRange("?range=custom&from=2026-10-09&to=2026-10-11&tool=x"),
  );
  assert.equal(params.get("range"), "7d");
  assert.equal(params.has("from"), false);
  assert.equal(params.has("to"), false);
  assert.equal(params.get("tool"), "x");
});

test("selection totals add up the buckets in range", () => {
  const model = buildVolumeModel({
    from: "2026-09-01",
    to: "2026-09-30",
    stepHours: 24,
    points: [
      { day: "2026-09-02", count: 3, errorCount: 1 },
      { day: "2026-09-03", count: 5, errorCount: 0 },
      { day: "2026-09-10", count: 7, errorCount: 7 },
    ],
  });
  assert.deepEqual(selectionTotals(model.buckets, [1, 2]), { count: 8, errorCount: 1 });
});

test("bars keep a 2 px gap, never pass 24 px, and centre in wide slots", () => {
  const dense = barLayout(840, 84);
  assert.equal(dense.slot, 10);
  assert.equal(dense.barWidth, 10 - BAR_GAP);
  assert.equal(dense.x(1), 11);
  const sparse = barLayout(700, 7);
  assert.equal(sparse.barWidth, MAX_BAR_WIDTH);
  assert.equal(sparse.x(0), (100 - MAX_BAR_WIDTH) / 2);
  assert.equal(barLayout(0, 7).barWidth, 0, "unmeasured or empty draws nothing");
});

test("failures sit on the baseline with a legibility floor, completed runs stack above a 2 px gap", () => {
  const rare = stackHeights({ count: 600, errorCount: 3 }, 600, 96);
  assert.ok(rare.error >= MIN_ERROR_HEIGHT, "three failures in six hundred still show");
  assert.equal(rare.gap, BAR_GAP);
  assert.ok(
    Math.abs(rare.error + rare.gap + rare.ok - 96) < 0.001,
    "the stack fills the bar's height",
  );
  const allFailed = stackHeights({ count: 4, errorCount: 4 }, 10, 96);
  assert.equal(allFailed.ok, 0);
  assert.equal(allFailed.gap, 0);
  assert.ok(allFailed.error > 0);
  assert.ok(
    stackHeights({ count: 1, errorCount: 0 }, 1000, 96).ok >= 2,
    "a quiet bucket is never drawn as nothing",
  );
  assert.deepEqual(stackHeights({ count: 0, errorCount: 0 }, 10, 96), { error: 0, ok: 0, gap: 0 });
});

test("buckets and axes read in words, hours inside a day and days across a week", () => {
  const week = buildVolumeModel({ from: "2026-10-09", to: "2026-10-15", points: [] });
  assert.equal(
    plain(bucketLabel(week.buckets[5], week.stepHours)),
    "Oct 9, 10:00 to 12:00 UTC",
    "hours say their zone",
  );
  assert.equal(plain(bucketLabel(week.buckets[11], week.stepHours)), "Oct 9, 22:00 to 24:00 UTC");
  assert.equal(
    bucketLabel(week.buckets[5], week.stepHours, { zone: false }),
    "Oct 9, 10:00 to 12:00",
    "a UTC header says it once",
  );
  assert.deepEqual(
    axisLabels(week).map((label) => label.label),
    ["Oct 9", "Oct 11", "Oct 13", "Oct 15"],
  );
  const day = buildVolumeModel({ from: "2026-10-09", to: "2026-10-09", points: [] });
  assert.deepEqual(
    axisLabels(day).map((label) => label.label),
    ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"],
  );
  const quarter = buildVolumeModel({ from: "2026-07-16", to: "2026-10-15", points: [] });
  assert.equal(bucketLabel(quarter.buckets[0], quarter.stepHours), "Jul 16");
  assert.ok(axisLabels(quarter).length <= 7);
});
