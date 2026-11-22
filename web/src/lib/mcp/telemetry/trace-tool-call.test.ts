import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { McpOperationError } from "@/lib/mcp/errors";
import { MCP_TOOL_TRACER } from "./export";
import { type McpToolCall, type McpToolTelemetryDeps, traceMcpToolCall } from "./trace-tool-call";

const T0 = Date.UTC(2026, 10, 17, 10, 0, 0);

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: "proj-1",
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "ratel", effectivePlan: "enterprise" },
};

const call: McpToolCall = {
  toolName: "list_traces",
  args: { limit: 5 },
  auth,
  projectId: "proj-1",
  organizationId: "org-1",
};

function harness(headers: Record<string, string> = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const asked: string[] = [];
  const deps: McpToolTelemetryDeps = {
    requestHeaders: async () => {
      asked.push("headers");
      return new Headers(headers);
    },
    tracer: () => provider.getTracer(MCP_TOOL_TRACER),
    now: () => T0,
  };
  return { exporter, deps, asked };
}

test("one tool call makes one root execute_tool span with tool, session, client, org, project and content", async () => {
  const { exporter, deps } = harness({
    "mcp-session-id": "sess-1",
    "user-agent": "claude-code/2.1.3",
  });
  const result = { data: { rows: [1] }, truncated: true };
  const returned = await traceMcpToolCall(call, async () => result, deps);
  assert.equal(returned, result);

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  const [span] = spans;
  assert.equal(span.name, "execute_tool list_traces");
  assert.equal(span.parentSpanContext, undefined);
  assert.equal(span.status.code, SpanStatusCode.OK);
  assert.equal(span.attributes["gen_ai.operation.name"], "execute_tool");
  assert.equal(span.attributes["gen_ai.tool.name"], "list_traces");
  assert.equal(span.attributes["mcp.method.name"], "tools/call");
  assert.equal(span.attributes["mcp.session.id"], "sess-1");
  assert.equal(span.attributes["gen_ai.agent.name"], "claude-code");
  assert.equal(span.attributes["ratel.cloud.organization_id"], "org-1");
  assert.equal(span.attributes["ratel.cloud.project_id"], "proj-1");
  assert.equal(span.attributes["gen_ai.tool.call.arguments"], JSON.stringify({ limit: 5 }));
  assert.equal(span.attributes["gen_ai.tool.call.result"], JSON.stringify({ rows: [1] }));
});

test("the span carries the credential by id, never the API key", async () => {
  const { exporter, deps } = harness({
    authorization: "Bearer rtl_secret_key",
    "user-agent": "claude-code/2.1.3",
  });
  await traceMcpToolCall(call, async () => ({ data: null }), deps);
  const values = JSON.stringify(exporter.getFinishedSpans()[0].attributes);
  assert.ok(!values.includes("rtl_secret_key"));
});

test("args and results are capped", async () => {
  const { exporter, deps } = harness();
  const huge = "x".repeat(40_000);
  await traceMcpToolCall({ ...call, args: { q: huge } }, async () => ({ data: huge }), deps);
  const [span] = exporter.getFinishedSpans();
  assert.ok(String(span.attributes["gen_ai.tool.call.arguments"]).length <= 32_768);
  assert.ok(String(span.attributes["gen_ai.tool.call.result"]).length <= 32_768);
});

test("without a session header the span carries the derived session id", async () => {
  const { exporter, deps } = harness({ "user-agent": "claude-code/2.1.3" });
  await traceMcpToolCall(call, async () => ({ data: null }), deps);
  assert.match(String(exporter.getFinishedSpans()[0].attributes["mcp.session.id"]), /^derived-/);
});

test("a refused call ends the span as an error with its code and rethrows", async () => {
  const { exporter, deps } = harness();
  const refusal = new McpOperationError("forbidden", "no");
  await assert.rejects(
    traceMcpToolCall(
      call,
      async () => {
        throw refusal;
      },
      deps,
    ),
    (error) => error === refusal,
  );
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.attributes["error.type"], "forbidden");
  assert.equal(span.attributes["gen_ai.tool.call.result"], undefined);
});

test("an unexpected failure is typed internal and its message stays out of the span", async () => {
  const { exporter, deps } = harness();
  await assert.rejects(
    traceMcpToolCall(
      call,
      async () => {
        throw new Error("relation tenant_secret does not exist");
      },
      deps,
    ),
  );
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.attributes["error.type"], "internal");
  assert.equal(span.status.message, undefined);
});

test("a call with no project (an OAuth list_projects) is not traced", async () => {
  const { exporter, deps, asked } = harness();
  const oauth: McpAuthContext = {
    kind: "oauth",
    externalUserId: "user_c",
    userId: "u1",
    memberships: [],
  };
  await traceMcpToolCall(
    { ...call, auth: oauth, projectId: "", organizationId: null },
    async () => ({ data: [] }),
    deps,
  );
  assert.equal(exporter.getFinishedSpans().length, 0);
  assert.deepEqual(asked, []);
});

test("telemetry failures never fail the call", async () => {
  const { exporter, deps } = harness();
  deps.requestHeaders = async () => {
    throw new Error("headers unavailable");
  };
  const returned = await traceMcpToolCall(call, async () => ({ data: 1 }), deps);
  assert.deepEqual(returned, { data: 1 });
  assert.equal(exporter.getFinishedSpans().length, 1);
});
