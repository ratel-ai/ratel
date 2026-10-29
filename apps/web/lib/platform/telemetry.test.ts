import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reportServerException,
  SERVER_EVENT_NAMES,
  toTelemetryContext,
  trackProductEvent,
  trackServerEvent,
} from "./telemetry";

test("contexts resolve to one distinct id: user, project or explicit", () => {
  assert.deepEqual(toTelemetryContext({ externalId: "user_1", orgId: "o" }), {
    distinctId: "user_1",
    orgId: "o",
    projectId: undefined,
  });
  assert.deepEqual(toTelemetryContext({ projectId: "p1" }), {
    distinctId: "project:p1",
    orgId: undefined,
    projectId: "p1",
  });
  assert.deepEqual(toTelemetryContext({ distinctId: "system:drain" }), {
    distinctId: "system:drain",
    orgId: undefined,
    projectId: undefined,
  });
});

test("event names stay unique and carry no Cloud-only event", () => {
  assert.equal(new Set(SERVER_EVENT_NAMES).size, SERVER_EVENT_NAMES.length);
  for (const name of SERVER_EVENT_NAMES) {
    assert.doesNotMatch(
      name,
      /checkout|plan_changed|invitation|welcome|support_session|credits|billing|recharge|webhook/,
    );
  }
});

test("tracking and reporting never throw into the caller", async () => {
  await assert.doesNotReject(
    trackServerEvent("job_completed", { projectId: "p1" }, { duration_ms: 12 }),
  );
  await assert.doesNotReject(
    trackProductEvent(
      "project_created",
      { externalId: "u1", orgId: "o1" },
      { project_slug: "agent" },
    ),
  );
  assert.doesNotThrow(() => reportServerException(new Error("x"), "system:test", { op: "t" }));
});

test("trackProductEvent hands the typed properties to the tracker unchanged", async () => {
  const seen: unknown[] = [];
  await trackProductEvent(
    "api_key_expired",
    { projectId: "p1" },
    { key_prefix: "rtl_x" },
    async (event, context, properties) => {
      seen.push([event, context, properties]);
    },
  );
  assert.deepEqual(seen, [["api_key_expired", { projectId: "p1" }, { key_prefix: "rtl_x" }]]);
});
