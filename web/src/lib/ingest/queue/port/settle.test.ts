import assert from "node:assert/strict";
import { test } from "node:test";
import { errorCode, errorReason, RETRY_POLICY, settle } from "./settle";

const retry = { outcome: "retry", reason: "busy" } as const;
const outage = { outcome: "outage", reason: "down" } as const;

test("a failing message is delivered 5 times, with the waits of ADR-0009", () => {
  const settlements = [1, 2, 3, 4, 5].map((attempt) =>
    settle(retry, { attempt, outages: 0 }, RETRY_POLICY),
  );
  assert.deepEqual(
    settlements.map((settlement) =>
      settlement.action === "redeliver" ? settlement.waitMs : settlement.action,
    ),
    [1_000, 5_000, 30_000, 120_000, "dead-letter"],
  );
});

test("an outage waits up to 30 s and never becomes a dead letter", () => {
  const waits = [0, 1, 4, 5, 100].map((outages) => {
    const settlement = settle(outage, { attempt: 99, outages }, RETRY_POLICY);
    assert.ok(settlement.action === "redeliver" && settlement.outage);
    return settlement.waitMs;
  });
  assert.deepEqual(waits, [1_000, 2_000, 16_000, 30_000, 30_000]);
});

test("an error's reason is its kind and code, never its message", () => {
  const cause = Object.assign(new Error("prompt text"), { code: "57P01" });
  const error = new Error("Failed query: insert ... params: prompt text", { cause });
  assert.equal(errorCode(error), "57P01");
  assert.equal(errorReason(error), "uncaught Error (57P01)");
  assert.equal(errorReason("prompt text"), "uncaught error");
});
