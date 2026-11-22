import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolsByName } from "@/lib/ingest/categorize";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { ListTracesOptions, TraceSummary } from "@/lib/synthesis/traces/queries";
import { type ObservabilityOperationDeps, observabilityOperations } from "./observability";

/**
 * Five tools in this file report token and cost totals, computed from two
 * different pipelines. Nothing stops an agent asking one of them "what did this
 * week cost" and quoting a number the customer's own dashboard disagrees with,
 * so these tests pin the two things that make the choice legible: the result
 * says which pipeline produced it, and the description says which questions
 * belong to it.
 *
 * The descriptions carry weight here that they would not on a smaller surface.
 * There is no `search_operations` step in front of these tools, so the name and
 * the description are the entire discovery surface.
 */
/** Enough of each query to run the serializer; the numbers are never asserted. */
const stubDeps = {
  getTraceKpis: async () => ({
    traces: 0,
    errorRate: 0,
    averageLatencyMs: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
  }),
  getTraceDailyAggregates: async () => [],
  listTraces: async () => ({ items: [], hasMore: false, nextCursor: null }),
  getTraceFacets: async () => ({}),
  getSpanAggregates: async () => ({ spans: 0, errors: 0 }),
  getTraceSpansWithTruncation: async () => ({ spans: [], truncated: false }),
  listTraceOperations: async () => [],
  getTracesIngestDiagnostics: async () => ({}),
  getDailyAggregates: async () => [],
  getToolMetrics: async () => [],
  listRunTools: async () => new Map(),
  listRunAsks: async () => new Map(),
  loadTraceViewProps: async () => null,
  contentOptIn: async () => true,
} as unknown as ObservabilityOperationDeps;

const operations = new Map(observabilityOperations(stubDeps).map((o) => [o.id, o]));

const SPAN_BACKED = ["get_trace_health", "list_span_groups", "get_span_totals"];
const METRICS_BACKED = ["get_cost_by_day", "get_cost_by_tool"];

test("every tool that reports tokens or cost names its own source", async () => {
  for (const id of [...SPAN_BACKED, ...METRICS_BACKED]) {
    const operation = operations.get(id);
    assert.ok(operation, `${id} should exist`);

    const result = await operation.execute(
      {
        auth: { kind: "api-key", projectId: "p", apiKeyId: "k", scopes: ["*"], organization: null },
        projectId: "p",
        organizationId: "o",
        logger: { info() {}, warn() {}, error() {} } as never,
      },
      operation.params.parse({}) as never,
    );

    const source = (result.data as { source?: string }).source;
    assert.equal(
      source,
      SPAN_BACKED.includes(id) ? "spans" : "event_metrics",
      `${id} must label which pipeline its numbers came from`,
    );
  }
});

test("each overlapping tool points at the one to use instead", () => {
  // Without this an agent picks between five similar names by guesswork, and
  // two of the five answer the same question from a different pipeline.
  const crossReferences: Record<string, RegExp> = {
    get_trace_health: /get_cost_by_day/,
    list_span_groups: /get_cost_by_tool/,
    get_span_totals: /get_trace_health|get_cost_by_day/,
    get_cost_by_day: /span/i,
    get_cost_by_tool: /list_span_groups/,
  };

  for (const [id, expected] of Object.entries(crossReferences)) {
    const description = operations.get(id)?.description ?? "";
    assert.match(description, expected, `${id} should say what to use instead`);
  }
});

/**
 * `list_traces` is the Runs page over MCP: its filters go through the page's
 * own resolver, and its cursor is the page's cursor carrying the window, so a
 * second page continues the first rather than restarting against a moved "now".
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const TRACE = "0af7651916cd43dd8448eb211c80319c";
const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};
const TRACE_ROW: TraceSummary = {
  traceId: TRACE,
  rootSpanId: "root",
  rootName: "invoke_agent support-agent",
  startedAt: new Date("2026-11-04T10:00:00.000Z"),
  endedAt: new Date("2026-11-04T10:00:01.000Z"),
  durationMs: 1000,
  statusCode: 1,
  serviceName: "support-agent",
  spanCount: 4,
  errorCount: 1,
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  costUsd: 0.0123456789,
  experimentName: null,
  experimentArm: null,
};

function dispatchWith(
  id: string,
  params: Record<string, unknown>,
  overrides: Partial<ObservabilityOperationDeps>,
) {
  return dispatchOperation(id, params, {
    registry: buildRegistry(observabilityOperations({ ...stubDeps, ...overrides })),
    auth,
  });
}

test("list_traces pages with a cursor tied to its filters, sort and window", async () => {
  const seen: ListTracesOptions[] = [];
  const listTraces = async (_project: string, options: ListTracesOptions = {}) => {
    seen.push(options);
    return {
      items: [TRACE_ROW],
      hasMore: true,
      nextCursor: { startedAt: TRACE_ROW.startedAt, traceId: TRACE, sortValue: 1000 },
    };
  };
  const filters = {
    rootName: "support",
    arm: "candidate",
    conversationId: "conv-a",
    status: ["error"],
    sort: "duration",
    limit: 1,
  };

  const first = (await dispatchWith("list_traces", filters, { listTraces })) as DispatchSuccess & {
    data: { nextCursor: string; traces: unknown[] };
  };
  assert.equal(first.ok, true);
  assert.equal(typeof first.data.nextCursor, "string");
  assert.equal(seen[0].rootName, "support");
  assert.equal(seen[0].arm, "candidate");
  assert.equal(seen[0].conversation, "conv-a", "AOBS-3: the runs of one conversation");
  assert.deepEqual(seen[0].statuses, [2]);
  assert.equal(seen[0].sort, "duration");
  assert.equal(first.truncated, true);

  const second = await dispatchWith(
    "list_traces",
    { ...filters, cursor: first.data.nextCursor },
    { listTraces },
  );
  assert.equal(second.ok, true);
  assert.equal(seen[1].cursor?.traceId, TRACE);
  assert.equal(seen[1].cursor?.sortValue, 1000);
  assert.equal(
    seen[1].until?.toISOString(),
    first.window?.until,
    "page two reads the window page one did",
  );

  const resorted = await dispatchWith(
    "list_traces",
    { ...filters, sort: "cost", cursor: first.data.nextCursor },
    { listTraces },
  );
  assert.equal(resorted.ok === false && resorted.error, "invalid_params");
});

test("list_traces stays compatible with a bare call and adds run details on request", async () => {
  const listTraces = async () => ({ items: [TRACE_ROW], hasMore: false, nextCursor: null });
  const bare = (await dispatchWith("list_traces", {}, { listTraces })) as DispatchSuccess & {
    data: { nextCursor: null; traces: Record<string, unknown>[] };
  };
  assert.equal(bare.ok, true);
  assert.equal(bare.data.nextCursor, null);
  assert.equal(bare.data.traces[0].costUsd, 0.012346);
  assert.ok(!("ask" in bare.data.traces[0]), "details cost two reads, so they are opt-in");

  const detailed = (await dispatchWith(
    "list_traces",
    { includeDetails: true },
    {
      listTraces,
      listRunTools: async () =>
        new Map([[TRACE, Array.from({ length: 20 }, (_, index) => `tool_${index}`)]]),
      listRunAsks: async () => new Map([[TRACE, { prompt: "q".repeat(500), hasRoot: true }]]),
    },
  )) as DispatchSuccess & {
    data: { traces: Array<{ status: string; ask: string; tools: string[] }> };
  };
  const row = detailed.data.traces[0];
  assert.equal(row.status, "failed", "a run with a failed step failed, as the Runs list says");
  assert.ok(row.ask.length <= 241);
  assert.equal(row.tools.length, 15);
  assert.equal(detailed.truncated, true);
});

test("get_trace rows carry the step facts the inspector shows, and no payloads", async () => {
  const tool = {
    spanId: "tool1",
    parentSpanId: "root",
    name: "execute_tool lookup_order",
    kind: 1,
    spanClass: "tool",
    statusCode: 2,
    startedAt: new Date("2026-11-04T10:00:00.000Z"),
    durationMs: 50,
    serviceName: "support-agent",
    inputTokens: null,
    outputTokens: null,
    model: null,
    costUsd: "0.000500",
    searchQuery: null,
    searchHitCount: null,
    operationName: null,
    attributes: { "error.type": "timeout", "gen_ai.tool.call.result": "secret-ish payload" },
  };
  const result = (await dispatchWith(
    "get_trace",
    { traceId: TRACE.toUpperCase() },
    {
      getTraceSpansWithTruncation: (async () => ({ spans: [tool], truncated: false })) as never,
    },
  )) as DispatchSuccess & { data: { traceId: string; spans: Record<string, unknown>[] } };

  assert.equal(result.data.traceId, TRACE);
  const row = result.data.spans[0];
  assert.equal(row.step, "tool");
  assert.equal(row.toolName, "lookup_order");
  assert.equal(row.errorType, "timeout");
  assert.equal(row.costUsd, 0.0005);
  assert.ok(!JSON.stringify(row).includes("secret-ish payload"));
  assert.match(result.hint ?? "", /get_span/);
});

/**
 * A run's ask and a search's words are captured text: a signed-in member reads
 * them, an API key only with the project's content opt-in.
 */
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
  test(`observability: captured text for ${name} is ${sees ? "returned" : "withheld"}`, async () => {
    const search = {
      spanId: "search1",
      parentSpanId: "root",
      name: "ratel.search",
      kind: 1,
      spanClass: "ratel_search",
      statusCode: 1,
      startedAt: new Date("2026-11-04T10:00:00.000Z"),
      durationMs: 20,
      serviceName: "support-agent",
      inputTokens: null,
      outputTokens: null,
      model: null,
      costUsd: null,
      searchQuery: "refund my order 1234",
      searchHitCount: 3,
      operationName: null,
      attributes: {},
    };
    const registry = buildRegistry(
      observabilityOperations({
        ...stubDeps,
        contentOptIn: async () => optIn,
        listTraces: (async () => ({
          items: [TRACE_ROW],
          hasMore: false,
          nextCursor: null,
        })) as never,
        listRunAsks: (async () =>
          new Map([[TRACE, { prompt: "Where is order 1234?", hasRoot: true }]])) as never,
        getTraceSpansWithTruncation: (async () => ({ spans: [search], truncated: false })) as never,
      }),
    );
    const call = (id: string, params: Record<string, unknown>) =>
      dispatchOperation(
        id,
        { projectId: PROJECT, ...params },
        { registry, auth: caller },
      ) as Promise<DispatchSuccess>;

    const runs = (await call("list_traces", { includeDetails: true })) as DispatchSuccess & {
      data: { traces: Array<{ ask: string | null; tools: string[] }>; contentWithheld?: true };
    };
    const trace = (await call("get_trace", { traceId: TRACE })) as DispatchSuccess & {
      data: {
        spans: Array<{ searchQuery?: string; searchHitCount?: number }>;
        contentWithheld?: true;
      };
    };
    assert.equal(runs.ok && trace.ok, true);

    assert.equal(runs.data.traces[0].ask, sees ? "Where is order 1234?" : null);
    assert.equal(trace.data.spans[0].searchQuery, sees ? "refund my order 1234" : undefined);
    assert.equal(trace.data.spans[0].searchHitCount, 3, "the hit count is a fact, not text");
    assert.equal(runs.data.contentWithheld, sees ? undefined : true);
    assert.equal(trace.data.contentWithheld, sees ? undefined : true);
    if (sees) {
      assert.match(
        trace.hint ?? "",
        /get_span opens one span with its attributes and tool payloads/,
      );
    } else {
      assert.match(runs.hint ?? "", /signed-in members/);
      assert.match(trace.hint ?? "", /signed-in members/);
      assert.match(
        trace.hint ?? "",
        /without its attributes or tool payloads/,
        "the hint does not promise what get_span will withhold",
      );
    }
  });
}

test("get_trace's view gets the console trace page's TraceView props; without content access, no captured text", async () => {
  const root = {
    spanId: "root",
    parentSpanId: null,
    name: "invoke_agent support",
    kind: 1,
    spanClass: "agent",
    statusCode: 1,
    startedAt: new Date("2026-11-04T10:00:00.000Z"),
    durationMs: 900,
    serviceName: "support-agent",
    inputTokens: null,
    outputTokens: null,
    model: null,
    costUsd: null,
    searchQuery: null,
    searchHitCount: null,
    operationName: "invoke_agent",
    attributes: {},
  };
  const span = (attributes: Record<string, unknown>) => ({
    ...root,
    startedAt: "2026-11-04T10:00:00.000Z",
    endedAt: "2026-11-04T10:00:00.900Z",
    searchQuery: "refund for order 1234",
    experimentAttrs: { q: "refund" },
    attributes,
  });
  const props = {
    projectId: "p",
    traceId: TRACE,
    title: "Where is my refund for order 1234?",
    payloadContent: { messages: [{ role: "user", text: "Where is my refund?" }] },
    waterfall: {
      startedAt: null,
      endedAt: null,
      durationMs: 900,
      rows: [
        {
          depth: 0,
          span: span({
            "gen_ai.tool.name": "lookup_order",
            "error.type": "timeout",
            "gen_ai.input.messages": "Where is my refund?",
            "gen_ai.tool.call.arguments": '{"order":1234}',
          }),
        },
      ],
    },
    lifecycle: [{ id: "l1", experimentAttrs: { query: "refund" } }],
  };
  let reads = 0;
  const deps = {
    ...stubDeps,
    getTraceSpansWithTruncation: (async () => ({ spans: [root], truncated: false })) as never,
    loadTraceViewProps: (async () => {
      reads += 1;
      return props;
    }) as never,
  };
  const call = (forView: boolean, optIn: boolean) =>
    dispatchOperation(
      "get_trace",
      { traceId: TRACE },
      {
        registry: buildRegistry(
          observabilityOperations({ ...deps, contentOptIn: async () => optIn }),
        ),
        auth,
        forView,
      },
    ) as Promise<DispatchSuccess>;

  const plain = await call(false, true);
  assert.equal(plain.view, undefined);
  assert.equal(reads, 0, "no extra read without a view");

  const open = await call(true, true);
  assert.deepEqual(open.data, plain.data, "the agent's data is unchanged");
  assert.deepEqual(open.view, { kind: "trace", props });

  const withheld = (await call(true, false)).view as { props: typeof props };
  const text = JSON.stringify(withheld);
  for (const captured of [
    "Where is my refund",
    "refund for order",
    'order\\":1234',
    '"query":"refund',
  ])
    assert.ok(!text.includes(captured), `withheld view leaks ${captured}`);
  assert.equal(withheld.props.payloadContent, null);
  assert.equal(withheld.props.title, "support", "the root step in plain words, not the ask");
  assert.deepEqual(withheld.props.waterfall.rows[0]!.span.attributes, {
    "gen_ai.tool.name": "lookup_order",
    "error.type": "timeout",
  });
});

test("get_cost_by_tool returns one row per tool, keyed by its name, largest footprint first (AOBS-3)", async () => {
  // One map per model call, as `event_metrics.tools_by_name` stores them.
  const getToolMetrics = async (): Promise<ToolsByName[]> => [
    { Bash: { calls: 2, tokens: 300 }, Read: { calls: 0, tokens: 50 } },
    { Bash: { calls: 1, tokens: 100 }, search_capabilities: { calls: 1, tokens: 20 } },
  ];
  const result = (await dispatchWith(
    "get_cost_by_tool",
    {},
    { getToolMetrics },
  )) as DispatchSuccess & {
    data: { count: number; total: number; tools: Array<Record<string, unknown>> };
  };

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.tools, [
    {
      name: "Bash",
      isGatewayMetaTool: false,
      calls: 3,
      tokens: 400,
      usedTokens: 400,
      unusedTokens: 0,
    },
    {
      name: "Read",
      isGatewayMetaTool: false,
      calls: 0,
      tokens: 50,
      usedTokens: 0,
      unusedTokens: 50,
    },
    {
      name: "search_capabilities",
      isGatewayMetaTool: true,
      calls: 1,
      tokens: 20,
      usedTokens: 20,
      unusedTokens: 0,
    },
  ]);
  assert.deepEqual([result.data.count, result.data.total], [3, 3]);

  const capped = (await dispatchWith(
    "get_cost_by_tool",
    { limit: 1 },
    { getToolMetrics },
  )) as DispatchSuccess & {
    data: { count: number; total: number; tools: Array<{ name: string }> };
  };
  assert.deepEqual(
    capped.data.tools.map((tool) => tool.name),
    ["Bash"],
  );
  assert.deepEqual([capped.data.count, capped.data.total, capped.truncated], [1, 3, true]);
});

/** AOBS-5: `list_span_groups` takes the coding-agent groupings. */
function spanGroups() {
  const calls: Array<Record<string, unknown>> = [];
  const operation = observabilityOperations({
    ...stubDeps,
    listTraceOperations: (async (_projectId: string, options: Record<string, unknown>) => {
      calls.push(options);
      return [];
    }) as never,
  }).find((candidate) => candidate.id === "list_span_groups")!;
  const run = (args: Record<string, unknown>) =>
    operation.execute(
      {
        auth,
        projectId: PROJECT,
        organizationId: "org-1",
        logger: { info() {}, warn() {}, error() {} } as never,
      },
      operation.params.parse(args) as never,
    );
  return { calls, run };
}

test("list_span_groups groups by MCP server, command, skill and agent", async () => {
  const { calls, run } = spanGroups();
  for (const groupBy of ["server", "command", "skill", "agent"]) {
    const result = await run({ groupBy });
    assert.equal((result.data as { groupBy: string }).groupBy, groupBy);
  }
  assert.deepEqual(
    calls.map((call) => call.groupBy),
    ["server", "command", "skill", "agent"],
  );
});

test("list_span_groups groups cost by chat, task and repo", async () => {
  const { calls, run } = spanGroups();
  for (const groupBy of ["chat", "task", "repo"]) await run({ groupBy });
  assert.deepEqual(
    calls.map((call) => call.groupBy),
    ["chat", "task", "repo"],
  );
});
