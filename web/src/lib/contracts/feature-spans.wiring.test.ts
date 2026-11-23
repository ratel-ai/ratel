import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resolveAgentsPageContext } from "@/app/(console)/project/[projectId]/agents/context";
import { resolveMcpPageContext } from "@/app/(console)/project/[projectId]/mcp/context";
import { resolveConfig } from "@/config";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { workflowMiningFor } from "@/lib/readings/trace-signals/tool-run-insights";

// The core's feature spans where each feature is wired in, read back from an in-memory exporter.
// The provider is global, so these cases have their own file (one process).

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
);

beforeEach(() => exporter.reset());

const PROJECT = { id: "p1", organizationId: "org-1" } as Project;
const ORGANIZATION = { id: "org-1", slug: "acme" } as Organization;
const pageDeps = (flag: boolean) => ({
  getSessionContext: async () => ({ user: { id: "u1", externalId: "user_1" } }),
  getProjectScope: async () => ({ project: PROJECT, organization: ORGANIZATION, role: "member" }),
  projectEntitiesEnabled: async () => flag,
});

const spans = () =>
  exporter.getFinishedSpans().map((span) => ({
    name: span.name,
    project: span.attributes["project.id"],
    status: span.status.code,
  }));

test("the Agents and MCP servers pages each resolve their context in a feature.agents_pages span", async () => {
  await resolveAgentsPageContext("p1", {}, pageDeps(true));
  await resolveMcpPageContext("p1", {}, pageDeps(true));
  assert.deepEqual(spans(), [
    {
      name: "feature.agents_pages.agents.resolve_context",
      project: "p1",
      status: SpanStatusCode.UNSET,
    },
    {
      name: "feature.agents_pages.mcp_servers.resolve_context",
      project: "p1",
      status: SpanStatusCode.UNSET,
    },
  ]);
});

test("with the flag off the page's not-found is its outcome, not an error", async () => {
  await assert.rejects(resolveAgentsPageContext("p1", {}, pageDeps(false)));
  const [span] = exporter.getFinishedSpans();
  assert.equal(span?.status.code, SpanStatusCode.UNSET);
  assert.match(String(span?.attributes["feature.outcome"]), /404/);
});

test("a project's tool-run mining config is decided in a feature.tool_run_insights span", async () => {
  await workflowMiningFor(
    "p1",
    undefined,
    resolveConfig({ override: { flags: { toolRunInsights: true } } }),
  );
  await workflowMiningFor("p2", undefined, resolveConfig());
  assert.deepEqual(
    exporter
      .getFinishedSpans()
      .map((span) => [
        span.name,
        span.attributes["project.id"],
        span.attributes["tool_run_insights.enabled"],
      ]),
    [
      ["feature.tool_run_insights.mining_config", "p1", true],
      ["feature.tool_run_insights.mining_config", "p2", false],
    ],
  );
});
