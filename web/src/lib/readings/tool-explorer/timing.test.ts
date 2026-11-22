import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeExplorerTurns } from "@/lib/readings/tool-explorer/analyze";
import { formatDuration } from "@/lib/readings/tool-explorer/view";
import { many, wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";
import { pairTiming } from "@/lib/synthesis/tool-crafter/candidates";
import { timingSentences } from "@/lib/synthesis/tool-crafter/draft";

/** list → backlog → estimate in 45 turns, estimate alone in 10, search_tasks → estimate in 8; each call 100 ms, 1 s apart. */
function turns() {
  return [
    ...many(45, () =>
      wfTurn(["list_projects", "get_backlog", "estimate_task"], {
        durationMs: 3_000,
      }),
    ),
    ...many(10, () => wfTurn(["estimate_task"])),
    ...many(8, () => wfTurn(["search_tasks", "estimate_task"], { durationMs: 2_000 })),
  ];
}

test("timing: per-tool run time and per-pair hand-off come out of the steps, and the Crafter reads them for a pair", () => {
  const result = analyzeExplorerTurns(turns(), {
    cousage: { minSupport: 5, minShare: 0 },
  });
  const list = result.summary.nodes.find((n) => n.id === "list_projects")!;
  assert.deepEqual([list.calls, list.medianMs, list.totalMs], [45, 100, 4_500]);
  const edge = result.edges.find(
    (e) =>
      e.scope === "turn" && e.kind === "next" && e.a === "list_projects" && e.b === "get_backlog",
  )!;
  assert.deepEqual(
    edge.timing,
    {
      pairs: 45,
      betweenMsTotal: 40_500,
      betweenMsMedian: 900,
      searchesBetween: 0,
    },
    "calls 1 s apart taking 100 ms leave a 900 ms hand-off",
  );
  assert.equal(
    result.edges.find(
      (e) => e.kind === "before" && e.a === "list_projects" && e.b === "get_backlog",
    )!.timing,
    undefined,
    "only next edges carry a hand-off",
  );

  const t = pairTiming(
    "get_backlog",
    "estimate_task",
    result.edges.filter((e) => e.scope === "turn"),
    result.summary.nodes,
  )!;
  assert.deepEqual([t.aCalls, t.bCalls, t.handoffPairs, t.handoffMsTotal], [45, 63, 45, 40_500]);
  const sentences = timingSentences("get_backlog", "estimate_task", t);
  assert.match(
    sentences.details,
    /get_backlog takes 100 ms a call \(median\), 4\.5 s over its 45 calls/,
  );
  assert.match(
    sentences.effect,
    /removes the hand-off: about 41 s over this window, 900 ms per request/,
  );
  assert.equal(timingSentences("a", "b", undefined).effect, "");
});

test("formatDuration prints what Agent health prints, plus a dash for nothing and hours past one", () => {
  assert.equal(formatDuration(340), "340 ms");
  assert.equal(formatDuration(1_250), "1.3 s");
  assert.equal(formatDuration(12_400), "12 s");
  assert.equal(formatDuration(150_000), "3 min", "whole minutes, as on Agent health");
  assert.equal(formatDuration(5_400_000), "1.5 h");
  assert.equal(formatDuration(null), "—");
});
