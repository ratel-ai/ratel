import assert from "node:assert/strict";
import { test } from "node:test";
import { detectInTurn } from "@/lib/readings/trace-signals/self-corrections/detect";
import { fresh, signalTurns, statsOf } from "@/lib/readings/trace-signals/signals/test-fixtures";
import {
  classifyOtelTurnShape,
  classifyTurnShape,
  turnWaste,
} from "@/lib/readings/trace-signals/signals/turn-facts";

/**
 * The per-turn readings that count retries read them from the
 * self-corrections module: the "Wasted calls" retries, the `retry` and
 * OpenTelemetry shapes, and `error_loop`'s retries all agree with
 * `retry_after_error`, `switch_after_error` and `gave_up_after_error`.
 */

const TURNS = signalTurns([
  fresh().invoke("a").error("a").invoke("a"),
  fresh().invoke("a").error("a").invoke("b").invoke("a"),
  fresh().invoke("a").error("a").invoke("a").error("a").invoke("a").error("a"),
  fresh().invoke("a").invoke("a").invoke("b"),
  fresh().invoke("a").error("a").invoke("b").error("b"),
  fresh().search(["a"]).invoke("a").search(["a"]).invoke("a"),
  fresh().skill("s").gatewayError("g").gatewayInvoke("g"),
  fresh().invoke("a").invoke("b").invoke("c"),
]);

const retriesOf = (steps: Parameters<typeof detectInTurn>[0]) =>
  detectInTurn(steps).filter((e) => e.kind === "retry_after_error");

test("wasted-call retries are the module's retries after an error; the other calls again are repeats", () => {
  for (const turn of TURNS) {
    const waste = turnWaste(turn, 0);
    assert.equal(waste.retries, retriesOf(turn.steps).length, turn.id);
    assert.ok(waste.repeats >= 0, turn.id);
  }
  assert.deepEqual(
    turnWaste(TURNS[1]!, 0),
    { repeats: 0, retries: 1, noFollow: 0 },
    "a switched away, then retried",
  );
  assert.deepEqual(
    turnWaste(TURNS[2]!, 0),
    { repeats: 0, retries: 2, noFollow: 0 },
    "two failures retried, the last one not",
  );
  assert.deepEqual(
    turnWaste(TURNS[3]!, 0),
    { repeats: 1, retries: 0, noFollow: 0 },
    "an ok call repeated is a repeat",
  );
});

test("the retry shape is a turn with a retry after an error", () => {
  for (const turn of TURNS) {
    const shape = classifyTurnShape(turn);
    if (retriesOf(turn.steps).length > 0) assert.equal(shape, "retry", turn.id);
    else assert.notEqual(shape, "retry", turn.id);
  }
});

test("the OpenTelemetry shapes are give-up, switch and retry after an error, in that order", () => {
  const shapes = TURNS.map((turn) => classifyOtelTurnShape(turn));
  assert.deepEqual(shapes, [
    "otel_retry",
    "otel_switched",
    "otel_failed",
    "otel_chain",
    "otel_failed",
    "otel_chain",
    "otel_retry",
    "otel_chain",
  ]);
});

test("error_loop's retries per tool are the module's retries after an error", () => {
  const stats = statsOf(TURNS);
  const byTool = new Map<string, number>();
  for (const turn of TURNS)
    for (const event of retriesOf(turn.steps))
      byTool.set(event.tool!, (byTool.get(event.tool!) ?? 0) + 1);
  for (const entry of stats.entries.values()) {
    const node = entry.targetType === "skill" ? `skill:${entry.id}` : entry.id;
    assert.equal(entry.retries, byTool.get(node) ?? 0, entry.key);
  }
  assert.equal(stats.entries.get("tool:a")?.retries, 4);
});
