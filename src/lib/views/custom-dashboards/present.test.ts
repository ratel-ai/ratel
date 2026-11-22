import assert from "node:assert/strict";
import { test } from "node:test";
import { byValueDesc } from "./present";

/** RC-888: bars and tables read best first; the query picks the top N by runs, the widget orders them by the metric. */

test("groups order by value, highest first, with no value last and ties by runs", () => {
  const groups = [
    { key: "northwind", value: 3.91, runs: 225 },
    { key: null, value: null, runs: 4 },
    { key: "oakridge", value: 4.08, runs: 223 },
    { key: "tie-few", value: 1, runs: 2 },
    { key: "tie-many", value: 1, runs: 9 },
  ];
  assert.deepEqual(
    byValueDesc(groups).map((group) => group.key),
    ["oakridge", "northwind", "tie-many", "tie-few", null],
  );
  assert.equal(groups[0]!.key, "northwind", "the input is left as it was");
});
