import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredTopicPattern } from "@/lib/readings/topics/types";
import { buildFixes } from "./build";
import { filterFixes, findFix, fixesForSubject } from "./select";
import type { IntentGapInput } from "./skill-gaps";
import { CRAFTS, craft, fixesInput, ISSUES, issue, REWRITES } from "./test-fixtures";

/**
 * Owned (ADR-0030): the drafted changes are `DraftFixInput`s (what the tool crafter's seam
 * delivers), so the cases that read a draft's worth off the crafter's card are stated on the
 * fixture's own figures.
 */

/** Words the product never shows (DESIGN.md, The product's nouns). */
const FORBIDDEN = /workflow|tool craft|suggestion|proposal|signal|craft|bm25|—/i;

const model = buildFixes(fixesInput());
const byTitle = (title: string) => {
  const fix = model.open.find((f) => f.title === title);
  assert.ok(fix, `no open fix titled "${title}" in: ${model.open.map((f) => f.title).join(" | ")}`);
  return fix;
};

test("one list across every source, biggest measured effect first", () => {
  assert.deepEqual(
    model.open.map((fix) => fix.title),
    [
      // A measured effect on solid evidence first, by how often it applies.
      "Merge find_task and assign_task",
      "Rewrite lookup_order's searchable description",
      // Then what resolves an issue, worst issue first (Agent health's order),
      // including the schema fix measured on six failures only.
      "Rewrite assign_task's searchable description",
      "Retire legacy_export",
      "Retire old_report",
      "Return 5 results per search instead of 10",
      "Tighten flaky_api's input schema",
      "Make notify fail clearly",
    ],
  );
  assert.deepEqual(
    model.open.map((fix) => fix.source),
    ["craft", "rewrite", "issue", "craft", "issue", "issue", "craft", "issue"],
  );
});

test("a rewrite drafted twice is one fix, opened by either id", () => {
  const rewrite = byTitle("Rewrite lookup_order's searchable description");
  assert.equal(rewrite.id, "rewrite:mq-lookup");
  assert.ok(rewrite.aliases.includes("craft:c-rewrite"));
  assert.equal(findFix(model.open, "craft:c-rewrite")?.id, "rewrite:mq-lookup");
  assert.equal(
    model.open.filter(
      (fix) => fix.kind === "rewrite" && fix.subject.tools[0]?.id === "lookup_order",
    ).length,
    1,
  );
});

test("issues link to the fix that resolves them, by subject", () => {
  const rewrite = byTitle("Rewrite lookup_order's searchable description");
  assert.deepEqual(
    rewrite.issues.map((i) => i.id),
    ["i-magnet"],
  );
  // The why is the issue it resolves, with its numbers.
  assert.equal(rewrite.why, "lookup_order rides into 41% of lists and is picked in 1%.");
  assert.equal(rewrite.issues[0]?.href, "/project/p1/health#signal-i-magnet");
  assert.equal(byTitle("Merge find_task and assign_task").issues[0]?.id, "i-chain");
  assert.equal(byTitle("Tighten flaky_api's input schema").issues[0]?.id, "i-loop");
  assert.equal(findFix(model.open, "issue:i-chain")?.title, "Merge find_task and assign_task");
  assert.deepEqual(
    fixesForSubject(model.open, { issue: "i-loop" }).map((fix) => fix.id),
    ["craft:c-tighten"],
  );
});

test("issues that name a change and have no drafted fix become fixes of their own", () => {
  const assign = byTitle("Rewrite assign_task's searchable description");
  assert.equal(assign.source, "issue");
  // Two issues about one tool, one change: one fix.
  assert.deepEqual(
    assign.issues.map((i) => i.id),
    ["i-magnet-2", "i-nft"],
  );
  assert.equal(assign.id, "issue:i-magnet-2");
  assert.equal(findFix(model.open, "issue:i-nft")?.id, "issue:i-magnet-2");
  assert.equal(byTitle("Make notify fail clearly").issues[0]?.id, "i-retry");
  assert.equal(byTitle("Return 5 results per search instead of 10").kind, "fewer-results");
  // A slow tool names no change, and an error loop is resolved by the drafted schema fix.
  assert.equal(findFix(model.open, "issue:i-slow"), null);
  assert.equal(
    model.open.some((fix) => fix.source === "issue" && fix.issues.some((i) => i.id === "i-loop")),
    false,
  );
});

test("a retirement covers the tool it names; the rest of the issue stays a fix", () => {
  assert.deepEqual(
    byTitle("Retire legacy_export").issues.map((i) => i.id),
    ["i-dead"],
  );
  const rest = byTitle("Retire old_report");
  assert.equal(rest.source, "issue");
  assert.deepEqual(
    rest.subject.tools.map((t) => t.id),
    ["old_report"],
  );
  assert.equal(fixesForSubject(model.open, { issue: "i-dead" }).length, 2);
});

test("a fix names the tools, tasks and topics it touches, with their links and colors", () => {
  const merge = byTitle("Merge find_task and assign_task");
  assert.deepEqual(
    merge.subject.tools.map((t) => t.href),
    [
      "/project/p1/catalogs/tools?highlight=find_task",
      "/project/p1/catalogs/tools?highlight=assign_task",
    ],
  );
  assert.deepEqual(merge.subject.tasks, [
    {
      id: "wf_assign",
      label: "Hand a task over",
      color: "chart-1",
      href: "/project/p1/health/tasks/wf_assign",
    },
  ]);
  assert.deepEqual(merge.subject.topics, [
    { id: "t_handover", label: "Handing work over", href: "/project/p1/intents?peek=t_handover" },
  ]);
  const rewrite = byTitle("Rewrite lookup_order's searchable description");
  assert.deepEqual(
    rewrite.subject.tasks.map((t) => [t.id, t.color]),
    [["wf_order", "chart-5"]],
  );
  assert.deepEqual(
    rewrite.subject.topics.map((t) => t.id),
    ["t_orders"],
  );
  // A tool nobody calls runs in no task.
  assert.deepEqual(byTitle("Retire legacy_export").subject.tasks, []);
  // The neutral task wears no slot.
  assert.deepEqual(
    byTitle("Make notify fail clearly").subject.tasks.map((t) => [t.id, t.color]),
    [
      ["wf_notify", "chart-4"],
      ["wf_rare", null],
    ],
  );
});

test("only the actions a source supports", () => {
  const rewrite = byTitle("Rewrite lookup_order's searchable description");
  assert.deepEqual(
    {
      apply: rewrite.actions.apply,
      dismiss: rewrite.actions.dismiss,
      revert: rewrite.actions.revert,
    },
    { apply: true, dismiss: true, revert: false },
  );
  assert.equal(rewrite.actions.catalogHref, "/project/p1/catalogs/tools?highlight=lookup_order");
  assert.equal(
    rewrite.actions.copy?.text,
    "Look up an order. Use for order status, tracking and where is my order.",
  );
  const merge = byTitle("Merge find_task and assign_task");
  assert.deepEqual(
    { apply: merge.actions.apply, dismiss: merge.actions.dismiss },
    { apply: false, dismiss: true },
    "a drafted change can be dismissed, not applied",
  );
  assert.equal(merge.actions.catalogHref, null);
  assert.match(merge.actions.copy?.text ?? "", /## Problem/);
  const notify = byTitle("Make notify fail clearly");
  assert.equal(notify.actions.apply, false);
  assert.match(notify.actions.copy?.text ?? "", /Make notify's errors say what to change/);
  assert.equal(notify.actions.copy?.label, "Copy prompt");
  assert.equal(notify.actions.catalogHref, "/project/p1/catalogs/tools?highlight=notify");
});

test("a description fix is updated on Quality › Descriptions: the rewrite open, else its tool", () => {
  assert.equal(
    byTitle("Rewrite lookup_order's searchable description").actions.descriptionHref,
    "/project/p1/quality/descriptions?peek=rewrite%3Amq-lookup",
  );
  // An issue that asks for a description change, with no rewrite drafted.
  assert.equal(
    byTitle("Rewrite assign_task's searchable description").actions.descriptionHref,
    "/project/p1/quality/descriptions?tool=assign_task",
  );
  // Every other group changes something else.
  for (const fix of model.open.filter((f) => f.group !== "descriptions"))
    assert.equal(fix.actions.descriptionHref, null, fix.id);
});

test("each fix knows what you do with it, and a short title that leaves the names to its pins", () => {
  assert.deepEqual(
    model.open.map((fix) => [fix.group, fix.short]),
    [
      ["tools", "Merge 2 tools into one"],
      ["descriptions", "Rewrite the searchable description"],
      ["descriptions", "Rewrite the searchable description"],
      ["tools", "Retire a tool"],
      ["tools", "Retire a tool"],
      ["ranking", "Return 5 results per search instead of 10"],
      ["tools", "Tighten its input schema"],
      ["tools", "Make it fail clearly"],
    ],
  );
  for (const fix of model.open) {
    for (const tool of fix.subject.tools)
      assert.ok(!fix.short.includes(tool.label), `${fix.id}: ${fix.short}`);
    assert.doesNotMatch(fix.short, FORBIDDEN, fix.id);
  }
});

test("the expected effect comes from the source's own measurement", () => {
  const rewrite = byTitle("Rewrite lookup_order's searchable description");
  assert.deepEqual(rewrite.effect, {
    value: "+40 pts found",
    figure: "+40 pts",
    unit: "found",
    detail: "3 → 5 of 5 searches",
    tone: "good",
    basis: "replay",
    also: [],
  });
  // A draft's effect is what its filler measured, carried as is.
  const merge = byTitle("Merge find_task and assign_task");
  assert.equal(merge.effect?.value, "2 → 1 calls");
  assert.deepEqual([merge.effect?.figure, merge.effect?.unit], ["2 → 1", "calls"]);
  assert.equal(merge.effect?.detail, "−40 model calls in all, over the window · 40 times together");
  assert.equal(merge.effect?.basis, "runs");
  assert.deepEqual(merge.gain, { roundTrips: 40, calls: 40, ms: 0 });
  assert.equal(byTitle("Retire legacy_export").effect?.value, "−1 tool per list");
  assert.equal(byTitle("Tighten flaky_api's input schema").effect?.value, "−1 failed call");
  // An issue states what it costs, not what fixing it would save.
  assert.equal(byTitle("Make notify fail clearly").effect, null);
});

test("evidence strength reads from how often the problem was seen", () => {
  assert.deepEqual(byTitle("Merge find_task and assign_task").evidence, {
    strength: "strong",
    label: "Strong",
    detail: "Seen 40 times in this window",
  });
  assert.deepEqual(byTitle("Rewrite lookup_order's searchable description").evidence, {
    strength: "solid",
    label: "Solid",
    detail: "Missed 12 searches · Seen it run",
  });
  assert.deepEqual(byTitle("Tighten flaky_api's input schema").evidence?.strength, "early");
  assert.deepEqual(byTitle("Retire legacy_export").evidence, {
    strength: "strong",
    label: "Strong",
    detail: "Not called in 30 days",
  });
});

test("applied rewrites stay listed apart, ready to revert", () => {
  assert.deepEqual(
    model.applied.map((fix) => [fix.id, fix.status, fix.actions.revert, fix.actions.apply]),
    [["rewrite:mq-notify", "applied", true, false]],
  );
  assert.equal(model.applied[0]?.appliedAt, "2026-10-18T09:00:00.000Z");
});

test("the numbers over the list, summed only where it is honest", () => {
  assert.deepEqual(model.stats, {
    open: 8,
    ready: 1,
    fromIssues: 8,
    issues: 8,
    tools: 7,
    // The merge (40) and the schema fix (6) touch different tools, so both count.
    roundTripsSaved: 46,
    evidence: { strong: 5, solid: 2, early: 1, none: 0 },
  });
  // Two fixes on the same tools save the same round trips once.
  const overlapping = buildFixes(
    fixesInput({
      drafts: [
        ...CRAFTS,
        craft("c-fold", "fold_prerequisite", ["find_task", "assign_task"], {
          gain: { roundTrips: 25, calls: 25, ms: 0 },
          measured: true,
          score: 25,
        }),
      ],
    }),
  );
  assert.equal(overlapping.stats.roundTripsSaved, 46);
  assert.equal(buildFixes(fixesInput({ drafts: [] })).stats.roundTripsSaved, null);
});

test("filters keep the URL's meaning: kind, task, tool, topic", () => {
  assert.deepEqual(
    filterFixes(model.open, { kind: "rewrite", task: null, tool: null, topic: null }).map(
      (f) => f.id,
    ),
    ["rewrite:mq-lookup", "issue:i-magnet-2"],
  );
  assert.deepEqual(
    filterFixes(model.open, { kind: null, task: "wf_assign", tool: null, topic: null }).map(
      (f) => f.id,
    ),
    ["craft:c-merge", "issue:i-magnet-2"],
  );
  assert.deepEqual(
    filterFixes(model.open, { kind: null, task: null, tool: "lookup_order", topic: null }).map(
      (f) => f.id,
    ),
    ["rewrite:mq-lookup"],
  );
  assert.deepEqual(
    filterFixes(model.open, { kind: null, task: null, tool: null, topic: "t_orders" }).map(
      (f) => f.id,
    ),
    ["rewrite:mq-lookup"],
  );
  assert.deepEqual(
    fixesForSubject(model.open, { task: "wf_order" }).map((f) => f.id),
    ["rewrite:mq-lookup"],
  );
});

test("a source that failed is named, and the rest still lists", () => {
  const partial = buildFixes(fixesInput({ drafts: [], failed: ["craft"] }));
  assert.deepEqual(partial.failed, ["craft"]);
  assert.ok(partial.open.some((fix) => fix.source === "rewrite"));
});

test("with rewrites off, a drafted rewrite stands on its own and nothing can be applied", () => {
  const off = buildFixes(fixesInput({ rewrites: null }));
  assert.equal(off.rewritesOn, false);
  const rewrite = off.open.find(
    (fix) => fix.title === "Rewrite lookup_order's searchable description",
  );
  assert.equal(rewrite?.source, "craft");
  assert.equal(rewrite?.actions.apply, false);
  assert.equal(off.applied.length, 0);
});

test("a dismissed rewrite also hides the rewrites of that tool raised before it", () => {
  const dismissed = buildFixes(
    fixesInput({
      rewrites: REWRITES.slice(1),
      dismissedRewrites: [{ toolId: "lookup_order", at: "2026-10-19T09:00:00.000Z" }],
    }),
  );
  assert.equal(
    dismissed.open.some(
      (fix) => fix.kind === "rewrite" && fix.subject.tools[0]?.id === "lookup_order",
    ),
    false,
  );
  // The issue keeps its place on Agent health; it just has no fix here any more.
  assert.equal(findFix(dismissed.open, "issue:i-magnet"), null);
  // A rewrite raised after the dismissal is new information, and shows.
  const later = buildFixes(
    fixesInput({
      rewrites: REWRITES.slice(1),
      dismissedRewrites: [{ toolId: "lookup_order", at: "2026-10-01T09:00:00.000Z" }],
    }),
  );
  assert.equal(
    later.open.some((fix) => fix.kind === "rewrite" && fix.subject.tools[0]?.id === "lookup_order"),
    true,
  );
});

test("an issue linked to its fix by the engine wins over matching by subject", () => {
  const linked = buildFixes(
    fixesInput({
      issues: [
        ...ISSUES,
        issue({
          id: "i-direct",
          kind: "long_turn",
          route: "show_turns",
          subjectKind: "project",
          toolIds: [],
          proposal: { kind: "tool_craft", id: "c-retire" },
        }),
      ],
    }),
  );
  assert.deepEqual(findFix(linked.open, "issue:i-direct")?.id, "craft:c-retire");
});

test("a topic-wide issue of a kind this build does not know still becomes a fix", () => {
  const future = buildFixes(
    fixesInput({
      issues: [
        issue({
          id: "i-sc",
          kind: "self_correcting",
          subjectKind: "topic",
          subjectKey: "t_orders",
          toolIds: [],
          topicId: "t_orders",
          title: "Retries a lot",
          claim: "Turns about order status self-correct 40 times per 100.",
          fix: "Build a tool or add a skill for order status.",
        }),
      ],
    }),
  );
  const fix = findFix(future.open, "issue:i-sc");
  assert.equal(fix?.kind, "build");
  assert.equal(fix?.title, "Build a tool or add a skill for order status");
  assert.deepEqual(
    fix?.subject.topics.map((t) => t.id),
    ["t_orders"],
  );
});

test("no engine words reach the copy", () => {
  for (const fix of [...model.open, ...model.applied]) {
    for (const text of [
      fix.title,
      fix.short,
      fix.why,
      fix.kindLabel,
      fix.evidence?.detail ?? "",
      fix.effect?.value ?? "",
      fix.effect?.detail ?? "",
    ]) {
      assert.doesNotMatch(text, FORBIDDEN, `${fix.id}: ${text}`);
    }
  }
});

test("combining a task's steps names the task when it has a name, else its tools", () => {
  const compose = craft("c-compose", "compose_chain", ["find_task", "assign_task"], {
    taskIds: ["wf_assign"],
  });
  const named = buildFixes(fixesInput({ drafts: [compose] }));
  assert.equal(
    findFix(named.open, "craft:c-compose")?.title,
    "Combine Hand a task over's steps into one tool",
  );
  const unnamed = buildFixes(
    fixesInput({
      drafts: [compose],
      tasks: [
        {
          id: "wf_assign",
          label: "find_task > assign_task",
          named: false,
          runs: 120,
          tools: ["find_task", "assign_task"],
        },
      ],
    }),
  );
  assert.equal(
    findFix(unnamed.open, "craft:c-compose")?.title,
    "Combine find_task and assign_task into one tool",
  );
  // The task still shows, with its color, among what the fix touches.
  assert.deepEqual(
    findFix(unnamed.open, "craft:c-compose")?.subject.tasks.map((task) => task.id),
    ["wf_assign"],
  );
});

test("an effect measured on a handful of cases follows the fixes for open issues", () => {
  const thin = buildFixes(
    fixesInput({
      rewrites: [
        {
          row: {
            ...REWRITES[0]!.row,
            id: "mq-thin",
            toolId: "old_report",
            toolName: "old_report",
            missed: 1,
          },
          howWeKnow: "seen",
        },
      ],
      drafts: [],
    }),
  );
  const order = thin.open.map((fix) => fix.id);
  assert.ok(order.indexOf("rewrite:mq-thin") > order.indexOf("issue:i-padding"), order.join(", "));
});

test("engine sentences shown on Fixes use the product's nouns", () => {
  const worded = buildFixes(
    fixesInput({
      drafts: [],
      issues: [
        issue({
          id: "i-wf",
          kind: "sequence_chain",
          route: "workflow_skill",
          subjectKind: "tool_pair",
          toolIds: ["find_task", "assign_task"],
          claim: "find_task precedes assign_task, slower than your other workflows.",
          fix: "Draft a workflow skill that runs find_task and assign_task as one step.",
        }),
      ],
    }),
  );
  const fix = findFix(worded.open, "issue:i-wf")!;
  assert.equal(fix.title, "Add a skill that runs find_task then assign_task");
  assert.equal(fix.why, "find_task precedes assign_task, slower than your other tasks.");
  assert.deepEqual(fix.detail.source === "issue" ? fix.detail.changes : [], [
    "Draft a skill that runs find_task and assign_task as one step.",
  ]);
  assert.doesNotMatch(fix.actions.copy?.text ?? "", /workflow/i);
});

test("one change to one tool is one fix, whether its tool or its task raised it", () => {
  const fromTool = issue({
    id: "sc-tool",
    kind: "self_correcting",
    route: "show_turns",
    subjectKind: "tool",
    toolIds: ["flaky_api"],
    fix: "Make flaky_api fail with a clear message, or retry inside the tool.",
    metrics: { fixTool: "flaky_api" },
  });
  const fromTask = issue({
    id: "sc-task",
    kind: "self_correcting",
    route: "show_turns",
    subjectKind: "workflow",
    subjectKey: "wf_notify",
    toolIds: ["notify", "flaky_api"],
    taskId: "wf_notify",
    fix: "Make flaky_api fail with a clear message, or retry inside the tool.",
    metrics: { fixTool: "flaky_api" },
  });
  const built = buildFixes(fixesInput({ drafts: [], rewrites: [], issues: [fromTool, fromTask] }));
  const clear = built.open.filter((fix) =>
    fix.subject.tools.some((tool) => tool.id === "flaky_api"),
  );
  assert.equal(clear.length, 1, "not one fix per issue");
  assert.deepEqual(clear[0]?.issues.map((i) => i.id).sort(), ["sc-task", "sc-tool"]);
  assert.deepEqual(
    clear[0]?.subject.tools.map((tool) => tool.id),
    ["flaky_api"],
    "the change touches the tool it names, not the whole task",
  );
  assert.ok(
    clear[0]?.subject.tasks.some((task) => task.id === "wf_notify"),
    "and still says which task it helps",
  );
});

/** A merge the crafter found in one intent's own two-tool pattern, as its filler would tell it. */
function intentMerge(id: string, tools: [string, string], topicId: string) {
  return craft(id, "merge_tools", tools, {
    intentId: topicId,
    why: "Called together in 36 of the intent's 54 turns.",
    detail: {
      source: "craft",
      craftKind: "merge_tools",
      plain: "Two tools that always run together become one.",
      why: ["Called together in 36 of the intent's 54 turns."],
      worth: [],
      worthCaption: null,
      replay: null,
      change: [],
      facts: [],
      sources: [],
      crafted: [],
    },
    evidence: { strength: "strong", label: "Strong", detail: "Seen 36 times in this window" },
    measured: true,
    score: 36,
  });
}

test("a merge found in one intent's pattern names that intent first, and says for which", () => {
  const built = buildFixes(
    fixesInput({
      drafts: [
        ...CRAFTS.filter((card) => card.id !== "c-merge"),
        intentMerge("c-intent", ["find_task", "assign_task"], "t_misc"),
      ],
    }),
  );
  const merge = built.open.find((fix) => fix.id === "craft:c-intent");
  assert.ok(merge);
  assert.equal(
    merge.title,
    "Merge find_task and assign_task",
    "the title stays the change; the intent is its own field",
  );
  assert.deepEqual(merge.intent, {
    id: "t_misc",
    label: "Small talk",
    href: "/project/p1/intents?peek=t_misc",
  });
  assert.deepEqual(
    merge.subject.topics.map((topic) => topic.id),
    ["t_misc", "t_handover"],
    "the intent it was found in, then the ones its tools serve",
  );
  assert.match(
    merge.detail.source === "craft" ? merge.detail.why[0]! : "",
    /of the intent's 54 turns/,
    "its own why counts the intent's turns; the issue it resolves still leads the row",
  );
  assert.equal(
    byTitle("Merge find_task and assign_task").intent,
    undefined,
    "a project-wide merge names no intent",
  );
  assert.equal(
    buildFixes(
      fixesInput({ drafts: [intentMerge("c-intent", ["find_task", "assign_task"], "t_gone")] }),
    ).open[0]!.intent,
    undefined,
    "an intent no longer read is not named",
  );
});

test("the same change drafted twice, project-wide and in an intent, is one fix that keeps the intent", () => {
  const built = buildFixes(
    fixesInput({
      drafts: [...CRAFTS, intentMerge("c-intent", ["assign_task", "find_task"], "t_misc")],
    }),
  );
  const merges = built.open.filter((fix) => fix.kind === "merge");
  assert.equal(merges.length, 1);
  assert.equal(merges[0]!.id, "craft:c-merge");
  assert.ok(merges[0]!.aliases.includes("craft:c-intent"), "the second draft opens the first");
  assert.equal(findFix(built.open, "craft:c-intent")?.id, "craft:c-merge");
  assert.equal(merges[0]!.intent?.id, "t_misc");
  assert.equal(merges[0]!.subject.topics[0]?.id, "t_misc");
});

/** An intent whose turns run find_task then assign_task, with no skill near it. */
function gapIntent(
  topicId: string,
  turns: number,
  over: Partial<StoredTopicPattern> = {},
): IntentGapInput {
  return {
    topicId,
    name: topicId === "t_handover" ? "Handing work over" : "Order status",
    turns,
    pattern: {
      withCalls: turns,
      tools: [
        { id: "find_task", turns: 50 },
        { id: "notify", turns: 45 },
      ],
      runs: 42,
      inOrder: 40,
      also: [],
      helpers: [],
      firsts: [],
      comesBefore: [],
      skills: { invoked: 0, offered: 0 },
      ...over,
    },
  };
}

test("an intent no skill covers is a fix of its own: add a skill for it, with a prompt to copy", () => {
  const built = buildFixes(fixesInput({ intents: [gapIntent("t_handover", 60)], skills: [] }));
  const gap = findFix(built.open, "intent:t_handover");
  assert.ok(gap);
  assert.equal(gap.source, "intent");
  assert.equal(gap.title, "Add a skill for Handing work over");
  assert.equal(gap.short, "Add a skill for 2 steps");
  assert.deepEqual([gap.kind, gap.kindLabel, gap.group], ["skill", "Add a skill", "skills"]);
  assert.deepEqual(gap.intent, {
    id: "t_handover",
    label: "Handing work over",
    href: "/project/p1/intents?peek=t_handover",
  });
  assert.deepEqual(
    gap.subject.tools.map((tool) => tool.id),
    ["find_task", "notify"],
  );
  assert.equal(gap.subject.topics[0]?.id, "t_handover");
  assert.equal(
    gap.why,
    "In 42 of 60 asks the agent ran find_task and notify, with no skill used or offered.",
  );
  assert.deepEqual(gap.evidence, {
    strength: "strong",
    label: "Strong",
    detail: "Seen 42 times in this window · No skill used",
  });
  assert.deepEqual(
    { apply: gap.actions.apply, dismiss: gap.actions.dismiss, revert: gap.actions.revert },
    { apply: false, dismiss: false, revert: false },
  );
  assert.equal(gap.actions.copy?.label, "Copy prompt");
  const prompt = gap.actions.copy?.text ?? "";
  assert.match(
    prompt,
    /^Ratel found a change that would make this agent better: Add a skill for Handing work over\./,
  );
  assert.match(
    prompt,
    /People asked for Handing work over 60 times in the last 30 days, and no skill was used or offered for it/,
  );
  assert.match(prompt, /In 42 asks it ran find_task and notify, 40 of them in the order below\./);
  assert.match(prompt, /1\. find_task\n2\. notify/);
  assert.deepEqual(gap.detail, {
    source: "intent",
    changes: [
      "Write a skill for Handing work over that runs find_task and notify in their usual order.",
      "Publish it in Catalog › Skills, and say in its description when to use it.",
    ],
    steps: ["find_task", "notify"],
    caveat: null,
  });
  assert.doesNotMatch(
    `${gap.title} ${gap.why} ${prompt} ${gap.detail.source === "intent" ? gap.detail.changes.join(" ") : ""}`,
    FORBIDDEN,
  );
  assert.equal(
    built.open.filter((fix) => fix.source !== "intent").length,
    model.open.length,
    "every other fix is as it was",
  );
});

test("a skill the agent used or was offered, or a published one naming the steps, means no gap", () => {
  const ran = buildFixes(
    fixesInput({
      intents: [gapIntent("t_handover", 60, { skills: { invoked: 2, offered: 0 } })],
      skills: [],
    }),
  );
  assert.equal(findFix(ran.open, "intent:t_handover"), null);
  const published = buildFixes(
    fixesInput({
      intents: [gapIntent("t_handover", 60)],
      skills: [{ name: "handover", tools: ["find_task", "notify"] }],
    }),
  );
  assert.equal(findFix(published.open, "intent:t_handover"), null);
  assert.equal(
    findFix(buildFixes(fixesInput()).open, "intent:t_handover"),
    null,
    "no intents read, no gaps",
  );
});

test("a skill an issue already asks for, about the same steps, names the intent instead of a second fix", () => {
  const skillIssue = issue({
    id: "i-skill",
    kind: "sequence_chain",
    route: "workflow_skill",
    subjectKind: "tool_pair",
    toolIds: ["find_task", "notify"],
    title: "Two tools always run together",
    claim: "find_task precedes notify in 90% of the turns that run notify.",
  });
  const built = buildFixes(
    fixesInput({ issues: [...ISSUES, skillIssue], intents: [gapIntent("t_handover", 60)] }),
  );
  const skills = built.open.filter((fix) => fix.kind === "skill");
  assert.deepEqual(
    skills.map((fix) => fix.id),
    ["issue:i-skill"],
  );
  assert.equal(
    skills[0]!.title,
    "Add a skill that runs find_task then notify",
    "the issue's own title stays",
  );
  assert.equal(skills[0]!.intent?.id, "t_handover");
  assert.equal(skills[0]!.subject.topics[0]?.id, "t_handover");
});

test("an open merge or combined tool about the same steps is the same change: it names the intent, and the cap counts only new gaps", () => {
  // find_task and assign_task: c-merge is open for them.
  const merged = gapIntent("t_handover", 60, {
    tools: [
      { id: "find_task", turns: 50 },
      { id: "assign_task", turns: 48 },
    ],
  });
  const others = ["t_a", "t_b", "t_c"].map((id, index) => ({
    ...gapIntent(id, 40 - index),
    name: `Intent ${id}`,
    pattern: {
      ...gapIntent(id, 40).pattern,
      tools: [
        { id: `x_${id}`, turns: 30 },
        { id: `y_${id}`, turns: 30 },
      ],
    },
  }));
  const built = buildFixes(fixesInput({ intents: [merged, ...others] }));
  assert.equal(
    findFix(built.open, "intent:t_handover"),
    null,
    "no second fix for the merged steps",
  );
  assert.equal(findFix(built.open, "craft:c-merge")?.intent?.id, "t_handover");
  assert.deepEqual(
    built.open.filter((fix) => fix.source === "intent").map((fix) => fix.id),
    ["intent:t_a", "intent:t_b", "intent:t_c"],
    "three new gaps still show",
  );
  const dismissed = buildFixes(
    fixesInput({ drafts: CRAFTS.filter((card) => card.id !== "c-merge"), intents: [merged] }),
  );
  assert.equal(
    findFix(dismissed.open, "issue:i-chain")?.intent?.id,
    "t_handover",
    "with the merge gone, the skill the issue asks for names the intent",
  );
  const alone = buildFixes(
    fixesInput({
      drafts: CRAFTS.filter((card) => card.id !== "c-merge"),
      issues: ISSUES.filter((i) => i.id !== "i-chain"),
      intents: [merged],
    }),
  );
  assert.ok(
    findFix(alone.open, "intent:t_handover"),
    "and with neither, the intent's own skill is the fix",
  );
});

test("a lookup folded into the next call makes the steps one call too: the skill gap is that fix", () => {
  const fold = craft("c-fold", "fold_prerequisite", ["find_task", "notify"], {
    measured: true,
    score: 40,
  });
  const built = buildFixes(
    fixesInput({ drafts: [...CRAFTS, fold], intents: [gapIntent("t_handover", 60)] }),
  );
  assert.equal(findFix(built.open, "intent:t_handover"), null);
  assert.equal(findFix(built.open, "craft:c-fold")?.intent?.id, "t_handover");
});
