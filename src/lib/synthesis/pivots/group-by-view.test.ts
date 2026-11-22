import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pickGroupPivot,
  pivotGroupRowViews,
  withGroupPivot,
} from "@/lib/synthesis/pivots/group-by-view";
import { traceFilterFromSearch } from "@/lib/synthesis/traces/v2/filters";

const PIVOTS = [
  { key: "client", label: "Client company" },
  { key: "end_user", label: "End user" },
];

test("the picked pivot is the configured one the URL names, else the first, else none", () => {
  assert.equal(pickGroupPivot(PIVOTS, "end_user")?.key, "end_user");
  assert.equal(pickGroupPivot(PIVOTS, ["end_user", "client"])?.key, "end_user");
  assert.equal(pickGroupPivot(PIVOTS, "secret")?.key, "client");
  assert.equal(pickGroupPivot(PIVOTS, undefined)?.key, "client");
  assert.equal(pickGroupPivot([], "client"), null);
});

test("a value row links to Sessions filtered by it; Other and (none) link nowhere", () => {
  const rows = pivotGroupRowViews(
    {
      rows: [
        { kind: "value", value: "a&b", runs: 6, errorRate: 0.5, p50Ms: 120, costUsd: 1.5 },
        { kind: "other", value: null, runs: 3, errorRate: 0, p50Ms: 90, costUsd: 0.2 },
        { kind: "none", value: null, runs: 1, errorRate: 1, p50Ms: 10, costUsd: 0 },
      ],
      totalRuns: 10,
    },
    "client",
    "/project/p1",
  );
  assert.deepEqual(
    rows.map((row) => [row.label, row.muted, row.share, row.href]),
    [
      ["a&b", false, 0.6, "/project/p1/traces?pivot.client=a%26b"],
      ["Other", true, 0.3, null],
      ["(none)", true, 0.1, null],
    ],
  );
  const search = rows[0].href!.slice(rows[0].href!.indexOf("?"));
  assert.deepEqual(traceFilterFromSearch(search, { pivots: PIVOTS }), {
    pivots: { client: ["a&b"] },
  });
});

test("picking another pivot keeps the window", () => {
  assert.equal(withGroupPivot("?range=30d&pivot=client", "end_user"), "?range=30d&pivot=end_user");
  assert.equal(withGroupPivot("", "client"), "?pivot=client");
});
