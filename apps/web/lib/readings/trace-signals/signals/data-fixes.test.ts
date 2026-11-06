import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arrivedFix,
  awaitedFixes,
  FIX_ENOUGH,
  FIX_RERUN_AFTER_MS,
  FIX_RERUN_AGAIN_AFTER_MS,
  fixRerunDue,
} from "@/lib/readings/trace-signals/signals/data-fixes";

const setup = (facts: Record<string, string>) => ({
  version: 1,
  lanes: { sdk: true, otel: false },
  facts: Object.entries(facts).map(([key, status]) => ({
    key,
    status,
    share: status === "on" ? 1 : 0,
  })),
});

test("a reading says what it waits for: tool calls, turn ids, users' messages", () => {
  assert.deepEqual(
    awaitedFixes({
      workflows: { basis: { blocked: "no_tool_calls" } },
      setup: setup({ sdk_turn_ids: "on" }),
    }),
    ["tool_calls"],
  );
  assert.deepEqual(awaitedFixes({ workflows: { basis: { blocked: "mixed_runs" } } }), ["turn_ids"]);
  assert.deepEqual(
    awaitedFixes({ setup: setup({ sdk_turn_ids: "off", sdk_user_messages: "off" }) }),
    ["turn_ids", "user_messages"],
  );
  assert.deepEqual(
    awaitedFixes({ setup: setup({ sdk_turn_ids: "partial", sdk_user_messages: "on" }) }),
    [],
    "partly sent is not waiting",
  );
  assert.deepEqual(awaitedFixes(null), []);
  assert.deepEqual(awaitedFixes({ workflows: "junk", setup: { facts: "junk" } }), []);
});

test("a fix asks for a new reading only with enough fixed rows, half an hour after the last one", () => {
  const finishedAt = new Date("2026-10-01T10:00:00Z");
  const soon = new Date(finishedAt.getTime() + FIX_RERUN_AFTER_MS - 1);
  const later = new Date(finishedAt.getTime() + FIX_RERUN_AFTER_MS);
  assert.equal(fixRerunDue({ finishedAt, trigger: "scheduled" }, soon), false);
  assert.equal(fixRerunDue({ finishedAt, trigger: "scheduled" }, later), true);
  assert.equal(
    fixRerunDue({ finishedAt, trigger: "data_fixed" }, later),
    false,
    "a fix already asked once: wait longer",
  );
  assert.equal(
    fixRerunDue(
      { finishedAt, trigger: "data_fixed" },
      new Date(finishedAt.getTime() + FIX_RERUN_AGAIN_AFTER_MS),
    ),
    true,
  );
  assert.equal(fixRerunDue({ finishedAt: null, trigger: "scheduled" }, later), false);

  assert.equal(arrivedFix(["turn_ids"], { turn_ids: FIX_ENOUGH.turn_ids - 1 }), null);
  assert.equal(
    arrivedFix(["turn_ids", "user_messages"], {
      turn_ids: 3,
      user_messages: FIX_ENOUGH.user_messages,
    }),
    "user_messages",
  );
  assert.equal(arrivedFix([], { turn_ids: 1_000 }), null);
});
