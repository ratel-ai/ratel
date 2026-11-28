import assert from "node:assert/strict";
import { test } from "node:test";
import type { SqlResult } from "@/lib/synthesis/metrics/query";
import { sqlAsMetric } from "@/lib/views/dashboards/sql-chart";

const H1 = "2026-11-02T09:00:00.000Z";
const H2 = "2026-11-02T10:00:00.000Z";

const table = (columns: [string, string][], rows: unknown[][]): SqlResult => ({
  kind: "sql",
  columns: columns.map(([name, type]) => ({ name, type })),
  rows,
  truncated: false,
});

test("one time column and one number: one series by hour, in time order", () => {
  const result = sqlAsMetric(
    table(
      [
        ["hour", "timestamp"],
        ["traces", "integer"],
      ],
      [
        [H2, 3],
        [H1, 2],
      ],
    ),
  );
  assert.deepEqual(result, {
    kind: "metric",
    bucket: "hour",
    buckets: [H1, H2],
    series: [{ groups: [], total: 5, samples: 2, values: [2, 3] }],
  });
});

test("a text column splits one number into a series per value, highest total first", () => {
  const result = sqlAsMetric(
    table(
      [
        ["day", "timestamp"],
        ["model", "text"],
        ["calls", "integer"],
      ],
      [
        ["2026-11-01T00:00:00Z", "a", 1],
        ["2026-11-02T00:00:00Z", "b", 4],
        ["2026-11-02T00:00:00Z", "a", 2],
      ],
    ),
  );
  assert.equal(result?.bucket, "day");
  assert.deepEqual(
    result?.series.map(({ groups, values }) => [groups[0].value, values]),
    [
      ["b", [null, 4]],
      ["a", [1, 2]],
    ],
  );
});

test("two number columns are two series named after them", () => {
  const result = sqlAsMetric(
    table(
      [
        ["hour", "timestamp"],
        ["p50", "number"],
        ["p95", "number"],
      ],
      [[H1, 10, 90]],
    ),
  );
  assert.deepEqual(
    result?.series.map(({ groups, values }) => [groups[0].value, values]),
    [
      ["p95", [90]],
      ["p50", [10]],
    ],
  );
});

test("rows without one time column, without a number, or with text and two numbers are a table", () => {
  const cases: SqlResult[] = [
    table([["traces", "integer"]], [[3]]),
    table(
      [
        ["a", "timestamp"],
        ["b", "timestamp"],
        ["n", "integer"],
      ],
      [[H1, H2, 1]],
    ),
    table(
      [
        ["hour", "timestamp"],
        ["model", "text"],
      ],
      [[H1, "a"]],
    ),
    table(
      [
        ["hour", "timestamp"],
        ["model", "text"],
        ["x", "number"],
        ["y", "number"],
      ],
      [[H1, "a", 1, 2]],
    ),
    table(
      [
        ["hour", "timestamp"],
        ["n", "integer"],
      ],
      [],
    ),
  ];
  for (const result of cases) assert.equal(sqlAsMetric(result), null);
});

const WINDOW = {
  since: new Date("2026-11-02T09:00:00.000Z"),
  until: new Date("2026-11-02T12:00:00.000Z"),
};

test("with the frame of a count, every bucket of the window is drawn, an empty one as 0, with a total", () => {
  const result = sqlAsMetric(
    table(
      [
        ["bucket", "timestamp"],
        ["value", "integer"],
      ],
      [[H2, 3]],
    ),
    { window: WINDOW, bucket: "hour", nothing: 0 },
  );
  assert.deepEqual(result, {
    kind: "metric",
    bucket: "hour",
    buckets: [H1, H2, "2026-11-02T11:00:00.000Z"],
    series: [{ groups: [], total: 3, samples: 1, values: [0, 3, 0] }],
  });
});

test("with the frame of an average, an empty bucket has no value and no total is made up", () => {
  const result = sqlAsMetric(
    table(
      [
        ["bucket", "timestamp"],
        ["value", "number"],
      ],
      [],
    ),
    { window: WINDOW, bucket: "hour", nothing: null },
  );
  assert.deepEqual(result?.series, [
    { groups: [], total: null, samples: 0, values: [null, null, null] },
  ]);
});

test("a chart keeps the 10 groups of the highest sum", () => {
  const rows = Array.from({ length: 12 }, (_, index) => [H1, `g${index}`, index]);
  const result = sqlAsMetric(
    table(
      [
        ["bucket", "timestamp"],
        ["group", "text"],
        ["value", "integer"],
      ],
      rows,
    ),
    { window: WINDOW, bucket: "hour", nothing: 0 },
  );
  assert.equal(result?.series.length, 10);
  assert.deepEqual(result?.series[0].groups, [{ value: "g11" }]);
  assert.ok(!result?.series.some(({ groups }) => ["g0", "g1"].includes(groups[0].value)));
});
