import assert from "node:assert/strict";
import { test } from "node:test";
import {
  v1EndpointRemovedResponse,
  v1MutationErrorResponse,
  v1QuotaExceededResponse,
} from "@/lib/platform/v1-errors";

/**
 * Pins the v1 wire contract: `error` is a machine code (the SDK's
 * `CloudSdkError.code`), `reason` the finer-grained mutation reason. Must stay
 * in lockstep with the SDK's mock server (mock-cloud.ts).
 */

test("not_found → 404 { error: 'not_found' } with no reason", async () => {
  const res = v1MutationErrorResponse("not_found");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("state conflicts → 409 { error: 'conflict', reason } for each conflict kind", async () => {
  for (const reason of ["version_conflict", "name_conflict"] as const) {
    const res = v1MutationErrorResponse(reason);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "conflict", reason });
  }
});

test("quota exceeded → 403 { error: 'quota_exceeded', reason, message }", async () => {
  const res = v1QuotaExceededResponse("maxSkillsPerProject", "You've reached your plan's limit.");
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), {
    error: "quota_exceeded",
    reason: "maxSkillsPerProject",
    message: "You've reached your plan's limit.",
  });
});

test("removed endpoint → 410 { error: 'endpoint_removed', message }", async () => {
  const res = v1EndpointRemovedResponse("This endpoint was removed on 2026-10-15.");
  assert.equal(res.status, 410);
  assert.deepEqual(await res.json(), {
    error: "endpoint_removed",
    message: "This endpoint was removed on 2026-10-15.",
  });
});
