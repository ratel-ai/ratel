import assert from "node:assert/strict";
import { test } from "node:test";
import { metricQuery } from "@/lib/contracts/query";
import type { SqlResult } from "@/lib/synthesis/metrics/query";
import {
  drawnChart,
  formAsMetric,
  scrollsInCard,
  sqlAsMetric,
} from "@/lib/views/dashboards/sql-chart";
import { formOf } from "@/lib/views/dashboards/widget";

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

test("the chart drawn: rows that cannot fill the chosen chart are a table, which scrolls in its card", () => {
  const traces = table(
    [
      ["trace_id", "text"],
      ["started_at", "timestamp"],
    ],
    [["t1", H1]],
  );
  assert.equal(drawnChart("bar", traces), "table");
  assert.equal(drawnChart("line", traces), "table");
  const series = table(
    [
      ["hour", "timestamp"],
      ["traces", "integer"],
    ],
    [[H1, 1]],
  );
  assert.equal(drawnChart("bar", series), "bar");
  // A result of another kind draws its own chart.
  assert.equal(drawnChart("line", null), "line");
});

test("a text of the form cut at the row cap leaves the buckets it dropped empty, never 0", () => {
  const form = formOf(
    metricQuery("trace_count", "count", { dimensions: ["tool"], bucket: "hour" }),
  );
  const window = {
    since: new Date("2026-11-02T06:00:00.000Z"),
    until: new Date("2026-11-02T12:00:00.000Z"),
  };
  const hour = (h: number) => `2026-11-02T${String(h).padStart(2, "0")}:00:00.000Z`;
  // Newest first, cut inside 09:00: the rows of 06:00 to 08:00 and part of 09:00 are gone.
  const rows = [11, 10, 9].flatMap((h) => [
    [hour(h), "a", 2],
    [hour(h), "b", 1],
  ]);
  const cut = {
    ...table(
      [
        ["bucket", "timestamp"],
        ["tool", "text"],
        ["value", "integer"],
      ],
      rows.slice(0, 5),
    ),
    truncated: true,
  };
  const drawn = formAsMetric(cut, form, "line", window);
  const a = drawn.series.find(({ groups }) => groups[0]?.value === "a");
  assert.deepEqual(a?.values, [null, null, null, null, 2, 2]);
  // Whole rows: an hour with no row is 0, as the form drew it.
  const whole = formAsMetric({ ...cut, rows, truncated: false }, form, "line", window);
  assert.deepEqual(
    whole.series.find(({ groups }) => groups[0]?.value === "a")?.values,
    [0, 0, 0, 2, 2, 2],
  );
});

test("a card scrolls a list of bars and a table inside it; a time chart keeps its readout free", () => {
  const bars = table(
    [
      ["tool", "text"],
      ["error_rate", "number"],
    ],
    Array.from({ length: 18 }, (_, index) => [`tool_${index}`, index / 100]),
  );
  assert.equal(scrollsInCard("bar", bars), true);
  assert.equal(scrollsInCard("table", bars), true);
  const timed = table(
    [
      ["hour", "timestamp"],
      ["traces", "integer"],
    ],
    [[H1, 2]],
  );
  assert.equal(scrollsInCard("bar", timed), false);
  assert.equal(scrollsInCard("line", timed), false);
  // A line its rows cannot fill is drawn as a table, which scrolls.
  assert.equal(scrollsInCard("line", bars), true);
  // A metric's own line and bar draw over time.
  assert.equal(scrollsInCard("bar", { kind: "metric" }), false);
  assert.equal(scrollsInCard("number", null), true);
});
