import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry, type McpOperation } from "@/lib/mcp/registry";

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
);

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "ratel", effectivePlan: "enterprise" },
};

const operation = {
  id: "demo_op",
  domain: "catalog",
  title: "Demo",
  description: "demo operation",
  scope: "project",
  mutates: false,
  params: z.object({ projectId: z.string().optional() }),
  async execute(ctx) {
    return { data: { projectId: ctx.projectId } };
  },
} as McpOperation;

beforeEach(() => {
  exporter.reset();
});

after(() => {
  trace.disable();
});

test("one dispatched tool call returns its result and makes one execute_tool span", async () => {
  const result = await dispatchOperation(
    "demo_op",
    {},
    { registry: buildRegistry([operation]), auth },
  );
  assert.deepEqual(result, {
    ok: true,
    operation_id: "demo_op",
    data: { projectId: auth.projectId },
  });
  const spans = exporter.getFinishedSpans();
  assert.deepEqual(
    spans.map((span) => span.name),
    ["execute_tool demo_op"],
  );
  assert.equal(spans[0].attributes["ratel.cloud.project_id"], auth.projectId);
  assert.equal(spans[0].attributes["ratel.cloud.organization_id"], "org-1");
});
