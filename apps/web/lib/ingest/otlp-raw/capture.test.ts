import assert from "node:assert/strict";
import { test } from "node:test";
import { captureOtlpRawExport, type OtlpRawCaptureObservers } from "./capture";
import type { OtlpRawExportInput, OtlpRawStoreResult } from "./domain";

const INPUT: OtlpRawExportInput = {
  projectId: "proj-1",
  signal: "traces",
  contentType: "application/json",
  body: new TextEncoder().encode('{"secret":"do not log me"}'),
  itemCount: 1,
  traceIds: ["t1"],
};

test("with the flag off the store is never called", async () => {
  const { observers, calls } = recorder();
  let stored = 0;
  await captureOtlpRawExport(
    INPUT,
    "org-1",
    {
      isEnabled: async () => false,
      store: {
        store: async () => {
          stored += 1;
          return storedResult();
        },
      },
    },
    observers,
  );
  assert.equal(stored, 0);
  assert.deepEqual(calls, []);
});

test("without capture deps nothing happens", async () => {
  const { observers, calls } = recorder();
  await captureOtlpRawExport(INPUT, "org-1", undefined, observers);
  assert.deepEqual(calls, []);
});

test("with the flag on the export is stored, quietly", async () => {
  const { observers, calls } = recorder();
  const seen: OtlpRawExportInput[] = [];
  await captureOtlpRawExport(
    INPUT,
    "org-1",
    {
      isEnabled: async (projectId, organization) =>
        projectId === "proj-1" && organization === "org-1",
      store: {
        store: async (input) => {
          seen.push(input);
          return storedResult();
        },
      },
    },
    observers,
  );
  assert.deepEqual(seen, [INPUT]);
  assert.deepEqual(calls, []);
});

test("a skip over the daily cap logs sizes and emits one event, never the body", async () => {
  const { observers, calls } = recorder();
  await captureOtlpRawExport(
    INPUT,
    "org-1",
    {
      isEnabled: async () => true,
      store: {
        store: async () => ({
          stored: false,
          skipped: "over_daily_cap",
          rawBytes: 26,
          storedBytes: 40,
          usedBytes: 1000,
          capBytes: 1000,
        }),
      },
    },
    observers,
  );
  const sizes = {
    project_id: "proj-1",
    signal: "traces",
    reason: "over_daily_cap",
    raw_bytes: 26,
    stored_bytes: 40,
    used_bytes: 1000,
    cap_bytes: 1000,
  };
  assert.deepEqual(calls, [
    ["warn", "otlp raw capture skipped", sizes],
    ["event", "otlp_raw_capture_skipped", { projectId: "proj-1", orgId: "org-1" }, sizes],
  ]);
  assert.ok(!JSON.stringify(calls).includes("do not log me"));
});

test("a throwing store or flag is caught, logged with sizes and captured", async () => {
  for (const failing of ["flag", "store"] as const) {
    const { observers, calls } = recorder();
    const boom = new Error("db down");
    await captureOtlpRawExport(
      INPUT,
      "org-1",
      {
        isEnabled: async () => {
          if (failing === "flag") throw boom;
          return true;
        },
        store: {
          store: async () => {
            throw boom;
          },
        },
      },
      observers,
    );
    assert.deepEqual(calls, [
      [
        "error",
        "otlp raw capture failed",
        { project_id: "proj-1", signal: "traces", raw_bytes: INPUT.body.byteLength },
      ],
      ["capture", boom],
    ]);
  }
});

function recorder(): { observers: OtlpRawCaptureObservers; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    observers: {
      logError: (message, _error, fields) => calls.push(["error", message, fields]),
      logWarn: (message, fields) => calls.push(["warn", message, fields]),
      captureFailure: (error) => calls.push(["capture", error]),
      trackServerEvent: async (event, context, properties) => {
        calls.push(["event", event, context, properties]);
      },
    },
  };
}

function storedResult(): OtlpRawStoreResult {
  return { stored: true, id: "row-1", rawBytes: 26, storedBytes: 40 };
}
