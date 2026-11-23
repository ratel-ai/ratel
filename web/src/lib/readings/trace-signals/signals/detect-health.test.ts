import assert from "node:assert/strict";
import { test } from "node:test";
import { round4 } from "@/lib/readings/trace-signals/signals/build";
import { detectHealth } from "@/lib/readings/trace-signals/signals/detect-health";
import { wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import {
  contextFor,
  fresh,
  signalTurns,
  statsOf,
  times,
} from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { CatalogEntryFact } from "@/lib/readings/trace-signals/signals/types";

const DAY_MS = 86_400_000;

function kinds(result: ReturnType<typeof detectHealth>, kind: string) {
  return result.signals.filter((s) => s.kind === kind);
}

test("error_loop fires on a tool failing twice in several turns", () => {
  const loop = () =>
    fresh().search(["link"]).invoke("link").error("link").invoke("link").error("link");
  const ok = () => fresh().search(["link"]).invoke("link");
  const turns = signalTurns([...times(3, loop), ...times(10, ok)]);
  const [signal] = kinds(detectHealth(statsOf(turns), contextFor(turns)), "error_loop");
  assert.ok(signal);
  assert.equal(signal.metrics.errors, 6);
  assert.equal(signal.metrics.loopTurns, 3);
  assert.equal(signal.metrics.retries, 3);
  assert.equal(signal.severity, round4(wilsonLow(6, 16)));
  assert.equal(signal.impact, 9);

  const fewer = signalTurns([...times(2, loop), ...times(40, ok)]);
  assert.equal(
    kinds(detectHealth(statsOf(fewer), contextFor(fewer)), "error_loop").length,
    0,
    "4 errors < 5",
  );
});

test("latency_outlier compares a tool's p95 with the project median and the absolute floor", () => {
  const slow = (i: number) =>
    fresh()
      .search(["lookup"])
      .invoke("lookup")
      .end("lookup", { tookMs: 14_000 + i });
  const fast = () => fresh().search(["quick"]).invoke("quick").end("quick", { tookMs: 200 });
  const turns = signalTurns([...times(20, slow), ...times(100, fast)]);
  const [signal] = kinds(detectHealth(statsOf(turns), contextFor(turns)), "latency_outlier");
  assert.ok(signal);
  assert.equal(signal.subjectKey, "lookup");
  assert.equal(signal.metrics.medianMs, 200);
  assert.equal(signal.severity, round4(wilsonLow(20, 20)));
  assert.ok(signal.evidence.turnIds.length > 0);

  const quick = signalTurns([
    ...times(20, () =>
      fresh().search(["lookup"]).invoke("lookup").end("lookup", { tookMs: 9_000 }),
    ),
    ...times(100, fast),
  ]);
  assert.equal(
    kinds(detectHealth(statsOf(quick), contextFor(quick)), "latency_outlier").length,
    0,
    "under the 10 s floor",
  );
});

test("dead_tool needs an old, busy ledger and agreement from the usage counters", () => {
  const turns = signalTurns(times(200, () => fresh().search(["used"]).invoke("used")));
  const catalog: CatalogEntryFact[] = ["used", "dead_a", "dead_b"].map((id) => ({
    kind: "tool",
    entryId: id,
    name: id,
    searchable: id,
  }));
  const base = contextFor(turns, { catalog });
  const old = { ...base, ledgerStartedAt: new Date(base.windowEnd.getTime() - 20 * DAY_MS) };
  const result = detectHealth(statsOf(turns), old);
  const [signal] = kinds(result, "dead_tool");
  assert.deepEqual(signal?.subjectIds, ["dead_a", "dead_b"]);
  assert.equal(signal?.subjectKey, "project");
  assert.equal(signal?.impact, 2);
  assert.ok(result.measured.has("dead_tool"));

  const counted = detectHealth(statsOf(turns), {
    ...old,
    usage: [{ toolId: "dead_a", calls: 3, lastUsedAt: old.windowEnd }],
  });
  assert.deepEqual(
    kinds(counted, "dead_tool")[0]?.subjectIds,
    ["dead_b"],
    "usage counters disagree for dead_a",
  );

  const young = detectHealth(statsOf(turns), {
    ...base,
    ledgerStartedAt: new Date(base.windowEnd.getTime() - 3 * DAY_MS),
  });
  assert.equal(young.measured.has("dead_tool"), false, "a young ledger cannot call a tool dead");
});

test("abandoned_search is not measurable without invocations and fires on a high abandon share", () => {
  const searchOnly = () => fresh().search(["a", "b"]);
  const ran = () => fresh().search(["a"]).invoke("a");
  const mixed = signalTurns([...times(20, searchOnly), ...times(20, ran)]);
  const result = detectHealth(statsOf(mixed), contextFor(mixed));
  const [signal] = kinds(result, "abandoned_search");
  assert.equal(signal?.n, 40);
  assert.equal(signal?.severity, round4(wilsonLow(20, 40)));

  const noInvocations = signalTurns(times(40, searchOnly));
  const none = detectHealth(statsOf(noInvocations), contextFor(noInvocations));
  assert.equal(none.measured.has("abandoned_search"), false);
  assert.equal(kinds(none, "abandoned_search").length, 0);

  const few = signalTurns([...times(10, searchOnly), ...times(19, ran)]);
  assert.equal(
    kinds(detectHealth(statsOf(few), contextFor(few)), "abandoned_search").length,
    0,
    "29 turns < 30",
  );
});
