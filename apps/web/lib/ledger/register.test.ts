import assert from "node:assert/strict";
import { test } from "node:test";
import { ledgerRegistration } from "./register";

test("the ledger registers the build job and one before-step under upstream's names", () => {
  assert.deepEqual(Object.keys(ledgerRegistration.jobs ?? {}), ["build_trace_turns"]);
  assert.deepEqual(
    (ledgerRegistration.drainSteps ?? []).map((s) => [s.name, s.phase, s.retentionOnly ?? false]),
    [["trace_turns_build_enqueue", "before", false]],
  );
});
