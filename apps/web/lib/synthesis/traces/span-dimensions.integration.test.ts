import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { listOperations, listSpans, type TraceQueriesDb } from "./queries";

/**
 * AOBS-5: Spans group and filter by the coding-agent dimensions (MCP server,
 * command, skill, agent), and the Tool grouping can roll `Bash:<command>` up.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TRACE_ID = "0123456789abcdef0123456789abcdef";

test("groups by MCP server, from mcp.server.name or the mcp__server__tool name", async () => {
  const { client, db } = await seeded();
  const rows = await listOperations(
    PROJECT_ID,
    { groupBy: "server", sort: "key", direction: "asc" },
    db,
  );
  assert.deepEqual(
    rows.map(({ key, count, errorCount }) => ({ key, count, errorCount })),
    [
      { key: "beluga_board", count: 2, errorCount: 1 },
      { key: "claude_ai_Slack", count: 1, errorCount: 0 },
    ],
  );
  await client.close();
});

test("groups by command, skill and agent, omitting spans without one", async () => {
  const { client, db } = await seeded();
  const keys = async (groupBy: "command" | "skill" | "agent") =>
    (await listOperations(PROJECT_ID, { groupBy, sort: "key", direction: "asc" }, db)).map(
      ({ key, count }) => `${key}:${count}`,
    );
  assert.deepEqual(await keys("command"), ["git:2", "pnpm:1"]);
  assert.deepEqual(await keys("skill"), ["pr-review:1"]);
  assert.deepEqual(await keys("agent"), ["Explore:2", "claude:6"]);
  await client.close();
});

test("an agent group sums the tokens and cost of its spans", async () => {
  const { client, db } = await seeded();
  const rows = await listOperations(
    PROJECT_ID,
    { groupBy: "agent", sort: "key", direction: "asc" },
    db,
  );
  const explore = rows.find((row) => row.key === "Explore");
  assert.equal(explore?.totalTokens, 1_500);
  assert.equal(explore?.costUsd, 0.02);
  await client.close();
});

test("the Tool grouping rolls Bash:<command> up to Bash", async () => {
  const { client, db } = await seeded();
  const rolled = await listOperations(
    PROJECT_ID,
    { groupBy: "tool", sort: "key", direction: "asc" },
    db,
  );
  assert.deepEqual(
    rolled.map(({ key, count }) => `${key}:${count}`),
    [
      "Bash:3",
      "Skill:1",
      "mcp__beluga_board__task_update:2",
      "mcp__claude_ai_Slack__slack_read_channel:1",
    ],
  );
  await client.close();
});

test("the span list filters by server, command, skill and agent, exactly", async () => {
  const { client, db } = await seeded();
  const names = async (options: Parameters<typeof listSpans>[1]) =>
    (await listSpans(PROJECT_ID, { ...options, sort: "started", direction: "asc" }, db)).items
      .map((item) => item.spanId)
      .sort();
  assert.deepEqual(await names({ server: "beluga_board" }), [spanId(1), spanId(2)]);
  assert.deepEqual(await names({ server: "claude_ai_Slack" }), [spanId(3)]);
  assert.deepEqual(await names({ server: "beluga" }), []);
  assert.deepEqual(await names({ command: "git" }), [spanId(4), spanId(5)]);
  assert.deepEqual(await names({ skill: "pr-review" }), [spanId(7)]);
  assert.deepEqual(await names({ agent: "Explore" }), [spanId(5), spanId(8)]);
  await client.close();
});

type TestDb = TraceQueriesDb & NonNullable<Parameters<typeof insertOtelSpans>[2]>;

async function seeded(): Promise<{ client: PGlite; db: TestDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  const db = drizzle(client, { schema }) as unknown as TestDb;
  const tool = (
    id: number,
    attributes: Record<string, unknown>,
    overrides: Partial<NewOtelSpan> = {},
  ) =>
    span({
      id: uuid(id),
      spanId: spanId(id),
      spanClass: "tool",
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.agent.name": "claude",
        ...attributes,
      },
      ...overrides,
    });
  await insertOtelSpans(
    PROJECT_ID,
    [
      tool(1, {
        "gen_ai.tool.name": "mcp__beluga_board__task_update",
        "mcp.server.name": "beluga_board",
        "ratel.tool.base_name": "task_update",
      }),
      tool(
        2,
        { "gen_ai.tool.name": "mcp__beluga_board__task_update", "mcp.server.name": "beluga_board" },
        { statusCode: 2 },
      ),
      // Another emitter: only the name says which server.
      tool(3, { "gen_ai.tool.name": "mcp__claude_ai_Slack__slack_read_channel" }),
      tool(4, {
        "gen_ai.tool.name": "Bash:git",
        "ratel.tool.base_name": "Bash",
        "ratel.tool.command": "git",
        "ratel.tool.subcommand": "status",
      }),
      tool(5, {
        "gen_ai.tool.name": "Bash:git",
        "ratel.tool.base_name": "Bash",
        "ratel.tool.command": "git",
        "gen_ai.agent.name": "Explore",
      }),
      tool(6, {
        "gen_ai.tool.name": "Bash:pnpm",
        "ratel.tool.base_name": "Bash",
        "ratel.tool.command": "pnpm",
      }),
      tool(7, {
        "gen_ai.tool.name": "Skill",
        "ratel.skill.name": "pr-review",
        "ratel.skill.trigger": "model",
      }),
      span({
        id: uuid(8),
        spanId: spanId(8),
        spanClass: "llm_call",
        model: "claude-haiku-5-5",
        inputTokens: 1_200,
        outputTokens: 300,
        costUsd: "0.02",
        attributes: { "gen_ai.operation.name": "chat", "gen_ai.agent.name": "Explore" },
      }),
      // No dimension at all: in no group.
      span({ id: uuid(9), spanId: spanId(9), attributes: {} }),
    ],
    db,
  );
  return { client, db };
}

function span(overrides: Partial<NewOtelSpan> = {}): NewOtelSpan {
  const startedAt = overrides.startedAt ?? new Date("2026-11-17T10:00:00.000Z");
  return {
    id: uuid(1),
    projectId: PROJECT_ID,
    traceId: TRACE_ID,
    spanId: spanId(1),
    parentSpanId: null,
    name: "agent.run",
    kind: 1,
    spanClass: "other",
    endedAt: overrides.endedAt ?? new Date(startedAt.getTime() + 100),
    durationMs: overrides.durationMs ?? 100,
    statusCode: 1,
    serviceName: "fixture-agent",
    scopeName: "fixture",
    operationName: null,
    providerName: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    costUsd: null,
    searchOrigin: null,
    searchTarget: null,
    searchQuery: null,
    searchTopK: null,
    searchHitCount: null,
    experimentName: null,
    experimentArm: null,
    experimentRole: null,
    experimentAttrs: {},
    attributes: {},
    attrsTruncated: false,
    ...overrides,
    startedAt,
  };
}

function uuid(value: number): string {
  return `00000000-0000-8000-8000-${value.toString(16).padStart(12, "0")}`;
}

function spanId(value: number): string {
  return value.toString(16).padStart(16, "0");
}
