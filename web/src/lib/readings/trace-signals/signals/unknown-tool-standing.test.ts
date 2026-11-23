import assert from "node:assert/strict";
import { test } from "node:test";
import { withStoredToolStandings } from "@/lib/readings/trace-signals/signals/unknown-tool-standing";

test("the stored score's standings come from the stored ok calls alone", () => {
  const record = (subjectKey: string, metrics: Record<string, unknown>) => ({
    kind: "unknown_tool",
    subjectKey,
    metrics,
  });
  const [ran, none, absent] = withStoredToolStandings([
    record("ran", { okCalls: 3 }),
    record("none", { okCalls: 0 }),
    record("absent", {}),
  ]);
  assert.equal(ran?.metrics.toolStanding, "succeeded");
  assert.equal(none?.metrics.toolStanding, undefined);
  assert.equal(absent?.metrics.toolStanding, undefined);
});
