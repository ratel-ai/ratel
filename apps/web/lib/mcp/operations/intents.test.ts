import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchResult, type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { StoredTopic, TopicInsights, TopicStats } from "@/lib/readings/topics/types";
import type { IntentBreakdown } from "@/lib/views/intents/breakdown";
import { type IntentsOperationDeps, type IntentsRead, intentsOperations } from "./intents";

/**
 * Intents over MCP against an injected reading: the page's rows and Flows,
 * one intent's panel, and the captured text (ways of asking, example asks)
 * cut short and read only for the intent asked about.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

function stats(
  id: string,
  turns: number,
  answered: number,
  over: Partial<TopicStats> = {},
): TopicStats {
  return {
    id,
    turns,
    asks: turns,
    daily: [1, 2, 3, 4],
    answered,
    sentiment: { positive: 2, neutral: 5, negative: 3 },
    tasks: [{ id: "task-a", turns: Math.floor(turns / 2) }],
    untasked: 1,
    tools: [{ id: "find_fare", calls: 40, failures: 4 }],
    selfCorrections: null,
    examples: ["turn-1", "turn-2", "turn-3", "turn-4"],
    askedAgain: 2,
    next: [{ key: "refund", sessions: 6 }],
    ...over,
  };
}

const insights: TopicInsights = {
  version: 1,
  windowDays: 30,
  windowStart: "2026-10-05T00:00:00.000Z",
  windowEnd: "2026-11-04T00:00:00.000Z",
  readFrom: "2026-10-05T00:00:00.000Z",
  capped: false,
  turns: 100,
  sources: { user: 90, prompt: 0, search: 10, none: 0 },
  verdicts: { topic: 80, retry: 5, none: 10, no_ask: 5 },
  sentimentMeasured: 60,
  naming: "model",
  placement: "judged",
  namingHash: null,
  topics: [stats("book", 50, 40), stats("refund", 30, 10)],
  unplaced: { turns: 10, answered: 3 },
  tools: [{ id: "find_fare", calls: 40, failures: 4, task: "task-a" }],
  flows: {
    all: {
      sessions: 20,
      multiTurn: 8,
      wentOn: 2,
      columns: [
        {
          position: 1,
          sessions: 20,
          ended: 4,
          nodes: [
            {
              key: "book",
              sessions: 12,
              unanswered: 2,
              ended: 3,
              next: [{ key: "refund", sessions: 5 }],
              tools: [],
              examples: ["turn-9"],
            },
          ],
        },
      ],
    },
    starts: ["book"],
    byStart: {},
  },
  flowsBlocked: null,
};

function stored(topicId: string, name: string): StoredTopic {
  return {
    topicId,
    name,
    description: "d".repeat(500),
    labelSource: "llm",
    model: null,
    inputHash: "h",
    retiredAt: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
  };
}

const read: IntentsRead = {
  reading: { insights, computedAt: new Date("2026-11-04T00:00:00.000Z") },
  inFlight: false,
  topics: [stored("book", "Book a flight"), stored("refund", "Get a refund")],
  tasks: [{ id: "task-a", runs: 30, typicalOrder: ["find_fare", "hold_fare"] }],
  labels: new Map(),
};

const breakdown: IntentBreakdown = {
  topicId: "book",
  asks: 50,
  placed: 48,
  capped: false,
  whatTheyAskFor: {
    skipped: false,
    more: 0,
    groups: [
      {
        id: "g1",
        label: "Book one way",
        named: true,
        quoted: false,
        asks: 30,
        share: 0.625,
        totalAsks: 32,
        alsoIn: [{ topicId: "refund", asks: 2 }],
        waysOfAsking: {
          skipped: false,
          more: 0,
          ways: [
            {
              id: "w1",
              label: "book me a flight to lisbon",
              asks: 12,
              of: 30,
              samples: ["z".repeat(400), "book a seat", "a third"],
            },
          ],
        },
      },
    ],
  },
  elsewhere: { asks: 0, groups: [] },
  alsoWants: [{ topicId: "refund", asks: 3, share: 0.06 }],
};

function harness(over: Partial<IntentsOperationDeps> = {}, caller: McpAuthContext = auth) {
  const exampleReads: string[][] = [];
  const deps: IntentsOperationDeps = {
    readIntents: async () => read,
    loadIntentBreakdown: async () => breakdown,
    loadIntentSteps: async () => ({ status: "none" }),
    loadExampleAsks: async (_projectId, ids) => {
      exampleReads.push([...ids]);
      return ids.map((id) => ({
        id,
        text: `ask ${id} ${"q".repeat(400)}`,
        source: "user" as const,
        href: `/project/${PROJECT}/traces/turns/${id}`,
      }));
    },
    contentOptIn: async () => true,
    ...over,
  };
  const run = (id: string, params: Record<string, unknown> = {}) =>
    dispatchOperation(
      id,
      { projectId: PROJECT, ...params },
      { registry: buildRegistry(intentsOperations(deps)), auth: caller },
    );
  return { run, exampleReads };
}

function data<T>(result: DispatchResult): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as DispatchSuccess).data as T;
}

test("list_intents returns each intent's numbers and the Flows, with names", async () => {
  const { run } = harness();
  const out = data<{
    status: string;
    intents: {
      id: string;
      name: string;
      answeredShare: number;
      askedNext: { label: string }[];
      tasks: { name: string }[];
    }[];
    flows: {
      all: { steps: { nodes: { label: string; next: { label: string }[] }[] }[] };
      starts: { name: string }[];
    };
    summary: { topics: number };
  }>(await run("list_intents"));

  assert.equal(out.status, "ready");
  assert.equal(out.summary.topics, 2);
  assert.deepEqual(
    out.intents.map((intent) => intent.id),
    ["book", "refund"],
  );
  assert.equal(out.intents[0]!.answeredShare, 0.8);
  assert.equal(out.intents[0]!.askedNext[0]!.label, "Get a refund");
  assert.equal(out.intents[0]!.tasks[0]!.name.length > 0, true);
  assert.equal(out.flows.all.steps[0]!.nodes[0]!.label, "Book a flight");
  assert.equal(out.flows.all.steps[0]!.nodes[0]!.next[0]!.label, "Get a refund");
  assert.equal(out.flows.starts[0]!.name, "Book a flight");
});

test("list_intents sorts least answered first and caps the rows", async () => {
  const { run } = harness();
  const result = await run("list_intents", { sort: "answered", limit: 1, includeFlows: false });
  const out = data<{ intents: { id: string; description: string }[]; flows?: unknown }>(result);
  assert.deepEqual(
    out.intents.map((intent) => intent.id),
    ["refund"],
  );
  assert.equal(out.flows, undefined);
  assert.equal(out.intents[0]!.description.length, 301);
  assert.equal(result.ok && result.truncated, true);
});

test("list_intents with no reading yet says how to get one", async () => {
  const { run } = harness({
    readIntents: async () => ({
      reading: null,
      inFlight: false,
      topics: [],
      tasks: [],
      labels: new Map(),
    }),
  });
  const result = await run("list_intents");
  assert.equal(data<{ status: string }>(result).status, "none");
  assert.match((result as DispatchSuccess).hint ?? "", /request_analysis/);
});

test("get_intent reads the breakdown and only this intent's example asks, cut short", async () => {
  const { run, exampleReads } = harness();
  const result = await run("get_intent", { intentId: "book", examples: 2 });
  const out = data<{
    intent: { name: string };
    breakdown: {
      whatTheyAskFor: {
        groups: { alsoIn: { name: string }[]; waysOfAsking: { ways: { samples: string[] }[] } }[];
      };
      alsoWants: { name: string }[];
    };
    steps: { status: string };
    exampleAsks: { text: string }[];
  }>(result);

  assert.equal(out.intent.name, "Book a flight");
  assert.deepEqual(exampleReads, [["turn-1", "turn-2"]]);
  assert.equal(out.exampleAsks.length, 2);
  assert.equal(out.exampleAsks[0]!.text.length, 201);
  const way = out.breakdown.whatTheyAskFor.groups[0]!.waysOfAsking.ways[0]!;
  assert.equal(way.samples.length, 2);
  assert.equal(way.samples[0]!.length, 201);
  assert.equal(out.breakdown.alsoWants[0]!.name, "Get a refund");
  assert.equal(out.breakdown.whatTheyAskFor.groups[0]!.alsoIn[0]!.name, "Get a refund");
  assert.equal(out.steps.status, "none");
  assert.equal(result.ok && result.truncated, true);
});

test("get_intent with examples: 0 reads no captured asks", async () => {
  const { run, exampleReads } = harness();
  const out = data<{ exampleAsks: unknown[] }>(
    await run("get_intent", { intentId: "refund", examples: 0 }),
  );
  assert.deepEqual(out.exampleAsks, []);
  assert.equal(exampleReads.length, 0);
});

test("get_intent for an unknown intent is not found", async () => {
  const { run } = harness();
  const result = await run("get_intent", { intentId: "nope" });
  assert.equal(result.ok === false && result.error, "not_found");
});

/* Example asks, samples and asks-as-written labels are captured text. */

const OAUTH: McpAuthContext = {
  kind: "oauth",
  externalUserId: "user_abc",
  userId: "u-1",
  memberships: [
    {
      organizationId: "org-1",
      role: "member",
      organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
    },
  ],
};

const CONTENT_CASES = [
  { name: "an API key with the content opt-in off", caller: auth, optIn: false, sees: false },
  { name: "an API key with the content opt-in on", caller: auth, optIn: true, sees: true },
  { name: "a signed-in member, whatever the opt-in", caller: OAUTH, optIn: false, sees: true },
] as const;

for (const { name, caller, optIn, sees } of CONTENT_CASES) {
  test(`intents: captured text for ${name} is ${sees ? "returned" : "withheld"}`, async () => {
    const quoted: IntentBreakdown = {
      ...breakdown,
      whatTheyAskFor: {
        ...breakdown.whatTheyAskFor,
        groups: [
          {
            ...breakdown.whatTheyAskFor.groups[0]!,
            label: "i need a flight tomorrow",
            named: false,
            quoted: true,
          },
        ],
      },
    };
    const { run } = harness(
      { contentOptIn: async () => optIn, loadIntentBreakdown: async () => quoted },
      caller,
    );
    const result = await run("get_intent", { intentId: "book", examples: 1 });
    const out = data<{
      intent: { name: string; turns: number };
      breakdown: {
        whatTheyAskFor: {
          groups: {
            label: string | null;
            asks: number;
            waysOfAsking: { ways: { label: string | null; asks: number; samples: string[] }[] };
          }[];
        };
      };
      exampleAsks: { text: string | null; href: string }[];
      contentWithheld?: true;
    }>(result);
    const group = out.breakdown.whatTheyAskFor.groups[0]!;
    const way = group.waysOfAsking.ways[0]!;

    assert.equal(out.intent.name, "Book a flight", "a model's name for the intent stays");
    assert.equal(group.asks, 30);
    assert.equal(way.asks, 12);
    assert.equal(out.exampleAsks.length, 1);
    assert.match(out.exampleAsks[0]!.href, /turn-1/);
    if (sees) {
      assert.equal(group.label, "i need a flight tomorrow");
      assert.equal(way.label, "book me a flight to lisbon");
      assert.equal(way.samples.length, 2);
      assert.match(out.exampleAsks[0]!.text ?? "", /^ask turn-1/);
      assert.equal(out.contentWithheld, undefined);
    } else {
      assert.equal(group.label, null);
      assert.equal(way.label, null);
      assert.deepEqual(way.samples, []);
      assert.equal(out.exampleAsks[0]!.text, null);
      assert.equal(out.contentWithheld, true);
      assert.match(result.ok ? (result.hint ?? "") : "", /signed-in members/);
    }
  });
}
