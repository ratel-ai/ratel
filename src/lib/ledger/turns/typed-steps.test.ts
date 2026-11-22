import assert from "node:assert/strict";
import { test } from "node:test";
import { typedStepFixtures } from "@/lib/ingest/otlp/__fixtures__/typed-steps";
import { deriveModelCalls } from "@/lib/ingest/otlp/derive-model-calls";
import { deriveSteps } from "@/lib/ingest/otlp/derive-steps";
import { scheduleTraceTurnBuild } from "@/lib/ingest/trace-events/turns-schedule";
import { buildTurns } from "@/lib/ledger/turns/build-turn";
import { normalizeEvents } from "@/lib/ledger/turns/normalize";
import type { TurnEventRow } from "@/lib/ledger/types";

function events(model = true) {
  const fixtures = typedStepFixtures();
  const code = fixtures.docs[0];
  const spans = Array.from({ length: 25 }, (_, i) => ({
    ...code,
    spanId: String(i).padStart(16, "0"),
    startUnixMs: code.startUnixMs + i,
  }));
  const rows = [
    ...deriveSteps(spans),
    ...(model ? deriveModelCalls([{ ...fixtures.bareChat[0], traceId: code.traceId }]) : []),
  ];
  return normalizeEvents(
    rows.map((row, i) => ({
      ...row,
      id: String(i),
      receivedAt: new Date(code.startUnixMs + 100_000 - i),
      failed: row.errorMessage !== null,
    })) as TurnEventRow[],
    new Map(),
    { salt: "test" },
  );
}

test("code steps require GenAI work and stop at twenty in event-time order", () => {
  assert.deepEqual(buildTurns({ stored: [], events: events(false), now: new Date() }).turns, []);
  const [turn] = buildTurns({ stored: [], events: events(), now: new Date() }).turns;
  assert.equal(turn.steps.filter((s) => s.kind === "code").length, 20);
  assert.equal(turn.steps.filter((s) => s.kind === "model_call").length, 1);
  assert.equal(turn.invokeCount, 0);
  assert.equal(turn.clockSuspect, false);
  assert.deepEqual(
    turn.steps.map((s) => s.occurredAt.getTime()),
    turn.steps.map((s) => s.occurredAt.getTime()).sort((a, b) => a - b),
  );
});

test("a model-only or step-only ingest schedules a build", async () => {
  for (const type of ["otlp_model_call", "otlp_step"]) {
    let scheduled = 0;
    await scheduleTraceTurnBuild(
      {
        enqueueBuild: async () => {
          scheduled++;
          return { id: "build" };
        },
        scheduleProjectDrain: () => {},
      },
      { projectId: "sample", organization: null, eventTypes: [type], accepted: 1 },
    );
    assert.equal(scheduled, 1, type);
  }
});
