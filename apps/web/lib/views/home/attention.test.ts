import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AttentionInput,
  type AttentionIssue,
  buildAttention,
  issueGroups,
} from "@/lib/views/home/attention";
import type { ContextSplit } from "@/lib/views/home/overview-model";

function input(overrides: Partial<AttentionInput> = {}): AttentionInput {
  return {
    errors: { count: 0, total: 100, href: "/traces?errorOnly=1" },
    issues: [],
    lockedIssues: 0,
    issueHref: (id) => `/health?peek=issue%3A${id}`,
    healthHref: "/health",
    tasks: {},
    taskSteps: [],
    unanswered: [],
    pendingRewrites: null,
    contextSuggestions: [],
    contextSplit: null,
    contextPeek: "context",
    ...overrides,
  };
}

function issue(
  id: string,
  kind: AttentionIssue["kind"],
  chips: string[] = [id],
  over: Partial<AttentionIssue> = {},
): AttentionIssue {
  return {
    id,
    kind,
    subject: {
      kind: chips.length === 2 ? "tool_pair" : "tool",
      key: chips.join("|"),
      label: chips.join(" and "),
      chips: chips.map((chip) => ({ id: chip, label: chip, entryKind: "tool" as const })),
    },
    figure: { display: "41%" },
    fixRoute: "rewrite_description",
    ...over,
  };
}

const SPLIT: ContextSplit = {
  totalTokens: 1_000,
  runs: 10,
  rows: [
    {
      source: "tools",
      label: "Tools",
      tokens: 600,
      share: 0.6,
      waste: { label: "never called", share: 0.93 },
    },
    { source: "history", label: "History", tokens: 300, share: 0.3, waste: null },
  ],
};

test("nothing to say is an empty list", () => {
  assert.deepEqual(buildAttention(input()), { items: [], moreIssues: 0 });
});

test("failing runs lead once there are enough of them, as a share with its count", () => {
  const { items } = buildAttention(
    input({
      errors: { count: 9, total: 60, href: "/traces?errorOnly=1" },
      issues: [issue("a", "error_loop")],
    }),
  );
  assert.deepEqual(items[0], {
    key: "errors",
    tone: "danger",
    mark: "run",
    title: "Failed runs",
    subject: null,
    figure: { value: "15%", caption: "9 of 60" },
    target: { kind: "link", href: "/traces?errorOnly=1" },
  });
  assert.equal(items[1]!.key, "issue:a");
  // A few failures in a handful of runs, or a rare one, are not news.
  assert.equal(
    buildAttention(input({ errors: { count: 3, total: 10, href: "/x" } })).items.length,
    0,
  );
  assert.equal(
    buildAttention(input({ errors: { count: 2, total: 100, href: "/x" } })).items.length,
    0,
  );
});

test("an issue row is its kind's short title, its tools as pins and its one number", () => {
  const { items } = buildAttention(
    input({
      issues: [
        issue("a", "latency_outlier", ["create_tasks_batch"], { figure: { display: "58.3 s" } }),
      ],
    }),
  );
  assert.deepEqual(items[0], {
    key: "issue:a",
    tone: "warning",
    mark: "issue",
    title: "Slow tool",
    subject: { kind: "tools", tools: [{ name: "create_tasks_batch", skill: false }], more: 0 },
    figure: { value: "58.3 s", caption: "slowest calls" },
    target: { kind: "link", href: "/health?peek=issue%3Aa" },
  });
});

test("issues of one kind share a row: the worst's tool and number, the rest counted", () => {
  const issues = [
    issue("a", "error_loop", ["upload"], { figure: { display: "12" } }),
    issue("b", "latency_outlier", ["search"]),
    issue("c", "error_loop", ["fetch"], { figure: { display: "30" } }),
    issue("d", "error_loop", ["sync"]),
  ];
  const { items, moreIssues } = buildAttention(input({ issues }));
  assert.deepEqual(
    items.map((item) => item.key),
    ["issue:a", "issue:b"],
  );
  assert.deepEqual(items[0]!.subject, {
    kind: "tools",
    tools: [{ name: "upload", skill: false }],
    more: 2,
  });
  assert.equal(items[0]!.figure.value, "12", "the row leads with its worst issue");
  assert.equal(moreIssues, 0);
});

test("a pair keeps both tools; the other pairs are counted", () => {
  const { items } = buildAttention(
    input({
      issues: [
        issue("a", "sibling_confusion", ["find_documents", "search_chunks"]),
        issue("b", "sibling_confusion", ["x", "y"]),
      ],
    }),
  );
  assert.deepEqual(items[0]!.subject, {
    kind: "tools",
    tools: [
      { name: "find_documents", skill: false },
      { name: "search_chunks", skill: false },
    ],
    more: 1,
  });
  assert.equal(items[0]!.title, "Two tools get mixed up");
});

test("an issue raised on a task names the task as a pin, in its color", () => {
  const failing = issue("t", "workflow_failing", [], {
    subject: { kind: "workflow", key: "wf1", label: "a → b", chips: [] },
    figure: { display: "12%" },
  });
  const { items } = buildAttention(
    input({
      issues: [failing],
      tasks: { wf1: { id: "wf1", name: "Track a delivery", slot: "chart-1", href: "/tasks/wf1" } },
    }),
  );
  assert.equal(items[0]!.mark, "task");
  assert.equal(items[0]!.title, "Runs that fail partway");
  assert.deepEqual(items[0]!.subject, { kind: "task", name: "Track a delivery", slot: "chart-1" });
  assert.equal(items[0]!.figure.caption, "of runs fail");
});

test("self-corrections and intent issues wear their own noun's mark", () => {
  const { items } = buildAttention(
    input({ issues: [issue("s", "self_correcting"), issue("i", "unstable_intent", [])] }),
  );
  assert.deepEqual(
    items.map((item) => [item.key, item.mark]),
    [
      ["issue:s", "selfCorrection"],
      ["issue:i", "intent"],
    ],
  );
  assert.equal(items[1]!.subject, null, "nothing to pin without tools");
});

test("chains with nothing to change, or inside a task, are no issue", () => {
  const nothing = issue("n", "sequence_chain", ["get_po", "track"], { fixRoute: "none" });
  const own = issue("o", "sequence_chain", ["a", "b"], { fixRoute: "workflow_skill" });
  const real = issue("r", "sequence_chain", ["c", "d"], { fixRoute: "workflow_skill" });
  const groups = issueGroups([nothing, own, real], [["a", "b", "x"]]);
  assert.deepEqual(
    groups.map((group) => group.members.map((member) => member.id)),
    [["r"]],
  );
});

test("an issue with a fix opens the fix; one without opens its panel", () => {
  const { items } = buildAttention(
    input({
      issues: [issue("a", "error_loop", ["x"]), issue("b", "latency_outlier", ["y"])],
      fixHref: (id) => (id === "a" ? "/improvement/fixes?peek=craft%3Ac1" : null),
    }),
  );
  assert.deepEqual(items[0]!.target, { kind: "link", href: "/improvement/fixes?peek=craft%3Ac1" });
  assert.deepEqual(items[1]!.target, { kind: "link", href: "/health?peek=issue%3Ab" });
});

test("issues lead without crowding out intents, description updates and context", () => {
  const { items, moreIssues } = buildAttention(
    input({
      issues: [
        issue("a", "magnet"),
        issue("b", "error_loop"),
        issue("c", "latency_outlier"),
        issue("d", "empty_result"),
      ],
      lockedIssues: 2,
      unanswered: [
        {
          id: "t1",
          name: "Equipment rental",
          href: "/intents?peek=t1",
          turns: 55,
          unanswered: 55,
          answeredShare: 0,
        },
      ],
      pendingRewrites: { count: 3, href: "/quality/descriptions" },
      contextSuggestions: [
        { source: "tools", severity: "high" },
        { source: "history", severity: "medium" },
      ],
      contextSplit: SPLIT,
    }),
  );
  assert.deepEqual(
    items.map((item) => item.key),
    ["issue:a", "issue:b", "intent:t1", "rewrites", "context:tools"],
  );
  // Two kinds past the cut, plus two the plan hides.
  assert.equal(moreIssues, 4);
  const [, , intent, rewrites, context] = items;
  assert.deepEqual(intent, {
    key: "intent:t1",
    tone: "warning",
    mark: "intent",
    title: "Mostly unanswered",
    subject: { kind: "intent", name: "Equipment rental" },
    figure: { value: "0%", caption: "answered" },
    target: { kind: "link", href: "/intents?peek=t1" },
  });
  assert.deepEqual(rewrites, {
    key: "rewrites",
    tone: "info",
    mark: "fix",
    title: "Description updates ready",
    subject: null,
    figure: { value: "3", caption: "to apply" },
    target: { kind: "link", href: "/quality/descriptions" },
  });
  assert.deepEqual(context, {
    key: "context:tools",
    tone: "warning",
    mark: "context",
    title: "Tools never called",
    subject: null,
    figure: { value: "93%", caption: "of tools" },
    target: { kind: "peek", peek: "context" },
  });
});

test("one description update reads in the singular; a context row without waste says its share", () => {
  const { items } = buildAttention(
    input({
      pendingRewrites: { count: 1, href: "/quality/descriptions" },
      contextSuggestions: [{ source: "history", severity: "low" }],
      contextSplit: SPLIT,
    }),
  );
  assert.equal(items[0]!.title, "Description update ready");
  assert.deepEqual(
    [items[1]!.title, items[1]!.tone, items[1]!.figure],
    ["History keeps growing", "info", { value: "30%", caption: "of context" }],
  );
  // Without a split there is no number to show, so no row.
  assert.equal(
    buildAttention(input({ contextSuggestions: [{ source: "tools", severity: "high" }] })).items
      .length,
    0,
  );
});

test("no Agent health count without an Agent health page", () => {
  assert.equal(buildAttention(input({ lockedIssues: 3, healthHref: null })).moreIssues, 0);
});

test("titles and captions speak the product's nouns", () => {
  const { items } = buildAttention(
    input({
      issues: [
        issue("a", "workflow_fixed_chain", [], {
          subject: { kind: "workflow", key: "w", label: "Close out", chips: [] },
        }),
        issue("b", "sequence_chain", ["c", "d"], { fixRoute: "workflow_skill" }),
      ],
    }),
  );
  for (const item of items) {
    assert.doesNotMatch(
      `${item.title} ${item.figure.caption}`,
      /workflow|topic|suggestion|signal/i,
    );
  }
});
