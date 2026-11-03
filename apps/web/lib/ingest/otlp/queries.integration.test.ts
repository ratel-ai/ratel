import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { getDailyAggregates, getToolMetrics, hasProjectIngestedEvents } from "./queries";

/**
 * The event reads behind the project overview and the cost tools, against the real
 * migrations in PGlite: event presence, the per-day metric sums and the per-tool maps.
 */
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

type Db = ReturnType<typeof drizzle<typeof schema>>;

async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG_ID}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug) values
       ('${PROJECT_ID}', '${ORG_ID}', 'P', 'p'),
       ('${OTHER_PROJECT_ID}', '${ORG_ID}', 'O', 'o');`,
  );
  return { client, db: drizzle(client, { schema }) };
}

let sequence = 0;
function uuid(): string {
  sequence += 1;
  return `00000000-0000-8000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

type RunMetric = {
  spend?: Partial<Record<"skills" | "tools" | "history" | "memory" | "user_input", number>>;
  splits?: Partial<
    Record<"history_cached" | "history_uncached" | "tools_used" | "tools_unused", number>
  >;
  toolsByName?: Record<string, { calls: number; tokens: number }>;
  outputTokens?: number;
  latencyMs?: number;
  costUsd?: number;
};

/** One stored run: an `events` row and its derived `event_metrics` row at `eventTime`. */
async function storeRun(
  client: PGlite,
  projectId: string,
  eventTime: string,
  metric: RunMetric = {},
): Promise<void> {
  const eventId = uuid();
  const spend = { skills: 0, tools: 0, history: 0, memory: 0, user_input: 0, ...metric.spend };
  const splits = {
    history_cached: 0,
    history_uncached: 0,
    tools_used: 0,
    tools_unused: 0,
    ...metric.splits,
  };
  await client.query(
    `insert into events (id, project_id, received_at, occurred_at) values ($1, $2, $3, $3)`,
    [eventId, projectId, eventTime],
  );
  await client.query(
    `insert into event_metrics
       (event_id, project_id, event_time, tokens_by_category, splits, tools_by_name,
        output_tokens, latency_ms, cost_usd, categorizer_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)`,
    [
      eventId,
      projectId,
      eventTime,
      JSON.stringify(spend),
      JSON.stringify(splits),
      JSON.stringify(metric.toolsByName ?? {}),
      metric.outputTokens ?? 0,
      metric.latencyMs ?? 0,
      metric.costUsd ?? 0,
    ],
  );
}

test("a project has ingested events once one row is stored, and another project's rows do not count", async () => {
  const { client, db } = await setup();

  assert.equal(await hasProjectIngestedEvents(PROJECT_ID, db), false);

  await client.exec(`
    insert into events (project_id, received_at, occurred_at)
    values ('${OTHER_PROJECT_ID}', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
  `);
  assert.equal(await hasProjectIngestedEvents(PROJECT_ID, db), false);

  await client.exec(`
    insert into events (project_id, received_at, occurred_at)
    values ('${PROJECT_ID}', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
  `);
  assert.equal(await hasProjectIngestedEvents(PROJECT_ID, db), true);
});

test("daily aggregates sum each source and split per UTC day inside [since, until)", async () => {
  const { client, db } = await setup();
  await storeRun(client, PROJECT_ID, "2026-07-01T10:00:00Z", {
    spend: { skills: 10, tools: 20, history: 30 },
    splits: { history_cached: 5, tools_used: 7 },
    outputTokens: 100,
    latencyMs: 800,
    costUsd: 0.5,
  });
  await storeRun(client, PROJECT_ID, "2026-07-01T23:30:00Z", {
    spend: { skills: 1, memory: 4, user_input: 6 },
    splits: { history_uncached: 2, tools_unused: 3 },
    outputTokens: 50,
    latencyMs: 200,
    costUsd: 0.25,
  });
  await storeRun(client, PROJECT_ID, "2026-07-02T00:00:00Z", { spend: { tools: 9 } });
  // Outside the window and in another project: never summed.
  await storeRun(client, PROJECT_ID, "2026-07-03T00:00:00Z", { spend: { tools: 999 } });
  await storeRun(client, PROJECT_ID, "2026-06-30T23:59:59Z", { spend: { tools: 999 } });
  await storeRun(client, OTHER_PROJECT_ID, "2026-07-01T12:00:00Z", { spend: { tools: 999 } });

  const rows = await getDailyAggregates(
    PROJECT_ID,
    new Date("2026-07-01T00:00:00Z"),
    new Date("2026-07-03T00:00:00Z"),
    db,
  );

  assert.deepEqual(rows, [
    {
      day: "2026-07-01",
      spend: { skills: 11, tools: 20, history: 30, memory: 4, user_input: 6 },
      splits: { history_cached: 5, history_uncached: 2, tools_used: 7, tools_unused: 3 },
      outputTokens: 150,
      latencyMs: 1000,
      costUsd: 0.75,
      runs: 2,
    },
    {
      day: "2026-07-02",
      spend: { skills: 0, tools: 9, history: 0, memory: 0, user_input: 0 },
      splits: { history_cached: 0, history_uncached: 0, tools_used: 0, tools_unused: 0 },
      outputTokens: 0,
      latencyMs: 0,
      costUsd: 0,
      runs: 1,
    },
  ]);
});

test("without an upper bound the daily aggregates run to the newest event", async () => {
  const { client, db } = await setup();
  await storeRun(client, PROJECT_ID, "2026-07-01T10:00:00Z");
  await storeRun(client, PROJECT_ID, "2026-07-09T10:00:00Z");

  const rows = await getDailyAggregates(
    PROJECT_ID,
    new Date("2026-07-05T00:00:00Z"),
    undefined,
    db,
  );

  assert.deepEqual(
    rows.map((row) => row.day),
    ["2026-07-09"],
  );
});

test("tool metrics return every run's per-tool footprint inside the window", async () => {
  const { client, db } = await setup();
  await storeRun(client, PROJECT_ID, "2026-07-01T10:00:00Z", {
    toolsByName: { "git.push": { calls: 2, tokens: 40 } },
  });
  await storeRun(client, PROJECT_ID, "2026-07-02T10:00:00Z", {
    toolsByName: { "git.push": { calls: 1, tokens: 20 }, "npm.install": { calls: 1, tokens: 8 } },
  });
  await storeRun(client, PROJECT_ID, "2026-07-04T10:00:00Z", {
    toolsByName: { "old.tool": { calls: 1, tokens: 1 } },
  });
  await storeRun(client, OTHER_PROJECT_ID, "2026-07-01T10:00:00Z", {
    toolsByName: { "other.tool": { calls: 1, tokens: 1 } },
  });

  const rows = await getToolMetrics(
    PROJECT_ID,
    new Date("2026-07-01T00:00:00Z"),
    new Date("2026-07-03T00:00:00Z"),
    db,
  );

  assert.deepEqual(
    rows.sort((a, b) => Object.keys(a).length - Object.keys(b).length),
    [
      { "git.push": { calls: 2, tokens: 40 } },
      { "git.push": { calls: 1, tokens: 20 }, "npm.install": { calls: 1, tokens: 8 } },
    ],
  );
});
