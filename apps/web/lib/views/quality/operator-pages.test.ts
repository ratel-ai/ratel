import assert from "node:assert/strict";
import { test } from "node:test";
import type { QualityView } from "@/lib/synthesis/quality/service";
import type { OperatorConsole } from "@/lib/views/quality/operator-console";
import {
  loadOperatorQualityDetail,
  loadOperatorQualityIndex,
  type OperatorQualityDeps,
  type OperatorQualityReads,
  QUALITY_WINDOW_OPTIONS,
} from "@/lib/views/quality/operator-pages";

const is404 = (err: { digest?: string }) => String(err.digest).includes("404");

function Frame() {
  return null;
}

/** Every read, recording its name; a read before `authorize` resolves is the failure. */
function harness(options: {
  slot?: "absent" | "refuses" | "allows";
  db?: boolean;
  calibrations?: Array<{ experimentName: string; comparisonCount: number }>;
  view?: QualityView | null;
}) {
  const calls: string[] = [];
  const slot = options.slot ?? "allows";
  const operator: OperatorConsole | undefined =
    slot === "absent"
      ? undefined
      : {
          authorize: async () => {
            calls.push("authorize");
            if (slot === "refuses")
              throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), {
                digest: "NEXT_HTTP_ERROR_FALLBACK;404",
              });
          },
          Frame,
        };
  const reads: OperatorQualityReads = {
    listQualityProjectSummaries: async () => {
      calls.push("listQualityProjectSummaries");
      return [];
    },
    listQualityCalibrations: async (projectId) => {
      calls.push(`listQualityCalibrations:${projectId}`);
      return options.calibrations ?? [{ experimentName: "shadow-a", comparisonCount: 12 }];
    },
    loadQualityView: async (projectId, experimentName) => {
      calls.push(`loadQualityView:${projectId}:${experimentName}`);
      return options.view === undefined ? ({ projectName: "Acme" } as QualityView) : options.view;
    },
    loadQualityTrend: async () => {
      calls.push("loadQualityTrend");
      return [];
    },
    loadFingerprintChanges: async () => {
      calls.push("loadFingerprintChanges");
      return [];
    },
    loadFirstFingerprintAt: async () => {
      calls.push("loadFirstFingerprintAt");
      return null;
    },
    countComparisonsPerWindow: async (_projectId, _experimentName, windows) => {
      calls.push(`countComparisonsPerWindow:${windows.join(",")}`);
      return { counts: new Map(), earliest: null };
    },
  };
  const deps: OperatorQualityDeps = {
    operatorConsole: async () => {
      calls.push("operatorConsole");
      return operator;
    },
    isDbConfigured: () => {
      calls.push("isDbConfigured");
      return options.db ?? true;
    },
    reads: () => {
      calls.push("reads");
      return reads;
    },
  };
  return { calls, deps };
}

test("the index is a 404 without the edition's operator console, and reads nothing", async () => {
  const { calls, deps } = harness({ slot: "absent" });
  await assert.rejects(loadOperatorQualityIndex(undefined, deps), is404);
  assert.deepEqual(calls, ["operatorConsole"]);
});

test("the index reads nothing when the operator console refuses the reader", async () => {
  const { calls, deps } = harness({ slot: "refuses" });
  await assert.rejects(loadOperatorQualityIndex(undefined, deps), is404);
  assert.deepEqual(calls, ["operatorConsole", "authorize"]);
});

test("the index lists every project once the reader is authorized", async () => {
  const { calls, deps } = harness({});
  const page = await loadOperatorQualityIndex("30", deps);
  assert.equal(page.state, "ready");
  assert.equal(page.Frame, Frame);
  assert.equal(page.state === "ready" && page.windowDays, 30);
  assert.deepEqual(calls, [
    "operatorConsole",
    "authorize",
    "isDbConfigured",
    "reads",
    "listQualityProjectSummaries",
  ]);
});

test("the index says there is no database after authorizing, as upstream", async () => {
  const { calls, deps } = harness({ db: false });
  const page = await loadOperatorQualityIndex(undefined, deps);
  assert.equal(page.state, "no-database");
  assert.deepEqual(calls, ["operatorConsole", "authorize", "isDbConfigured"]);
});

test("the detail is a 404 without the edition's operator console, and reads nothing", async () => {
  const { calls, deps } = harness({ slot: "absent" });
  await assert.rejects(loadOperatorQualityDetail("p1", {}, deps), is404);
  assert.deepEqual(calls, ["operatorConsole"]);
});

test("the detail reads nothing when the operator console refuses the reader", async () => {
  const { calls, deps } = harness({ slot: "refuses" });
  await assert.rejects(loadOperatorQualityDetail("p1", {}, deps), is404);
  assert.deepEqual(calls, ["operatorConsole", "authorize"]);
});

test("the detail loads upstream's five reads for the first calibration once authorized", async () => {
  const { calls, deps } = harness({
    calibrations: [
      { experimentName: "shadow-a", comparisonCount: 40 },
      { experimentName: "shadow-b", comparisonCount: 3 },
    ],
  });
  const page = await loadOperatorQualityDetail("p1", { days: "7" }, deps);
  assert.equal(page.state, "ready");
  assert.equal(page.state === "ready" && page.experimentName, "shadow-a");
  assert.equal(page.state === "ready" && page.windowDays, 7);
  assert.deepEqual(calls.slice(0, 5), [
    "operatorConsole",
    "authorize",
    "isDbConfigured",
    "reads",
    "listQualityCalibrations:p1",
  ]);
  assert.deepEqual(
    new Set(calls.slice(5)),
    new Set([
      "loadQualityView:p1:shadow-a",
      "loadQualityTrend",
      "loadFingerprintChanges",
      "loadFirstFingerprintAt",
      `countComparisonsPerWindow:${QUALITY_WINDOW_OPTIONS.join(",")}`,
    ]),
  );
});

test("the detail reads the calibration the address names", async () => {
  const { calls, deps } = harness({});
  await loadOperatorQualityDetail("p1", { calibration: "shadow-b" }, deps);
  assert.ok(calls.includes("loadQualityView:p1:shadow-b"));
});

test("the detail without a calibration in the window says so and reads no view", async () => {
  const { calls, deps } = harness({ calibrations: [] });
  const page = await loadOperatorQualityDetail("p1", { days: "14" }, deps);
  assert.equal(page.state, "no-calibration");
  assert.equal(page.state === "no-calibration" && page.windowDays, 14);
  assert.ok(!calls.some((call) => call.startsWith("loadQualityView")));
});

test("the detail is a 404 when the project has no view", async () => {
  const { deps } = harness({ view: null });
  await assert.rejects(loadOperatorQualityDetail("p1", {}, deps), is404);
});

test("the offered windows are upstream's", () => {
  assert.deepEqual(QUALITY_WINDOW_OPTIONS, [7, 14, 30, 90]);
});
