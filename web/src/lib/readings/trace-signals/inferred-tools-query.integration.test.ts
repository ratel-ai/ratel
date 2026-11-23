import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadInferredToolShare,
  toolCallsInferred,
} from "@/lib/readings/trace-signals/inferred-tools-query";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";

/**
 * The share of a window's tool calls inferred from span shape (`ratel.tool.inferred`), which
 * the Ready page reads to say what an import could not record. New here: upstream proves the
 * query inside its importer's end-to-end test, which lives with the importer (ratel-platform).
 */

const NOW = new Date("2026-11-12T12:00:00.000Z");
const RECENT = "2026-11-10T09:00:00.000Z";
const OLD = "2026-10-01T09:00:00.000Z";

let seq = 0;
function span(options: { operation: string; inferred?: boolean; at?: string }): string {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  const at = options.at ?? RECENT;
  const attributes = options.inferred ? `'{"ratel.tool.inferred": true}'` : `'{}'`;
  return `('${id}', '${PROJECT_ID}', 't${seq}', 's${seq}', 'step ${seq}', 1, 'tool', '${at}', '${at}',
    10, 1, '${options.operation}', ${attributes}::jsonb)`;
}

async function seed(rows: readonly string[]) {
  const { client, db } = await setupDb();
  await client.exec(`
    insert into otel_spans (id, project_id, trace_id, span_id, name, kind, span_class, started_at,
      ended_at, duration_ms, status_code, operation_name, attributes)
    values ${rows.join(",\n")}`);
  return { client, db };
}

test("counts the window's tool spans and those marked inferred, nothing older or of another kind", async () => {
  const { client, db } = await seed([
    span({ operation: "execute_tool", inferred: true }),
    span({ operation: "execute_tool", inferred: true }),
    span({ operation: "execute_tool" }),
    span({ operation: "chat" }),
    span({ operation: "execute_tool", inferred: true, at: OLD }),
  ]);
  try {
    const share = await loadInferredToolShare(PROJECT_ID, { now: NOW, windowDays: 7 }, db);
    assert.deepEqual(share, { toolSpans: 3, inferred: 2 });
    assert.equal(toolCallsInferred(share), true);
  } finally {
    await client.close();
  }
});

test("tool calls are inferred only when at least half of them are, and some are", () => {
  assert.equal(toolCallsInferred(null), false);
  assert.equal(toolCallsInferred({ toolSpans: 0, inferred: 0 }), false);
  assert.equal(toolCallsInferred({ toolSpans: 4, inferred: 1 }), false);
  assert.equal(toolCallsInferred({ toolSpans: 4, inferred: 2 }), true);
});
