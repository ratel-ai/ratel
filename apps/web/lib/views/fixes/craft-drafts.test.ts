import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_PRICE } from "@/lib/synthesis/tool-crafter/round-trip";
import type { ToolCraftProposalRow } from "@/lib/synthesis/tool-crafter/schema";
import type { CraftEvidence, CraftKind, SourceTool } from "@/lib/synthesis/tool-crafter/types";
import type { CraftCardModel } from "@/lib/synthesis/tool-crafter/view";
import { tasksSeams } from "../tasks/seams";
import { craftDraft, fixSources, priceOf } from "./craft-drafts";
import { fixSeams } from "./seams";

/**
 * The crafter's cards told as drafted fixes: what upstream's `craftSeed` and `craftEffect`
 * cases in `fixes/build.test.ts` asserted on the built fix, asserted here on the
 * `DraftFixInput` the filler hands the build.
 */

const tool = (id: string): SourceTool => ({
  id,
  name: id,
  description: `${id} does its job.`,
  searchableDescription: null,
  inputSchema: null,
});

function card(
  id: string,
  kind: CraftKind,
  tools: string[],
  evidence: CraftEvidence | null,
  over: Partial<CraftCardModel> = {},
): CraftCardModel {
  return {
    id,
    kind,
    status: "pending",
    sources: tools.map(tool),
    crafted: [],
    hidden: [],
    rationale: "Drafted from the agent's runs.",
    details: "",
    expectedEffect: "",
    migrationNotes: "",
    evidence,
    backtest: null,
    createdAt: new Date("2026-10-19T08:00:00.000Z"),
    ...over,
  };
}

const MERGE: CraftEvidence = {
  kind: "merge_tools",
  merge: {
    scope: "turn",
    support: 40,
    unitsA: 42,
    unitsB: 41,
    jaccard: 0.93,
    jaccardLow: 0.88,
    pAb: 0.95,
    pBa: 0.97,
    nextP: 0.9,
    orderAb: 38,
    orderBa: 2,
    exampleSessions: [],
  },
};

const name = (id: string) => id;

test("loading the filler fills the fixes and tasks seams", () => {
  assert.equal(typeof fixSeams.loadDrafts, "function");
  assert.equal(typeof fixSeams.dismissDraft, "function");
  assert.equal(fixSeams.priceOf, priceOf);
  assert.equal(typeof tasksSeams.loadDrafts, "function");
});

test("a merge is told with its one figure, the window's total, its gain and strong evidence", () => {
  const draft = craftDraft(
    card("c-merge", "merge_tools", ["find_task", "assign_task"], MERGE),
    name,
    NO_PRICE,
  );
  assert.equal(draft.id, "c-merge");
  assert.equal(
    draft.key,
    "merge_tools:assign_task,find_task",
    "one change per kind and tools, in any order",
  );
  assert.equal(draft.createdAt, "2026-10-19T08:00:00.000Z");
  assert.deepEqual(draft.toolIds, ["find_task", "assign_task"]);
  assert.equal(draft.effect?.value, "2 → 1 calls");
  assert.deepEqual([draft.effect?.figure, draft.effect?.unit], ["2 → 1", "calls"]);
  assert.equal(draft.effect?.detail, "−40 model calls in all");
  assert.equal(draft.effect?.basis, "runs");
  assert.ok(
    draft.effect?.also.every((reading) => /\d/.test(reading.label) && reading.icon !== "calls"),
    "the other marks carry a number and never repeat the headline",
  );
  assert.deepEqual(draft.gain, {
    windowDays: null,
    roundTrips: 40,
    calls: 40,
    tokens: null,
    usd: null,
    ms: 0,
  });
  assert.deepEqual(draft.evidence, {
    strength: "strong",
    label: "Strong",
    detail: "Seen 40 times in this window",
  });
  assert.equal(draft.measured, true);
  assert.equal(draft.score, 40);
  assert.equal(draft.intentId, null);
  assert.deepEqual(draft.taskIds, []);
  assert.equal(draft.copy.label, "Copy prompt");
  assert.match(draft.copy.text, /find_task/);
  assert.equal(draft.detail.source, "craft");
  assert.equal(draft.detail.craftKind, "merge_tools");
  assert.deepEqual(
    draft.detail.sources.map((source) => source.id),
    ["find_task", "assign_task"],
  );
  assert.doesNotMatch(draft.why, /round-trip/, "the fix speaks of model calls");
});

test("a retirement reads its evidence off the silence, a tightened schema off the failures, a plain rewrite has no effect yet", () => {
  const retire = craftDraft(
    card("c-retire", "deprecate_tool", ["legacy_export"], {
      kind: "deprecate_tool",
      deprecate: {
        windowDays: 30,
        calls: 0,
        replacement: null,
        replacementCalls: 0,
        sharedWords: [],
      },
    }),
    name,
    NO_PRICE,
  );
  assert.equal(retire.effect?.value, "−1 tool per list");
  assert.deepEqual(retire.evidence, {
    strength: "strong",
    label: "Strong",
    detail: "Not called in 30 days",
  });

  const tighten = craftDraft(
    card("c-tighten", "tighten_schema", ["flaky_api"], {
      kind: "tighten_schema",
      tighten: {
        calls: 50,
        errorCalls: 12,
        retriedErrors: 9,
        recoveredRetries: 7,
        namedRecovered: 6,
        undocumentedArgs: ["region"],
        freeTextArgs: [],
        requiredArgs: ["id"],
      },
    }),
    name,
    NO_PRICE,
  );
  assert.equal(tighten.effect?.value, "−1 failed call");
  assert.equal(tighten.evidence?.strength, "early");
  assert.equal(tighten.measured, true);

  const rewrite = craftDraft(
    card("c-rewrite", "rewrite_tool", ["lookup_order"], {
      kind: "rewrite_tool",
      rewrite: {
        missedQueries: ["where is my order"],
        buriedQueries: [],
        distractors: ["find_task"],
      },
    }),
    name,
    NO_PRICE,
  );
  assert.equal(
    rewrite.effect,
    null,
    "a replay says how much more often the tool is found; without one there is no figure",
  );
  assert.equal(rewrite.measured, false);
});

test("a combined chain names its task, a gap its ask, and an intent's own merge its intent", () => {
  const compose = craftDraft(
    card("c-compose", "compose_chain", ["find_task", "assign_task"], {
      kind: "compose_chain",
      compose: {
        workflowId: "wf_assign",
        order: ["find_task", "assign_task"],
        runs: 120,
        orderStability: 0.95,
        medianMs: 900,
        medianModelCalls: null,
        medianCostUsd: null,
      },
    }),
    name,
    NO_PRICE,
  );
  assert.deepEqual(compose.taskIds, ["wf_assign"]);

  const gap = craftDraft(
    card("c-gap", "fill_gap", ["find_task"], {
      kind: "fill_gap",
      gap: {
        intentId: "t_release",
        intentText: "Ship the release",
        units: 30,
        calls: 150,
        callsPerUnit: 5,
        projectCallsPerUnit: 2,
        distinctTools: 4,
        topTools: [{ toolId: "find_task", n: 30 }],
        suggestedName: "ship_release",
      },
    }),
    name,
    NO_PRICE,
  );
  assert.equal(gap.ask, "Ship the release");

  const intent = craftDraft(
    card("c-intent", "merge_tools", ["find_task", "assign_task"], {
      ...MERGE,
      merge: { ...MERGE.merge, intent: { topicId: "t_handover", turns: 54, runs: 36 } },
    }),
    name,
    NO_PRICE,
  );
  assert.equal(intent.intentId, "t_handover");
  assert.equal(
    intent.key,
    "merge_tools:assign_task,find_task",
    "the same change as the project-wide pair",
  );
});

test("a task's drafted fixes carry their headline, tools and the task they compose", () => {
  const row = {
    id: "p1",
    runId: "r1",
    projectId: "proj",
    kind: "compose_chain",
    status: "pending",
    sourceToolIds: ["find_task", "assign_task"],
    sourceDefinitions: ["find_task", "assign_task"].map(tool) as unknown as Record<
      string,
      unknown
    >[],
    crafted: [],
    hiddenToolIds: [],
    rationale: "Runs as one chain.",
    details: "",
    expectedEffect: "",
    migrationNotes: "",
    evidence: {
      kind: "compose_chain",
      compose: {
        workflowId: "wf_assign",
        order: ["find_task", "assign_task"],
        runs: 120,
        orderStability: 0.95,
        medianMs: 900,
        medianModelCalls: null,
        medianCostUsd: null,
      },
    } as unknown as Record<string, unknown>,
    backtest: null,
    createdAt: new Date("2026-10-19T08:00:00.000Z"),
    updatedAt: new Date("2026-10-19T08:00:00.000Z"),
  } satisfies ToolCraftProposalRow;
  const [source] = fixSources([row], new Map([["find_task", "Find a task"]]));
  assert.equal(source?.id, "p1");
  assert.equal(source?.kind, "compose_chain");
  assert.equal(source?.workflowId, "wf_assign");
  assert.deepEqual(source?.toolIds, ["find_task", "assign_task"]);
  assert.ok(source?.headline.length, "a headline for the task's list");
});

test("the price reads off a run's day buckets; none without linked model calls", () => {
  assert.deepEqual(priceOf([]), NO_PRICE);
  assert.deepEqual(priceOf(null), NO_PRICE);
  assert.deepEqual(priceOf([{ day: "2026-10-19", turns: 50 }]), NO_PRICE);
  const priced = priceOf([
    {
      day: "2026-10-19",
      turns: 50,
      linked: {
        runs: 50,
        modelCalls: 100,
        pricedRuns: 50,
        costUsd: 1,
        modelMs: 20_000,
        inputTokens: 50_000,
        outputTokens: 5_000,
      },
    },
  ]);
  assert.equal(priced.modelCalls, 100);
  assert.equal(priced.usd, 0.01);
});
