import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { deriveModelCalls } from "@/lib/ingest/otlp/derive-model-calls";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  listTelemetryDeclaredTools,
  type TelemetryDeclaredToolsDb,
} from "./telemetry-declared-tools";

/**
 * AOBS-7: the tools a coding agent declares as `gen_ai.tool.definitions` on
 * the first model call of a turn are listed by name, from the rows OTLP
 * ingest derives.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-17T12:00:00.000Z");

function chat(index: number, startMs: number, tools: string[] | null): DecodedSpan {
  return {
    traceId: index.toString(16).padStart(32, "a"),
    spanId: index.toString(16).padStart(16, "0"),
    parentSpanId: null,
    name: "chat claude-opus-5-5",
    kind: 3,
    startUnixMs: startMs,
    endUnixMs: startMs + 900,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "claude-opus-5-5",
      "gen_ai.usage.input_tokens": 100,
      // The Beluga exporter's shape: a JSON string of `{ type, name }`.
      ...(tools
        ? {
            "gen_ai.tool.definitions": JSON.stringify(
              tools.map((name) => ({
                type: name.startsWith("mcp__") ? "extension" : "function",
                name,
              })),
            ),
          }
        : {}),
    },
    events: [],
    statusCode: 1,
    resourceAttributes: { "service.name": "beluga" },
    scopeName: "beluga",
  };
}

test("lists the declared tool names of the last 30 days with their latest declaration", async () => {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'), ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  const db = drizzle(client, { schema }) as unknown as TelemetryDeclaredToolsDb &
    NonNullable<Parameters<typeof insertTraceEvents>[2]>;
  const day = 86_400_000;
  await insertTraceEvents(
    PROJECT_ID,
    deriveModelCalls([
      chat(1, NOW.getTime() - 2 * day, ["Bash", "Read", "mcp__beluga_board__task_get"]),
      chat(2, NOW.getTime() - day, ["Bash", "Edit"]),
      // A later request of the same turn carries no definitions.
      chat(3, NOW.getTime() - day + 5_000, null),
      // Too old to count.
      chat(4, NOW.getTime() - 40 * day, ["Retired"]),
    ]),
    db,
  );
  await insertTraceEvents(
    OTHER_PROJECT_ID,
    deriveModelCalls([chat(5, NOW.getTime() - day, ["OtherProjectTool"])]),
    db,
  );

  const tools = await listTelemetryDeclaredTools(PROJECT_ID, { now: NOW }, db);
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.modelCalls, tool.lastDeclaredAt.toISOString()]),
    [
      ["Bash", 2, new Date(NOW.getTime() - day).toISOString()],
      ["Edit", 1, new Date(NOW.getTime() - day).toISOString()],
      ["Read", 1, new Date(NOW.getTime() - 2 * day).toISOString()],
      ["mcp__beluga_board__task_get", 1, new Date(NOW.getTime() - 2 * day).toISOString()],
    ],
  );
  await client.close();
});
