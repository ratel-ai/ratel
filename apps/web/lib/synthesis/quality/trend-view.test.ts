import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogFingerprintChange, QualityTrendRow } from "@/lib/synthesis/quality/snapshot";
import { buildTrendSeries, headlineTrend, trendMarkers } from "@/lib/synthesis/quality/trend-view";

function row(
  overrides: Omit<Partial<QualityTrendRow>, "day"> & {
    day: string;
    arm: string;
  },
): QualityTrendRow {
  const { day, ...rest } = overrides;
  return {
    tier: "revealed",
    n: 10,
    contained: 8,
    creditSum: 6,
    reciprocalSum: 5,
    fingerprint: "abc",
    ...rest,
    day: new Date(`${day}T00:00:00Z`),
  };
}

test("buildTrendSeries gives every arm the same day axis", () => {
  const series = buildTrendSeries(
    [
      row({ day: "2026-09-01", arm: "ratel" }),
      row({ day: "2026-09-02", arm: "ratel" }),
      // legacy is missing the first day entirely.
      row({ day: "2026-09-02", arm: "legacy" }),
    ],
    "revealed",
  );

  assert.deepEqual(
    series.map((entry) => entry.arm),
    ["legacy", "ratel"],
  );
  for (const entry of series) {
    assert.equal(entry.points.length, 2);
  }
  // The missing day is a gap, not a shifted point.
  assert.equal(series[0].points[0].value, null);
  assert.equal(series[0].points[0].n, 0);
});

test("buildTrendSeries divides the stored sums rather than storing rates", () => {
  const series = buildTrendSeries(
    [row({ day: "2026-09-01", arm: "ratel", n: 20, contained: 15, creditSum: 12 })],
    "revealed",
  );

  assert.equal(series[0].points[0].value, 12 / 20);

  const containment = buildTrendSeries(
    [row({ day: "2026-09-01", arm: "ratel", n: 20, contained: 15, creditSum: 12 })],
    "revealed",
    "containment",
  );
  assert.equal(containment[0].points[0].value, 15 / 20);
});

test("a day with too few searches becomes a gap", () => {
  const series = buildTrendSeries(
    [
      row({ day: "2026-09-01", arm: "ratel", n: 2, contained: 2, creditSum: 2 }),
      row({ day: "2026-09-02", arm: "ratel", n: 40, contained: 25, creditSum: 20 }),
    ],
    "revealed",
  );

  // Two searches that both hit would plot as a 100% spike. It is not plotted.
  assert.equal(series[0].points[0].value, null);
  assert.equal(series[0].points[0].n, 2);
  assert.equal(series[0].points[1].value, 0.5);
});

test("buildTrendSeries keeps the tiers apart", () => {
  const rows = [
    row({ day: "2026-09-01", arm: "ratel", tier: "revealed", creditSum: 6 }),
    row({ day: "2026-09-01", arm: "ratel", tier: "judged", creditSum: 9 }),
  ];

  assert.equal(buildTrendSeries(rows, "revealed")[0].points[0].value, 0.6);
  assert.equal(buildTrendSeries(rows, "judged")[0].points[0].value, 0.9);
});

test("headlineTrend plots the answer key and never the old reference rows", () => {
  const rows = [
    row({ day: "2026-09-01", arm: "ratel", tier: "reference", creditSum: 9 }),
    row({ day: "2026-09-02", arm: "ratel", tier: "judged", creditSum: 7 }),
    row({ day: "2026-09-02", arm: "ratel", tier: "revealed", creditSum: 5 }),
  ];

  const trend = headlineTrend(rows);
  assert.equal(trend.tier, "judged");
  // Only the judged day is on the axis: the reference day is not drawn at all.
  assert.deepEqual(
    trend.series[0].points.map((point) => point.value),
    [0.7],
  );
});

test("headlineTrend falls back to revealed when the answer key has no plotted day", () => {
  const rows = [
    // Below the sample floor, so it is a gap rather than a point.
    row({ day: "2026-09-01", arm: "ratel", tier: "judged", n: 2, creditSum: 2 }),
    row({ day: "2026-09-01", arm: "ratel", tier: "revealed", creditSum: 5 }),
    row({ day: "2026-09-01", arm: "ratel", tier: "reference", creditSum: 9 }),
  ];

  const trend = headlineTrend(rows);
  assert.equal(trend.tier, "revealed");
  assert.equal(trend.series[0].points[0].value, 0.5);
  assert.deepEqual(headlineTrend([]), { tier: "judged", series: [] });
});

test("buildTrendSeries returns nothing for a tier with no rows", () => {
  assert.deepEqual(buildTrendSeries([], "revealed"), []);
});

function change(firstSeen: string, lastSeen = firstSeen): CatalogFingerprintChange {
  return {
    fingerprint: firstSeen,
    firstSeenAt: new Date(`${firstSeen}T00:00:00Z`),
    lastSeenAt: new Date(`${lastSeen}T00:00:00Z`),
    entryCount: 92,
    overriddenCount: 0,
    distinctCount: 92,
  };
}

test("trendMarkers only marks corpora that first appeared inside the window", () => {
  const window = {
    since: new Date("2026-09-01T00:00:00Z"),
    until: new Date("2026-09-08T00:00:00Z"),
  };

  const markers = trendMarkers(
    [
      // Still in use, but adopted before the window: the corpus stayed still.
      change("2026-08-15", "2026-09-06"),
      change("2026-09-04"),
      change("2026-09-02"),
    ],
    window,
  );

  assert.deepEqual(
    markers.map((marker) => marker.at.toISOString().slice(0, 10)),
    ["2026-09-02", "2026-09-04"],
  );
});

test("trendMarkers returns nothing when the corpus never changed", () => {
  const window = {
    since: new Date("2026-09-01T00:00:00Z"),
    until: new Date("2026-09-08T00:00:00Z"),
  };

  assert.deepEqual(trendMarkers([change("2026-08-15", "2026-09-06")], window), []);
});

test("trendMarkers does not mark the day we started looking as an edit", () => {
  const window = {
    since: new Date("2026-09-01T00:00:00Z"),
    until: new Date("2026-09-08T00:00:00Z"),
  };
  // A project onboarded mid-window: its first fingerprint is when we began
  // recording, and the second one is a real edit.
  const firstRecordedAt = new Date("2026-09-02T00:00:00Z");

  assert.deepEqual(
    trendMarkers([change("2026-09-04"), change("2026-09-02")], window, firstRecordedAt).map(
      (marker) => marker.at.toISOString().slice(0, 10),
    ),
    ["2026-09-04"],
  );
});

test("trendMarkers marks everything when the first recording is unknown", () => {
  const window = {
    since: new Date("2026-09-01T00:00:00Z"),
    until: new Date("2026-09-08T00:00:00Z"),
  };

  // Null is "we do not know", and a spurious rule is the safer failure.
  assert.equal(trendMarkers([change("2026-09-02")], window, null).length, 1);
});

test("trendMarkers keeps a change made on the day recording began", () => {
  const window = {
    since: new Date("2026-09-01T00:00:00Z"),
    until: new Date("2026-09-08T00:00:00Z"),
  };

  // Same day, later hour: a second fingerprint that day is a real edit, and
  // only the row carrying the first-recorded timestamp itself is skipped.
  const markers = trendMarkers(
    [
      change("2026-09-02"),
      {
        ...change("2026-09-02"),
        fingerprint: "later",
        firstSeenAt: new Date("2026-09-02T11:00:00Z"),
      },
    ],
    window,
    new Date("2026-09-02T00:00:00Z"),
  );

  assert.deepEqual(
    markers.map((marker) => marker.at.toISOString()),
    ["2026-09-02T11:00:00.000Z"],
  );
});

test("an archive day is re-scored on the current curve from its histogram", () => {
  // Written under plain nDCG: rank 2 summed as 0.63. The histogram is curve-free,
  // so the trend reads it at today's rank-2 credit instead.
  const [series] = buildTrendSeries(
    [
      row({
        day: "2026-09-01",
        arm: "ratel",
        n: 5,
        contained: 5,
        creditSum: 5 * 0.6309297535714574,
        rankHistogram: { "2": 5 },
      }),
    ],
    "revealed",
  );
  const value = series.points[0].value!;
  assert.ok(Math.abs(value - (0.5 + 0.5 * 0.6309297535714574)) < 1e-9);
});

test("a day whose histogram does not cover it keeps the stored credit", () => {
  const [series] = buildTrendSeries(
    [row({ day: "2026-09-01", arm: "ratel", rankHistogram: { "1": 3 } })],
    "revealed",
  );
  assert.equal(series.points[0].value, 0.6);
});
