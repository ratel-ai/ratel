import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadToolSteps } from "@/lib/views/intents/map/queries";
import { mapSeams } from "@/lib/views/intents/map/seams";
import { loadExplorerToolSteps } from "@/lib/views/intents/map/tool-steps";

/**
 * The Map's "came next" arrows come from the tool explorer's latest completed run: its
 * turn-scope `next` edges between tools, as `queries.ts` reads them through the seam
 * `tool-steps.ts` fills.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const OLDER_RUN_ID = "44444444-4444-4444-8444-444444444445";

interface Edge {
  scope: "turn" | "session";
  kind: "next" | "before";
  subject?: "tool" | "intent";
  a: string;
  b: string;
  n: number;
  nA: number;
}

async function setup(): Promise<{ client: PGlite; db: BoundReadDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as BoundReadDb };
}

async function seedRun(
  client: PGlite,
  runId: string,
  status: "completed" | "running",
  edges: readonly Edge[],
  createdAt = "2026-09-02T00:00:00Z",
): Promise<void> {
  await client.query(
    `insert into tool_explorer_runs (id, project_id, trigger, status, window_days, window_start, window_end, created_at)
     values ($1, $2, 'manual', $3, 30, $4::timestamptz - interval '30 days', $4::timestamptz, $4::timestamptz)`,
    [runId, PROJECT_ID, status, createdAt],
  );
  for (const edge of edges) {
    await client.query(
      `insert into tool_explorer_edges (run_id, project_id, scope, kind, subject, a, b, n, n_a, p, p_low, p_high, lift)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10, 1)`,
      [
        runId,
        PROJECT_ID,
        edge.scope,
        edge.kind,
        edge.subject ?? "tool",
        edge.a,
        edge.b,
        edge.n,
        edge.nA,
        edge.n / edge.nA,
      ],
    );
  }
}

const KEEP = new Set([
  "tool:find_task",
  "tool:assign_task",
  "tool:lookup",
  "tool:report",
  "skill:review",
]);

test("loading the map queries fills the tool-step seam with the explorer's reader", () => {
  assert.equal(mapSeams.loadToolSteps, loadExplorerToolSteps);
});

test("the Map receives the latest completed run's turn-scope next edges between the tools it keeps", async () => {
  const { client, db } = await setup();
  // An older completed run whose rows the explorer would have deleted; here it stays to
  // show that only the latest completed run is read.
  await seedRun(
    client,
    OLDER_RUN_ID,
    "completed",
    [{ scope: "turn", kind: "next", a: "lookup", b: "report", n: 12, nA: 12 }],
    "2026-09-01T00:00:00Z",
  );
  await seedRun(client, RUN_ID, "completed", [
    // The arrow the Tools lens draws.
    { scope: "turn", kind: "next", a: "find_task", b: "assign_task", n: 40, nA: 40 },
    // A skill: its explorer id is already a capability key.
    { scope: "turn", kind: "next", a: "assign_task", b: "skill:review", n: 3, nA: 40 },
    // Below MIN_STEPS: never read.
    { scope: "turn", kind: "next", a: "lookup", b: "report", n: 1, nA: 30 },
    // Not on the map: dropped.
    { scope: "turn", kind: "next", a: "find_task", b: "search_tasks", n: 9, nA: 40 },
    // Session scope and `before` edges are other readings.
    { scope: "session", kind: "next", a: "lookup", b: "report", n: 30, nA: 30 },
    { scope: "turn", kind: "before", a: "lookup", b: "report", n: 30, nA: 30 },
    // Intents are not tools.
    { scope: "turn", kind: "next", subject: "intent", a: "find_task", b: "lookup", n: 7, nA: 7 },
  ]);

  const steps = await loadToolSteps({ projectId: PROJECT_ID, keep: KEEP }, db);
  assert.deepEqual(steps, [
    { from: "tool:find_task", to: "tool:assign_task", n: 40, of: 40 },
    { from: "tool:assign_task", to: "skill:review", n: 3, of: 40 },
  ]);
});

test("no completed run yields no steps: a project without a reading, or with a run still running", async () => {
  const { client, db } = await setup();
  assert.deepEqual(await loadToolSteps({ projectId: PROJECT_ID, keep: KEEP }, db), []);

  await seedRun(client, RUN_ID, "running", [
    { scope: "turn", kind: "next", a: "find_task", b: "assign_task", n: 40, nA: 40 },
  ]);
  assert.deepEqual(
    await loadToolSteps({ projectId: PROJECT_ID, keep: KEEP }, db),
    [],
    "a live run is not read until it completes",
  );
});

test("a completed run with no edges yields no steps", async () => {
  const { client, db } = await setup();
  await seedRun(client, RUN_ID, "completed", []);
  assert.deepEqual(await loadToolSteps({ projectId: PROJECT_ID, keep: KEEP }, db), []);
});
