import assert from "node:assert/strict";
import { test } from "node:test";
import { statsOfUseCase } from "../domain/stats";
import type { ResolvedTurn, UseCaseCall } from "../resolve";

/**
 * RC-1125: the volume, the model and the cost per run of a use case. The
 * costs are the stored ones (`events.cost_usd`, the price book's, as
 * `get_cost_by_day` sums them); a call with no price is Unpriced, never $0.
 */

const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 9, minute));
const call = (model: string, costUsd: number | null, minute: number): UseCaseCall => ({
  traceId: "t",
  spanId: "s",
  spanName: "chat",
  model,
  occurredAt: at(minute),
  costUsd,
  inputTokens: 100,
  outputTokens: 10,
});
const turn = (id: string, minute: number, calls: UseCaseCall[]): ResolvedTurn => ({
  turnId: id,
  taskId: "triage",
  startedAt: at(minute),
  endedAt: at(minute + 1),
  traceIds: ["t"],
  calls,
});

test("cost per run averages the runs whose calls are all priced, by hand: (0.03 + 0.05) / 2 = 0.04", () => {
  const turns = [
    turn("a", 0, [call("claude-haiku", 0.01, 0), call("claude-haiku", 0.02, 0)]),
    turn("b", 10, [call("claude-haiku", 0.05, 10)]),
    turn("c", 20, [call("claude-opus", 0.1, 20), call("claude-opus", null, 20)]),
    turn("d", 30, []),
  ];
  const stats = statsOfUseCase(turns, { turns: 4, firstEndedAt: at(1), lastEndedAt: at(31) });
  assert.deepEqual(stats, {
    turns: 4,
    calls: 5,
    firstEndedAt: "2026-11-10T09:01:00.000Z",
    lastEndedAt: "2026-11-10T09:31:00.000Z",
    currentModel: "claude-haiku",
    costPerRunUsd: 0.04,
    pricedRuns: 2,
    unpricedCalls: 1,
    sampled: false,
  });
});

test("with no priced run the cost per run is Unpriced (null), not zero", () => {
  const stats = statsOfUseCase([turn("a", 0, [call("my-model", null, 0)])], {
    turns: 1,
    firstEndedAt: at(1),
    lastEndedAt: at(1),
  });
  assert.equal(stats.costPerRunUsd, null);
  assert.equal(stats.unpricedCalls, 1);
  assert.equal(stats.pricedRuns, 0);
});

test("the current model is the most used one; a tie goes to the one used last", () => {
  const stats = statsOfUseCase(
    [turn("a", 0, [call("claude-opus", 0.1, 0)]), turn("b", 10, [call("claude-haiku", 0.01, 10)])],
    { turns: 2, firstEndedAt: at(1), lastEndedAt: at(11) },
  );
  assert.equal(stats.currentModel, "claude-haiku");
});

test("no turn: zero volume, no model, no cost; more turns than read: sampled", () => {
  assert.deepEqual(statsOfUseCase([], { turns: 0, firstEndedAt: null, lastEndedAt: null }), {
    turns: 0,
    calls: 0,
    firstEndedAt: null,
    lastEndedAt: null,
    currentModel: null,
    costPerRunUsd: null,
    pricedRuns: 0,
    unpricedCalls: 0,
    sampled: false,
  });
  assert.equal(
    statsOfUseCase([turn("a", 0, [])], { turns: 5000, firstEndedAt: at(0), lastEndedAt: at(1) })
      .sampled,
    true,
  );
});
