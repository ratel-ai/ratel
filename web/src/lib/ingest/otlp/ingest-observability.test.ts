import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type IngestObservabilityDeps,
  rejectIngestRequest,
  shouldSampleIngestRejection,
} from "./ingest-observability";

function recorder(sampled: boolean) {
  const events: unknown[][] = [];
  const logs: unknown[][] = [];
  const deps: IngestObservabilityDeps = {
    trackServerEvent: async (...args) => {
      events.push(args);
    },
    shouldSampleRejection: () => sampled,
    logWarn: (...args) => logs.push(args),
    now: () => new Date(1050),
  };
  return { events, logs, deps };
}

test("a sampled-out rejection skips the telemetry event", async () => {
  const { events, logs, deps } = recorder(false);

  const response = await rejectIngestRequest(new Response("nope", { status: 401 }), "invalid_key", {
    endpoint: "/v1/traces",
    startedAt: 1000,
    deps,
    projectId: "project_1",
  });

  assert.equal(response.status, 401);
  assert.deepEqual(events, []); // no per-request telemetry event
  assert.deepEqual(logs, [
    [
      "request rejected",
      {
        endpoint: "/v1/traces",
        outcome: "rejected",
        reason: "invalid_key",
        status: 401,
        duration_ms: 50,
      },
    ],
  ]);
});

test("a sampled-in rejection emits the taxonomy event", async () => {
  const { events, deps } = recorder(true);

  const response = await rejectIngestRequest(new Response("nope", { status: 401 }), "invalid_key", {
    endpoint: "/v1/traces",
    startedAt: 1000,
    deps,
    projectId: "project_1",
    organizationId: "org_1",
  });

  assert.equal(response.status, 401);
  assert.deepEqual(events, [
    [
      "otlp_ingest_request",
      { projectId: "project_1", orgId: "org_1" },
      {
        endpoint: "/v1/traces",
        outcome: "rejected",
        reason: "invalid_key",
        status: 401,
        duration_ms: 50,
      },
    ],
  ]);
});

test("rejection sampling honours the one-in-N rate", () => {
  assert.equal(
    shouldSampleIngestRejection(() => 0, "100"),
    true,
  ); // 0 < 1/100
  assert.equal(
    shouldSampleIngestRejection(() => 0.5, "100"),
    false,
  ); // 0.5 >= 1/100
  assert.equal(
    shouldSampleIngestRejection(() => 0, "0"),
    false,
  ); // disabled
  assert.equal(
    shouldSampleIngestRejection(() => 0.999, "1"),
    true,
  ); // keep all
});
