import type { FixesInput, IssueInput, RewriteInput, TaskInput, TopicInput } from "./build";
import type { CraftKind, SuggestionRow } from "./crafter-types";
import type { DraftFixInput } from "./seams";

/**
 * One small project for the Fixes tests: an order lookup that searches miss, a hand-over task
 * whose two tools always run together, a flaky tool, a tool nobody calls, and the issues Agent
 * health raised about them.
 *
 * Owned (ADR-0030): the drafted changes are `DraftFixInput`s, the shape the tool crafter's seam
 * delivers, with the worth its filler would have computed written in by hand.
 */

export const PROJECT_ID = "p1";
export const NOW = new Date("2026-10-20T12:00:00.000Z");

export const NAMES = new Map<string, string>([
  ["lookup_order", "lookup_order"],
  ["find_task", "find_task"],
  ["assign_task", "assign_task"],
  ["legacy_export", "legacy_export"],
  ["old_report", "old_report"],
  ["flaky_api", "flaky_api"],
  ["notify", "notify"],
]);

export const TASKS: TaskInput[] = [
  { id: "wf_assign", label: "Hand a task over", runs: 120, tools: ["find_task", "assign_task"] },
  { id: "wf_order", label: "Check an order", runs: 80, tools: ["lookup_order"] },
  { id: "wf_notify", label: "Notify the owner", runs: 30, tools: ["notify", "flaky_api"] },
  { id: "wf_rare", label: "Rare one", runs: 2, tools: ["notify"] },
];

export const TOPICS: TopicInput[] = [
  {
    id: "t_orders",
    label: "Order status",
    turns: 90,
    toolShares: { lookup_order: 0.9 },
    taskShares: { wf_order: 0.85 },
  },
  {
    id: "t_handover",
    label: "Handing work over",
    turns: 60,
    toolShares: { find_task: 0.8, assign_task: 0.75 },
    taskShares: { wf_assign: 0.7 },
  },
  {
    id: "t_misc",
    label: "Small talk",
    turns: 40,
    toolShares: { lookup_order: 0.1 },
    taskShares: {},
  },
];

export function suggestionRow(over: Partial<SuggestionRow> = {}): SuggestionRow {
  return {
    id: "mq-lookup",
    status: "pending",
    toolId: "lookup_order",
    toolName: "lookup_order",
    missed: 12,
    change: "adds",
    effect: { delta: "+40 pts", direction: "up", detail: "3 → 5 of 5 searches" },
    appliedAt: null,
    spans: [
      { kind: "same", text: "Look up an order. " },
      { kind: "added", text: "Use for order status, tracking and where is my order." },
    ],
    proposed: "Look up an order. Use for order status, tracking and where is my order.",
    rationale: "Added the words these searches used.",
    examples: [
      { query: "where is my order", testHref: "/project/p1/playground?q=where+is+my+order" },
    ],
    moreExamples: 11,
    ...over,
  };
}

export const REWRITES: RewriteInput[] = [
  { row: suggestionRow(), howWeKnow: "seen" },
  {
    row: suggestionRow({
      id: "mq-notify",
      status: "applied",
      toolId: "notify",
      toolName: "notify",
      missed: 4,
      appliedAt: "2026-10-18T09:00:00.000Z",
    }),
    howWeKnow: "judged",
  },
];

/** One drafted change per kind and tools, as the crafter keys them. */
export function draftKey(kind: CraftKind, tools: readonly string[]): string {
  return `${kind}:${[...tools].sort().join(",")}`;
}

/** A drafted change as the tool crafter's seam would deliver it, its worth written by hand. */
export function craft(
  id: string,
  kind: CraftKind,
  tools: string[],
  over: Partial<DraftFixInput> = {},
): DraftFixInput {
  return {
    id,
    kind,
    key: draftKey(kind, tools),
    createdAt: "2026-10-19T08:00:00.000Z",
    toolIds: tools,
    taskIds: [],
    intentId: null,
    ask: null,
    why: "Drafted from the agent's runs.",
    effect: null,
    gain: null,
    evidence: null,
    copy: { label: "Copy prompt", text: "## Problem\nDrafted from the agent's runs." },
    detail: {
      source: "craft",
      craftKind: kind,
      plain: "A drafted change.",
      why: ["Drafted from the agent's runs."],
      worth: [],
      worthCaption: null,
      replay: null,
      change: [],
      facts: [],
      sources: tools.map((tool) => ({
        id: tool,
        name: tool,
        description: `${tool} does its job.`,
      })),
      crafted: [],
    },
    measured: false,
    score: 0,
    ...over,
  };
}

export const CRAFTS: DraftFixInput[] = [
  craft("c-merge", "merge_tools", ["find_task", "assign_task"], {
    effect: {
      value: "2 → 1 calls",
      figure: "2 → 1",
      unit: "calls",
      detail: "−40 model calls in all",
      tone: "good",
      basis: "runs",
    },
    gain: { roundTrips: 40, calls: 40, ms: 0 },
    evidence: { strength: "strong", label: "Strong", detail: "Seen 40 times in this window" },
    measured: true,
    score: 40,
  }),
  craft("c-rewrite", "rewrite_tool", ["lookup_order"]),
  craft("c-retire", "deprecate_tool", ["legacy_export"], {
    effect: {
      value: "−1 tool per list",
      figure: "−1",
      unit: "tool per list",
      detail: null,
      tone: "good",
      basis: "runs",
    },
    evidence: { strength: "strong", label: "Strong", detail: "Not called in 30 days" },
  }),
  craft("c-tighten", "tighten_schema", ["flaky_api"], {
    effect: {
      value: "−1 failed call",
      figure: "−1",
      unit: "failed call",
      detail: null,
      tone: "good",
      basis: "runs",
    },
    gain: { roundTrips: 6, calls: 6, ms: 0 },
    evidence: { strength: "early", label: "Early", detail: "Seen 6 times in this window" },
    measured: true,
    score: 6,
  }),
];

export function issue(over: Partial<IssueInput> & Pick<IssueInput, "id" | "kind">): IssueInput {
  return {
    route: null,
    subjectKind: "tool",
    subjectKey: over.toolIds?.join("|") ?? "x",
    toolIds: [],
    taskId: null,
    topicId: null,
    title: "An issue",
    claim: "Something goes wrong.",
    cost: "It costs something.",
    figureRaw: "10 of 20 turns",
    figure: { display: "50%", caption: "of turns" },
    fix: "Change something.",
    caveat: null,
    severity: 0.3,
    impact: 10,
    n: 20,
    totalTurns: 20,
    metrics: {},
    proposal: null,
    firstSeenAt: "2026-10-10T00:00:00.000Z",
    ...over,
  };
}

export const ISSUES: IssueInput[] = [
  issue({
    id: "i-magnet",
    kind: "magnet",
    route: "rewrite_description",
    toolIds: ["lookup_order"],
    title: "Wrong tool keeps showing up",
    claim: "lookup_order rides into 41% of lists and is picked in 1%.",
    figure: { display: "41%", caption: "of lists" },
    severity: 0.5,
    n: 509,
    totalTurns: 120,
  }),
  issue({
    id: "i-chain",
    kind: "sequence_chain",
    route: "workflow_skill",
    subjectKind: "tool_pair",
    toolIds: ["find_task", "assign_task"],
    title: "Two tools always run together",
    claim: "find_task precedes assign_task in 92% of the turns that run assign_task.",
  }),
  issue({
    id: "i-dead",
    kind: "dead_tool",
    route: "retire_tool",
    subjectKind: "project",
    subjectKey: "project",
    toolIds: ["legacy_export", "old_report"],
    title: "Tools nobody uses",
    claim: "2 tools were never listed and never run.",
    metrics: { dead: 2 },
    n: 900,
    totalTurns: 0,
  }),
  issue({
    id: "i-loop",
    kind: "error_loop",
    route: "show_turns",
    toolIds: ["flaky_api"],
    title: "Retries after errors",
    claim: "flaky_api fails and is retried in the same turn.",
  }),
  issue({
    id: "i-padding",
    kind: "padding_share",
    route: "lower_top_k",
    subjectKind: "project",
    subjectKey: "project",
    toolIds: [],
    title: "Lists are padded",
    claim: "Lists are filled to 10; picks below #5 are 2%.",
    metrics: { suggestedTopK: 5, medianTopK: 10 },
    n: 300,
    totalTurns: 0,
  }),
  issue({
    id: "i-retry",
    kind: "identical_retry",
    route: "show_turns",
    toolIds: ["notify"],
    title: "Repeats a failed call unchanged",
    claim: "After notify fails, the agent sends the same call again in 40% of those turns.",
    figure: { display: "40%", caption: "retried as is" },
    fix: "Make notify's errors say what to change, so the agent fixes the call instead of repeating it.",
    n: 15,
    totalTurns: 15,
  }),
  issue({
    id: "i-slow",
    kind: "latency_outlier",
    route: "none",
    toolIds: ["lookup_order"],
    title: "Slow tool",
    claim: "lookup_order's slowest calls take 12 s.",
  }),
  issue({
    id: "i-magnet-2",
    kind: "magnet",
    route: "rewrite_description",
    toolIds: ["assign_task"],
    title: "Wrong tool keeps showing up",
    claim: "assign_task rides into 30% of lists and is never picked.",
    severity: 0.4,
    n: 200,
    totalTurns: 60,
  }),
  issue({
    id: "i-nft",
    kind: "no_follow_through",
    route: "rewrite_description",
    toolIds: ["assign_task"],
    title: "Searches again right after",
    claim: "After running assign_task, the agent searched again for the same thing.",
    severity: 0.2,
    n: 40,
    totalTurns: 40,
  }),
];

export function fixesInput(over: Partial<FixesInput> = {}): FixesInput {
  return {
    projectId: PROJECT_ID,
    names: NAMES,
    rewrites: REWRITES,
    drafts: CRAFTS,
    issues: ISSUES,
    tasks: TASKS,
    topics: TOPICS,
    overridesAdopted: true,
    ...over,
  };
}
