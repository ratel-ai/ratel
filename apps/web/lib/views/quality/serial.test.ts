import assert from "node:assert/strict";
import { test } from "node:test";
import type { CalibrationQueries } from "@/lib/synthesis/experiments/calibration-service";
import { oneAtATime } from "./serial";

const WINDOW = { since: new Date("2026-10-01T00:00:00Z"), until: new Date("2026-10-08T00:00:00Z") };

test("calibration reads run one at a time, in call order, and a failure stays with its caller", async () => {
  let running = 0;
  let overlap = 0;
  const order: string[] = [];
  const read =
    <T>(name: string, value: T, fail = false) =>
    async (): Promise<T> => {
      running += 1;
      overlap = Math.max(overlap, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      order.push(name);
      running -= 1;
      if (fail) throw new Error(`${name} failed`);
      return value;
    };
  const queries: CalibrationQueries = {
    countExperimentComparisons: read("census", []),
    getRankingComparisonSummary: read("pairs", [], true),
    listRankingComparisons: read("rows", []),
    countRankingComparisons: read("count", 3),
    listExperimentLifecycleArmMetrics: read("lifecycle", []),
  };
  const serial = oneAtATime(queries);
  const results = await Promise.allSettled([
    serial.getRankingComparisonSummary("p", "e", WINDOW),
    serial.listRankingComparisons("p", "e", WINDOW, {}),
    serial.listExperimentLifecycleArmMetrics("p", "e", WINDOW),
    serial.countRankingComparisons("p", "e", WINDOW, {}),
  ]);
  assert.equal(overlap, 1, "never two queries on the client at once");
  assert.deepEqual(order, ["pairs", "rows", "lifecycle", "count"]);
  assert.equal(results[0]!.status, "rejected");
  assert.deepEqual(
    results.slice(1).map((result) => result.status),
    ["fulfilled", "fulfilled", "fulfilled"],
  );
  assert.equal((results[3] as PromiseFulfilledResult<number>).value, 3);
});
