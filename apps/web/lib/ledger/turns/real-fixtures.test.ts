import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadFixture,
  type PipelineResult,
  runPipeline,
  toolSequence,
} from "@/lib/ledger/turns/real-fixtures";

/**
 * Real agent libraries' OTLP output (`__fixtures__/real/`, see its README),
 * through decode, tool and model-call derivation and the turn builder. Every
 * library ran the same agent: three requests in one conversation, 2 to 3 tools
 * each, `archive_board` failing. Expectations are what each library actually
 * lets us see, so a library limitation reads as such here (no menu, no user).
 */

const ASKS = [
  "Find the Falcon login bug and assign it to Ada",
  "What is on Ada's plate this week?",
  "Archive the stale Orion board",
];
const RUNS = [
  ["search_tasks", "get_task", "assign_task"],
  ["get_user", "list_tasks"],
  ["find_board", "archive_board!", "notify"],
];
const ALL_TOOLS = [
  "archive_board",
  "assign_task",
  "find_board",
  "get_task",
  "get_user",
  "list_tasks",
  "notify",
  "search_tasks",
];
const CALLS = [4, 3, 4];
const TOKENS: [number, number][] = [
  [1040, 80],
  [660, 60],
  [1120, 80],
];

interface Expected {
  /** Tool sequence per run, in time order; `!` marks a failed call. */
  runs: string[][];
  /** The session every run carries; `trace` when none was sent (the trace id stands in). */
  session: string | "trace";
  user: string | null;
  /** The failed call's error type. */
  errorType: string | null;
  /** Model round trips per run; omitted for MCP-only captures, which have none. */
  modelCalls?: number[];
  tokens?: [number, number][];
  model?: string;
  /** Whether the offered tool names were captured. */
  menu?: boolean;
  /** The user's asks, when content capture carries them. */
  asks?: string[];
  /** Turn-key prefix, when runs are not one per trace. */
  keyPrefix?: string;
  /** Traces in the export, all bodies together. */
  traces: number;
}

const AGENT = { modelCalls: CALLS, tokens: TOKENS, asks: ASKS, traces: 3 } as const;

const EXPECTED: Record<string, Expected> = {
  "vercel-ai": {
    ...AGENT,
    runs: RUNS,
    session: "sess-vercel-ai",
    user: "user-42",
    errorType: "Error",
    model: "gpt-4o-mini-2024-07-18",
    menu: true,
  },
  "vercel-ai-stream": {
    runs: RUNS.slice(0, 1),
    session: "sess-vercel-ai-stream",
    user: "user-42",
    errorType: null,
    modelCalls: [4],
    tokens: TOKENS.slice(0, 1),
    model: "gpt-4o-mini-2024-07-18",
    menu: true,
    asks: ASKS.slice(0, 1),
    traces: 1,
  },
  mastra: {
    ...AGENT,
    runs: RUNS,
    session: "sess-mastra",
    user: "user-42",
    errorType: "unknown",
    model: "gpt-4o-mini-2024-07-18",
    menu: true,
  },
  "langgraph-openinference": {
    ...AGENT,
    runs: RUNS,
    session: "sess-langgraph-openinference",
    user: "user-42",
    errorType: "RuntimeError",
    model: "fake-scripted-chat",
    menu: true,
  },
  // The Agents SDK's own `generation` spans carry no tool definitions.
  "openai-agents-openinference": {
    ...AGENT,
    runs: RUNS,
    session: "sess-openai-agents-openinference",
    user: "user-42",
    errorType: "error",
    model: "gpt-4o-mini",
    menu: false,
  },
  // With the OpenAI client instrumented too, each call is two nested LLM spans: counted once.
  "openai-agents-openinference-plus-openai": {
    ...AGENT,
    runs: RUNS,
    session: "sess-openai-agents-openinference",
    user: "user-42",
    errorType: "error",
    model: "gpt-4o-mini",
    menu: true,
  },
  "openllmetry-openai": {
    ...AGENT,
    runs: RUNS,
    session: "sess-openllmetry-openai",
    user: "user-42",
    errorType: "RuntimeError",
    model: "gpt-4o-mini",
    menu: true,
  },
  // A plain exception aborts a Pydantic AI run: no notify, no final answer.
  "pydantic-ai": {
    ...AGENT,
    runs: [RUNS[0], RUNS[1], ["find_board", "archive_board!"]],
    session: "sess-pydantic-ai",
    user: null,
    errorType: "RuntimeError",
    modelCalls: [4, 3, 2],
    tokens: [TOKENS[0], TOKENS[1], [360, 40]],
    model: "function:scripted_model:",
    menu: true,
  },
  "pydantic-ai-modelretry": {
    ...AGENT,
    runs: RUNS,
    session: "sess-pydantic-ai",
    user: null,
    errorType: "pydantic_ai.exceptions.ToolRetryError",
    model: "function:scripted_model:",
    menu: true,
  },
  // Client and server both export; the server joins the client's trace and each call is stored once.
  "mcp-python-fastmcp": {
    runs: RUNS,
    session: "sess-mcp-python-fastmcp",
    user: "user-42",
    errorType: "tool_error",
    traces: 4,
  },
  "mcp-python-fastmcp-modern": {
    runs: RUNS,
    session: "sess-mcp-python-fastmcp-modern",
    user: "user-42",
    errorType: "tool_error",
    traces: 12,
  },
  // No trace context reaches the server: one trace per call, grouped by the MCP session and quiet gap.
  // The three requests were a second apart, so they read as one run.
  "mcp-python-fastmcp-server-only": {
    runs: [RUNS.flat()],
    session: "d28d1a5de2c1474693daef108e33e652",
    user: null,
    errorType: "tool_error",
    keyPrefix: "otlp-run:",
    traces: 10,
  },
  // The SDK's client span never records `isError`, and here it arrived first, so the failure is not seen.
  "mcp-python-sdk-native": {
    runs: [RUNS[0], RUNS[1], ["find_board", "archive_board", "notify"]],
    session: "sess-mcp-python-sdk-native",
    user: "user-42",
    errorType: null,
    traces: 5,
  },
  // No trace context and no session: every call is its own run.
  "mcp-python-sdk-native-server-only": {
    runs: RUNS.flat().map((tool) => [tool]),
    session: "trace",
    user: null,
    errorType: "tool_error",
    traces: 11,
  },
  "mcp-python-openinference": {
    runs: [RUNS[0], RUNS[1], ["find_board", "archive_board", "notify"]],
    session: "sess-mcp-python-openinference",
    user: "user-42",
    errorType: null,
    traces: 5,
  },
  "mcp-python-traceloop": {
    runs: RUNS,
    session: "sess-mcp-python-traceloop",
    user: "user-42",
    errorType: "tool_error",
    traces: 5,
  },
  // The TypeScript instrumentation parents every call on one session-long span: one trace, one run.
  "mcp-ts-sdk-traceloop": {
    runs: [RUNS.flat()],
    session: "trace",
    user: null,
    errorType: "error",
    traces: 12,
  },
  // Arize's MCP instrumentation only propagates context; it makes no tool spans.
  "mcp-ts-sdk": { runs: [], session: "trace", user: null, errorType: null, traces: 3 },
};

const results = new Map<string, PipelineResult>();
const resultOf = (name: string): PipelineResult => {
  const known = results.get(name);
  if (known) return known;
  const result = runPipeline(loadFixture(name));
  results.set(name, result);
  return result;
};

const ordered = (result: PipelineResult) =>
  [...result.turns].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.turnKey < b.turnKey ? -1 : 1),
  );

for (const [name, want] of Object.entries(EXPECTED)) {
  test(`${name}: runs, tool calls and their errors`, () => {
    const result = resultOf(name);
    const turns = ordered(result);
    assert.equal(new Set(result.spans.map((s) => s.traceId)).size, want.traces, "traces");
    assert.deepEqual(turns.map(toolSequence), want.runs);
    for (const turn of turns) {
      if (want.session === "trace") assert.match(turn.sessionId, /^[0-9a-f]{32}$/);
      else assert.equal(turn.sessionId, want.session);
      assert.equal(turn.lane, "otlp");
      assert.ok(turn.turnKey.startsWith(want.keyPrefix ?? "otlp:"), turn.turnKey);
    }
    const errors = result.toolRows.filter((row) => row.type === "invoke_error");
    assert.deepEqual(
      errors.map((row) => [row.toolId, row.errorMessage]),
      want.errorType ? [["archive_board", want.errorType]] : [],
    );
    assert.deepEqual(
      [...new Set(result.toolRows.map((row) => row.endUserId))],
      want.runs.length > 0 ? [want.user] : [],
    );
  });

  if (!want.modelCalls) continue;
  test(`${name}: model calls, tokens, model, menu and asks`, () => {
    const result = resultOf(name);
    const facts = ordered(result).map((turn) =>
      result.facts.traces.get(turn.turnKey.slice("otlp:".length)),
    );
    assert.deepEqual(
      facts.map((f) => f?.modelCalls ?? 0),
      want.modelCalls,
    );
    assert.deepEqual(
      facts.map((f) => [f?.inputTokens, f?.outputTokens]),
      want.tokens,
    );
    assert.deepEqual(
      [...new Set(result.modelRows.map((row) => (row.payload as { model?: string }).model))],
      [want.model],
    );
    assert.deepEqual(
      facts.map((f) => [...(f?.menus ?? [])].sort()),
      facts.map(() => (want.menu ? ALL_TOOLS : [])),
    );
    const asks = ordered(result).map((turn) => {
      const traceId = turn.turnKey.slice("otlp:".length);
      const row = result.modelRows.find(
        (r) => r.traceId === traceId && (r.payload as { prompt?: string }).prompt,
      );
      return (row?.payload as { prompt?: string } | undefined)?.prompt ?? null;
    });
    assert.deepEqual(asks, want.asks);
    for (const row of result.modelRows) assert.equal(row.sessionId, want.session);
  });
}

test("the AI SDK's invoke_agent span, which carries the run's summed usage, is not a model call", () => {
  const result = resultOf("vercel-ai");
  assert.equal(result.modelRows.length, 11);
  assert.ok(
    result.spans.some(
      (s) =>
        s.attributes["gen_ai.operation.name"] === "invoke_agent" &&
        s.attributes["gen_ai.usage.input_tokens"] === 1040,
    ),
  );
});

test("an MCP call exported by both client and server is one row whatever arrives first", () => {
  const bodies = loadFixture("mcp-python-fastmcp");
  const forward = runPipeline(bodies);
  const reversed = runPipeline([...bodies].reverse());
  assert.equal(forward.toolRows.length, 8);
  assert.equal(reversed.toolRows.length, 8);
  assert.deepEqual(
    reversed.toolRows.map((r) => r.clientEventId).sort(),
    forward.toolRows.map((r) => r.clientEventId).sort(),
  );
});

test("MCP server-only calls carry the root-tool mark and the MCP session", () => {
  const rows = resultOf("mcp-python-fastmcp-server-only").toolRows;
  assert.ok(rows.every((row) => (row.payload as { root_tool?: boolean }).root_tool === true));
  assert.ok(rows.every((row) => (row.payload as { has_session?: boolean }).has_session === true));
  const noSession = resultOf("mcp-python-sdk-native-server-only").toolRows;
  assert.ok(noSession.every((row) => row.sessionId === row.traceId));
});
