import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAIM_TEMPLATES,
  type ClaimFactsByKind,
  claimFor,
  claimFromParts,
  clampFigures,
  fixFor,
  formatDuration,
  formatFigure,
  formatRank,
  formatSharePercent,
  hasTwoDecimals,
  SIGNAL_KIND_LABELS,
} from "@/lib/readings/trace-signals/claims";
import { SIGNAL_KINDS, type SignalKind, type SubjectChip } from "@/lib/readings/trace-signals/view";

const tool = (id: string): SubjectChip => ({ id, label: id, entryKind: "tool" });

/**
 * One set of facts per kind, deliberately full of awkward decimals: whatever the
 * engine hands over, the sentence must come out in whole percents and at most
 * one decimal. Typed as a mapped record so a new kind without facts fails to
 * compile here before it can ship without copy.
 */
const FACTS: { [K in SignalKind]: ClaimFactsByKind[K] } = {
  first_try_miss: { tool: tool("assign_task") },
  buried_tool: { tool: tool("update_task"), rank: 6.66 },
  magnet: { tool: tool("create_task"), listedShare: 0.41234, pickedShare: 0.0417 },
  dead_tool: { count: 23 },
  sequence_chain: { first: tool("find_task"), then: tool("assign_task"), share: 0.7796 },
  sibling_confusion: { a: tool("unlink_pr_from_task"), b: tool("delete_task_relationship") },
  error_loop: { tool: tool("link_pr_to_task") },
  no_follow_through: { tool: tool("search_projects") },
  abandoned_search: { share: 0.3149 },
  padding_share: { listed: 10, cutoffRank: 5, belowShare: 0.0213 },
  latency_outlier: { tool: tool("entity_lookup"), p95Ms: 12_437.8, typicalMs: 1_423.6 },
  unstable_intent: { distinctTools: 5 },
  repeat_invoke: { tool: tool("add_task_comment"), calls: 3 },
  fragmented_intents: { standalone: 209, total: 232 },
  cooccurring_intents: { first: "create a task", second: "assign it" },
  tool_switch: { from: tool("search_tasks"), to: tool("filter_tasks"), share: 0.3349 },
  empty_result: { tool: tool("search_docs"), share: 0.4721 },
  unknown_tool: { tool: tool("get_weather") },
  unused_tool: { tools: [tool("export_board"), tool("set_timezone")], count: 5 },
  long_turn: { share: 0.0812, threshold: 9, typical: 3 },
  blocked_action: { tool: tool("ads_set_campaign_budget"), code: "tool_not_declared" },
  identical_retry: { tool: tool("update_proposal"), share: 0.3333 },
  wait_heavy: { tool: tool("wait_for_run"), share: 0.30214, medianMs: 82_597.4 },
  token_heavy: { turnShare: 0.0501, tokenShare: 0.49512 },
  system_turn_failing: { share: 0.25373, personShare: 0.00124 },
  agent_failing: {
    agent: "video-editor",
    share: 0.1812,
    othersShare: 0.0213,
    tools: [tool("write_file"), tool("glob")],
  },
  workflow_failing: {
    workflow: "find_task > assign_task",
    failedShare: 0.3127,
    step: tool("assign_task"),
  },
  workflow_slow: {
    workflow: "search_hotels > get_budget",
    ratio: 4.37,
    step: tool("search_hotels"),
    stepShare: 0.7049,
  },
  workflow_fixed_chain: {
    steps: [tool("find_task"), tool("assign_task"), tool("notify")],
    share: 0.9649,
  },
  self_correcting: {
    tool: tool("entity_lookup"),
    task: null,
    share: 0.1372,
    pattern: "failed",
    fixTool: "entity_lookup",
    topic: null,
  },
};

const ENGINE_WORDS =
  /adaptive ranking|match quality|intent extraction|wilson|p95|classifier|jev|claude|bm25|top_k/i;

test("every kind has a claim template, a fix line and a label", () => {
  for (const kind of SIGNAL_KINDS) {
    assert.ok(CLAIM_TEMPLATES[kind], `${kind} has a template`);
    assert.ok(SIGNAL_KIND_LABELS[kind].length > 0, `${kind} has a label`);
    const sentence = claimFor(kind, FACTS[kind] as never);
    const fix = fixFor(kind, FACTS[kind] as never);
    assert.ok(sentence.claim.length > 10, `${kind} claim is a sentence`);
    assert.match(sentence.claim, /[.]$/, `${kind} claim ends with a full stop`);
    assert.ok(fix.length > 10, `${kind} has a fix line`);
    assert.match(fix, /[.]$/, `${kind} fix ends with a full stop`);
    for (const text of [sentence.claim, fix, SIGNAL_KIND_LABELS[kind]]) {
      assert.ok(!hasTwoDecimals(text), `${kind}: no two-decimal figure in "${text}"`);
      assert.doesNotMatch(text, ENGINE_WORDS, `${kind}: plain language in "${text}"`);
      assert.doesNotMatch(text, /\u2014/, `${kind}: no em dash`);
    }
  }
});

test("segments join back into the claim, and subjects become chips", () => {
  const sentence = claimFor("magnet", FACTS.magnet);
  assert.equal(sentence.claim, "create_task rides into 41% of lists and is picked in 4%.");
  assert.equal(sentence.claimSegments.map((segment) => segment.text).join(""), sentence.claim);
  assert.deepEqual(sentence.claimSegments[0], {
    kind: "subject",
    text: "create_task",
    chipId: "create_task",
  });

  const pair = claimFor("sequence_chain", FACTS.sequence_chain);
  assert.equal(pair.claim, "find_task precedes assign_task 78% of the time.");
  assert.equal(pair.claimSegments.filter((segment) => segment.kind === "subject").length, 2);

  assert.equal(
    claimFor("magnet", { ...FACTS.magnet, pickedShare: 0.0039 }).claim,
    "create_task rides into 41% of lists and is picked in <1%.",
    "three picks in 774 lists is not 0%",
  );
  assert.equal(
    claimFor("magnet", { ...FACTS.magnet, pickedShare: 0 }).claim,
    "create_task rides into 41% of lists and is never picked.",
  );
  assert.equal(
    fixFor("magnet", FACTS.magnet),
    "Narrow its description so it stops matching reads.",
  );
  assert.equal(
    claimFor("buried_tool", FACTS.buried_tool).claim,
    "update_task is the right tool and sits at #7 when picked.",
  );
  assert.equal(
    claimFor("latency_outlier", FACTS.latency_outlier).claim,
    "entity_lookup takes 12 s on its slow calls, against 1.4 s for a typical tool.",
  );
  assert.equal(claimFor("dead_tool", { count: 1 }).claim, "1 tool was never listed and never run.");
  assert.equal(
    claimFor("abandoned_search", FACTS.abandoned_search).claim,
    "31% of searches led to no tool call.",
  );
  assert.equal(
    claimFor("abandoned_search", { share: 0.2, tool: tool("find_task") }).claimSegments.filter(
      (segment) => segment.kind === "subject",
    ).length,
    1,
  );
});

test("figures print whole percents, ranks and readable durations", () => {
  assert.equal(formatSharePercent(0.41234), "41%");
  assert.equal(formatSharePercent(0.004), "<1%");
  assert.equal(formatSharePercent(0), "0%");
  assert.equal(formatSharePercent(0.998), ">99%");
  assert.equal(formatSharePercent(1), "100%");
  assert.equal(formatRank(7), "#7");
  assert.equal(formatRank(0), "#1");
  assert.equal(formatDuration(420.4), "420 ms");
  assert.equal(formatDuration(1_423), "1.4 s");
  assert.equal(formatDuration(2_000), "2 s");
  assert.equal(formatDuration(12_437), "12 s");
  assert.equal(formatDuration(240_000), "4 min");
  assert.equal(formatFigure({ value: 0.41, unit: "share" }), "41%");
  assert.equal(formatFigure({ value: 7, unit: "rank" }), "#7");
  assert.equal(formatFigure({ value: 12_400, unit: "ms" }), "12 s");
  assert.equal(formatFigure({ value: 7_190, unit: "count" }), "7,190");
});

test("the two-decimal guard catches and clamps what slips through", () => {
  assert.ok(hasTwoDecimals("41.23%"));
  assert.ok(hasTwoDecimals("12.46 s"));
  assert.ok(!hasTwoDecimals("12.4 s"));
  assert.ok(!hasTwoDecimals("7,190 of 12,410 hits"));
  assert.equal(clampFigures("41.23% of lists"), "41% of lists");
  assert.equal(clampFigures("0.3%"), "<1%");
  assert.equal(
    clampFigures("99.7%"),
    ">99%",
    "a share short of everything never rounds up to 100%",
  );
  assert.equal(clampFigures("100.0%"), "100%");
  assert.equal(clampFigures("p 12.46 s"), "p 12.5 s");
  assert.equal(clampFigures("509 lists · 3 picks"), "509 lists · 3 picks");
  assert.equal(claimFromParts(["Picked in 4.17% of turns."]).claim, "Picked in 4% of turns.");

  for (const value of [0.123456, 0.5, 0.99999, 3.14159, 12_345.678]) {
    for (const unit of ["share", "count", "ms", "rank"] as const) {
      assert.ok(!hasTwoDecimals(formatFigure({ value, unit })), `${unit} ${value}`);
    }
  }
});
