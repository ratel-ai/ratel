import { BASE_URL } from "@/lib/platform/app-config";
import type { SetupKey } from "@/lib/readings/trace-signals/setup-facts";

/**
 * How to turn each data point on, for the stacks customers send us from.
 * Attribute names are the ones ingest reads (`lib/otlp/attr-resolve.ts`,
 * `lib/otlp/constants.ts`); the Ratel SDK lines are the SDK's public calls
 * (`r` is the `ratel()` runtime), checked against the SDK and Cloud SDK
 * READMEs. Plain text only, no em dashes.
 */

export type SetupStack = "otel" | "ai_sdk" | "openinference" | "mcp" | "ratel_sdk" | "ratel_sdk_py";

export const STACK_LABEL: Readonly<Record<SetupStack, string>> = {
  otel: "OpenTelemetry GenAI",
  ai_sdk: "Vercel AI SDK",
  openinference: "OpenInference",
  mcp: "MCP",
  ratel_sdk: "Ratel SDK",
  ratel_sdk_py: "Ratel SDK (Python)",
};

export interface SetupGuide {
  stack: SetupStack;
  /** The snippet, copied as is. */
  code: string;
  /** One short line under it, or null. */
  note: string | null;
}

const lines = (...rows: string[]): string => rows.join("\n");

/** The first SDK releases with the turn scope and recordToolCall. */
export const RATEL_SDK_TURNS_VERSION = "0.13.0-rc.10";
export const RATEL_PY_TURNS_VERSION = "0.13.0rc10";

const AI_SDK_TELEMETRY = lines(
  "await generateText({",
  "  // ...model, tools, messages",
  "  experimental_telemetry: {",
  "    isEnabled: true,",
  "    recordInputs: true,",
  "    recordOutputs: true,",
  "    metadata: { sessionId, userId },",
  "  },",
  "});",
);

const GUIDES: Readonly<Record<SetupKey, readonly SetupGuide[]>> = {
  otel_tool_spans: [
    {
      stack: "otel",
      code: lines(
        "const span = tracer.startSpan(`execute_tool ${tool.name}`);",
        'span.setAttribute("gen_ai.operation.name", "execute_tool");',
        'span.setAttribute("gen_ai.tool.name", tool.name);',
      ),
      note: "One span per tool call, ended when the call returns.",
    },
    {
      stack: "ai_sdk",
      code: AI_SDK_TELEMETRY,
      note: "Each tool call becomes an ai.toolCall span.",
    },
    {
      stack: "openinference",
      code: 'span.set_attribute("openinference.span.kind", "TOOL")',
      note: "Instrumentors set this on tool spans for you; check yours is registered.",
    },
  ],
  otel_model_calls: [
    {
      stack: "otel",
      code: lines(
        "const span = tracer.startSpan(`chat ${model}`);",
        'span.setAttribute("gen_ai.operation.name", "chat");',
        'span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);',
        'span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);',
      ),
      note: "One span per model call, with the tool call spans under it.",
    },
    {
      stack: "ai_sdk",
      code: AI_SDK_TELEMETRY,
      note: "Model calls arrive as doGenerate and doStream spans.",
    },
    {
      stack: "openinference",
      code: 'span.set_attribute("openinference.span.kind", "LLM")',
      note: "Instrumentors set this on model call spans for you.",
    },
  ],
  otel_conversation_id: [
    {
      stack: "otel",
      code: 'span.setAttribute("gen_ai.conversation.id", conversationId);',
      note: "session.id works too. Set it on every span of the conversation.",
    },
    {
      stack: "ai_sdk",
      code: AI_SDK_TELEMETRY,
      note: "metadata.sessionId is read as the conversation id.",
    },
    {
      stack: "openinference",
      code: lines(
        "from openinference.instrumentation import using_session",
        "",
        "with using_session(session_id):",
        "    run_agent(request)",
      ),
      note: null,
    },
  ],
  otel_user_id: [
    { stack: "otel", code: 'span.setAttribute("user.id", userId);', note: "enduser.id works too." },
    { stack: "ai_sdk", code: AI_SDK_TELEMETRY, note: "metadata.userId is read as the user id." },
    {
      stack: "openinference",
      code: lines(
        "from openinference.instrumentation import using_user",
        "",
        "with using_user(user_id):",
        "    run_agent(request)",
      ),
      note: null,
    },
  ],
  otel_content: [
    {
      stack: "otel",
      code: "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true",
      note: "Set before the SDK starts. Some instrumentations take SPAN_AND_EVENT instead of true.",
    },
    {
      stack: "ai_sdk",
      code: AI_SDK_TELEMETRY,
      note: "recordInputs and recordOutputs carry the messages and tool results.",
    },
    {
      stack: "openinference",
      code: lines("OPENINFERENCE_HIDE_INPUTS=false", "OPENINFERENCE_HIDE_OUTPUTS=false"),
      note: "Content is on by default; make sure nothing hides it.",
    },
  ],
  otel_tool_definitions: [
    {
      stack: "otel",
      code: 'span.setAttribute("gen_ai.tool.definitions", JSON.stringify(tools));',
      note: "On each model call span: the tools offered to the model.",
    },
    {
      stack: "ai_sdk",
      code: AI_SDK_TELEMETRY,
      note: "recordInputs sends the tools offered to the model.",
    },
  ],
  otel_trace_context: [
    {
      stack: "otel",
      code: lines(
        "// One span around each request: its tool calls join that trace",
        'await tracer.startActiveSpan("invoke_agent", async (span) => {',
        "  await runAgent(request);",
        "  span.end();",
        "});",
      ),
      note: "Until then, calls that share a conversation id are grouped by quiet gaps, which is approximate.",
    },
    {
      stack: "mcp",
      code: lines(
        "// Each tools/call request carries the caller's trace",
        '"params": { "name": "...", "_meta": { "traceparent": "00-<trace id>-<span id>-01" } }',
      ),
      note: "An MCP server joins the client's trace when the client sends this. FastMCP and the Python MCP SDK 2.x clients do by default.",
    },
  ],
  sdk_tool_calls: [
    {
      stack: "ratel_sdk",
      code: lines(
        "// Run the tool through Ratel: the call is recorded for you",
        "const result = await r.tools.invoke(toolId, args);",
        "",
        "// Or, after a tool your own framework ran",
        "r.recordToolCall({ toolId, tookMs, error });",
      ),
      note: `recordToolCall needs @ratel-ai/sdk ${RATEL_SDK_TURNS_VERSION} or later. Ratel's own tools in the Vercel AI SDK and Mastra adapters are recorded for you; record your other tools.`,
    },
    {
      stack: "ratel_sdk_py",
      code: lines(
        "# After a tool your own framework ran",
        "catalog.record_tool_call(tool_id=tool_id, took_ms=took_ms, error=error)",
      ),
      note: `ratel-ai ${RATEL_PY_TURNS_VERSION} or later. Tools run through catalog.invoke are recorded for you.`,
    },
  ],
  sdk_search_queries: [
    {
      stack: "ratel_sdk",
      code: lines(
        'import * as ratelCloud from "@ratel-ai/cloud-sdk/runtime";',
        "",
        `ratelCloud.attach(r, { baseUrl: "${BASE_URL}" });`,
      ),
      note: "Each search sends its query once attached. Using ratel-local? Set privacy to Tool details or Full content.",
    },
  ],
  sdk_turn_ids: [
    {
      stack: "ratel_sdk",
      code: lines(
        "// One turn per user request: every search and tool call inside shares its id",
        "await r.turn(async () => {",
        "  await runAgent(request);",
        "});",
      ),
      note: `Needs @ratel-ai/sdk ${RATEL_SDK_TURNS_VERSION} or later. @ratel-ai/vercel-ai-sdk 0.6.0-rc.1 and @ratel-ai/mastra 0.5.0-rc.1 open a turn per call for you.`,
    },
    {
      stack: "ratel_sdk_py",
      code: lines("with catalog.turn():", "    run_agent(request)"),
      note: `ratel-ai ${RATEL_PY_TURNS_VERSION} or later, on your ToolCatalog. async with works the same way.`,
    },
  ],
  sdk_user_messages: [
    {
      stack: "ratel_sdk",
      code: lines("await r.turn(() => runAgent(request), {", "  userMessage: request.text,", "});"),
      note: "Sent only when you pass it. Until then, the agent's first search stands in for what the user asked.",
    },
    {
      stack: "ratel_sdk_py",
      code: lines("with catalog.turn(user_message=request.text):", "    run_agent(request)"),
      note: null,
    },
  ],
  sdk_end_users: [
    {
      stack: "ratel_sdk",
      code: lines("await r.turn(() => runAgent(request), {", "  endUserId: user.id,", "});"),
      note: "Any stable id for the person your agent serves. Use the same one you pass as endUserId to the Cloud SDK.",
    },
    {
      stack: "ratel_sdk_py",
      code: lines("with catalog.turn(end_user_id=user.id):", "    run_agent(request)"),
      note: null,
    },
  ],
  both_linked: [
    {
      stack: "ratel_sdk",
      code: lines(
        "// Inside the span of the agent run, in the same process",
        'await tracer.startActiveSpan("agent run", async (span) => {',
        "  await r.turn(() => runAgent(request));",
        "  span.end();",
        "});",
      ),
      note: "Ratel events carry the active trace id, so runs link to their model calls by trace.",
    },
    {
      stack: "otel",
      code: lines(
        "// The agent runs in another service: pass the trace along",
        "propagation.inject(context.active(), headers);",
      ),
      note: "Its spans then join the same trace (traceparent header), and the runs link.",
    },
  ],
};

export function setupGuides(key: SetupKey): readonly SetupGuide[] {
  return GUIDES[key];
}
