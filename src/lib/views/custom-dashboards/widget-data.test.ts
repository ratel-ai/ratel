import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWidgetData } from "./widget-data";

/** RC-888: widgets load at the same time, and one failed widget does not break the others. */

test("each widget gets its own result; a failed one reads failed", async () => {
  let running = 0;
  let peak = 0;
  const data = await loadWidgetData(
    "p",
    [
      { id: "a", spec: { metric: "runs" } },
      { id: "b", spec: { metric: "boom" } },
      { id: "c", spec: { metric: "cost" } },
    ],
    {
      pivots: [],
      run: async (_project, spec) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        if ((spec as { metric: string }).metric === "boom") throw new Error("statement timeout");
        return { kind: "total", value: 1, runs: 1 };
      },
    },
  );
  assert.deepEqual(data, [
    { widgetId: "a", result: { kind: "total", value: 1, runs: 1 } },
    { widgetId: "b", failed: true },
    { widgetId: "c", result: { kind: "total", value: 1, runs: 1 } },
  ]);
  assert.equal(peak, 3, "the queries run in parallel");
});
