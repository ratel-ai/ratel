import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isImportedSourceId } from "@/lib/ledger/constants";
import { createImportedRuns, type ImportedRunsDeps } from "@/lib/ledger/imported-runs";

const ORG = { id: "o", name: "Acme", slug: "acme" };

function fakes(runsJobs: boolean) {
  const calls: unknown[][] = [];
  const deps: ImportedRunsDeps = {
    persistDecodedSpans: async (spans, context, persistDeps) => {
      calls.push(["persist", spans, context, persistDeps]);
      return { ok: true, accepted: 1, calls: 1, rows: [] };
    },
    enqueueBuildTraceTurnsJob: async (projectId, _db, request) => {
      calls.push(["build", projectId, request]);
      return { id: "b" };
    },
    drainProjectJobs: async (projectId) => {
      calls.push(["drain", projectId]);
      return { done: 0, failed: 0 };
    },
    enqueueJob: async (input) => {
      calls.push(["enqueue", input]);
      return { id: "j" };
    },
    scheduleProjectDrain: (projectId) => calls.push(["schedule", projectId]),
    runsJobsAfterResponse: () => runsJobs,
  };
  return { calls, port: createImportedRuns(deps) };
}

describe("createImportedRuns", () => {
  it("stores spans as an import: no allowance spent, no fold kick, the build queued without a drain", async () => {
    const { calls, port } = fakes(true);
    const report = { logError: () => {}, captureFailure: () => {} };
    assert.deepEqual(await port.persist("p", ORG, [], report), {
      ok: true,
      accepted: 1,
      calls: 1,
      rows: [],
    });
    const [, , context, persistDeps] = calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
      {
        traceTurns: {
          enqueueBuild: (id: string) => Promise<unknown>;
          scheduleProjectDrain: (id: string) => void;
        };
        logError: unknown;
        captureFailure: unknown;
        modelPricing?: { loadOverrides: unknown };
        agentSpanDedupe: unknown;
      },
    ];
    assert.deepEqual(context, {
      projectId: "p",
      organization: ORG,
      endpoint: "health_import",
      foldIntentGraph: false,
      // A reprocess after a mapper fix must reach the spans already stored (upstream #465).
      spanConflict: "update",
    });
    // An imported run's agent root carries no model or usage: no dedupe (upstream #461).
    assert.equal(persistDeps.agentSpanDedupe, null);
    assert.equal(persistDeps.logError, report.logError);
    assert.equal(persistDeps.captureFailure, report.captureFailure);
    // An imported run is priced with the project's own prices, as live ingest prices it (RC-482).
    assert.equal(typeof persistDeps.modelPricing?.loadOverrides, "function");
    await persistDeps.traceTurns.enqueueBuild("p");
    persistDeps.traceTurns.scheduleProjectDrain("p");
    assert.deepEqual(calls.slice(1), [["build", "p", undefined]]);
  });

  it("asks for a manual reading, and drains only where this process runs jobs", async () => {
    const worker = fakes(true);
    await worker.port.requestReading("p");
    assert.deepEqual(worker.calls, [
      ["build", "p", { reading: "manual" }],
      ["drain", "p"],
    ]);
    const api = fakes(false);
    await api.port.requestReading("p");
    assert.deepEqual(api.calls, [["build", "p", { reading: "manual" }]]);
  });

  it("queues a job and schedules the project's drain", async () => {
    const { calls, port } = fakes(true);
    assert.deepEqual(await port.enqueueJob("p", "run_import", { importId: "i" }), { id: "j" });
    port.scheduleDrain("p");
    assert.deepEqual(calls, [
      ["enqueue", { projectId: "p", kind: "run_import", payload: { importId: "i" } }],
      ["schedule", "p"],
    ]);
  });

  it("registers the importer's source ids with the ledger", () => {
    const { port } = fakes(true);
    assert.equal(isImportedSourceId("relay-import"), false);
    port.registerSourceIds?.(["relay-import"]);
    assert.equal(isImportedSourceId("relay-import"), true);
  });
});
