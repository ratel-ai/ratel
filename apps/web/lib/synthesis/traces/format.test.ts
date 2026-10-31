import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatAttributeValue,
  formatCostUsd,
  formatCount,
  formatDuration,
  formatSpanKind,
  formatSpanStatus,
  formatTimestamp,
  formatTokens,
  traceStatusCode,
} from "./format";

test("trace formatters produce deterministic UTC and compact telemetry labels", () => {
  assert.deepEqual(
    {
      timestamp: formatTimestamp("2026-07-30T12:00:00.125+02:00"),
      compactTimestamp: formatTimestamp("2026-07-30T12:00:00.125+02:00", "compact"),
      durations: [
        formatDuration(0),
        formatDuration(0.125),
        formatDuration(250.4),
        formatDuration(1_250),
        formatDuration(62_500),
      ],
      tokens: formatTokens(12_450),
      costs: [
        formatCostUsd(0),
        formatCostUsd("0.004"),
        formatCostUsd("0.000125"),
        formatCostUsd(null),
      ],
      kinds: [formatSpanKind(3), formatSpanKind(99)],
      statuses: [formatSpanStatus(0), formatSpanStatus(1), formatSpanStatus(2)],
      attribute: formatAttributeValue({
        z: 1,
        a: { b: 2, a: 1 },
      }),
    },
    {
      timestamp: "2026-07-30 10:00:00.125 UTC",
      compactTimestamp: "07-30 10:00:00",
      durations: ["0ms", "0.125ms", "250ms", "1.25s", "1m 2.5s"],
      tokens: "12,450",
      costs: ["$0.00", "$0.0040", "$0.00013", "—"],
      kinds: ["Client", "Unknown (99)"],
      statuses: ["Unset", "OK", "Error"],
      attribute: '{"a":{"a":1,"b":2},"z":1}',
    },
  );
});

test("formatDuration carries remainders that round up into the next unit", () => {
  assert.deepEqual(
    [
      formatDuration(999.6),
      formatDuration(59_990),
      formatDuration(359_990),
      formatDuration(3_599_990),
      formatDuration(3_600_000.4),
    ],
    ["1s", "1m", "6m", "1h", "1h"],
  );
});

test("formatDuration labels hour-scale, whole-minute, and invalid durations", () => {
  assert.deepEqual(
    [
      formatDuration(120_000),
      formatDuration(5_025_000),
      formatDuration(9_000_000),
      formatDuration(-1),
      formatDuration(Number.NaN),
      formatDuration(Number.POSITIVE_INFINITY),
    ],
    ["2m", "1h 23m 45s", "2h 30m", "—", "—", "—"],
  );
});

test("formatCostUsd keeps two decimals at a cent or more, including string values", () => {
  assert.deepEqual(
    [formatCostUsd(0.01), formatCostUsd(12.5), formatCostUsd("2")],
    ["$0.01", "$12.50", "$2.00"],
  );
});

test("formatCount uses telemetry nouns with compact, consistent number formatting", () => {
  assert.deepEqual(
    [
      formatCount(0, "span"),
      formatCount(1, "span"),
      formatCount(12_450, "span"),
      formatCount(12_450),
      formatCount(Number.NaN, "trace"),
    ],
    ["0 spans", "1 span", "12,450 spans", "12,450", "—"],
  );
});

test("trace statuses normalize to the OK, Error, and Unset taxonomy", () => {
  assert.deepEqual(
    [
      traceStatusCode(0, 0),
      traceStatusCode(1, 0),
      traceStatusCode(1, 2),
      traceStatusCode(99, 0),
    ].map(formatSpanStatus),
    ["Unset", "OK", "Error", "Unset"],
  );
});

test("formatAttributeValue passes strings through untouched", () => {
  assert.equal(formatAttributeValue("plain text"), "plain text");
  assert.equal(formatAttributeValue('{"already":"json"}'), '{"already":"json"}');
});
