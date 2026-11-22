import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { getProjectHomeEntityCounts } from "./queries";

/**
 * The home recap's counts against the real migrations in PGlite: every skill of the
 * project, and the experiments with a named arm inside the window.
 */
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

async function setup(): Promise<{ client: PGlite; db: ReturnType<typeof drizzle<typeof schema>> }> {
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
async function storeSpan(
  client: PGlite,
  projectId: string,
  startedAt: string,
  experiment: { name: string | null; arm: string | null },
): Promise<void> {
  sequence += 1;
  await client.query(
    `insert into otel_spans
       (id, project_id, trace_id, span_id, name, kind, span_class, started_at, ended_at,
        duration_ms, status_code, experiment_name, experiment_arm, experiment_attrs, attributes)
     values ($1, $2, $3, $4, 'agent.run', 1, 'other', $5, $5, 0, 1, $6, $7, '{}', '{}')`,
    [
      `00000000-0000-8000-8000-${sequence.toString(16).padStart(12, "0")}`,
      projectId,
      "0123456789abcdef0123456789abcdef",
      sequence.toString(16).padStart(16, "0"),
      startedAt,
      experiment.name,
      experiment.arm,
    ],
  );
}

test("counts the project's skills of every status and its experiments with an arm in the window", async () => {
  const { client, db } = await setup();
  await client.exec(`
    insert into skills (project_id, name, status) values
      ('${PROJECT_ID}', 'draft-skill', 'draft'),
      ('${PROJECT_ID}', 'live-skill', 'published'),
      ('${PROJECT_ID}', 'old-skill', 'archived'),
      ('${OTHER_PROJECT_ID}', 'their-skill', 'published');
  `);
  // Two arms of one experiment count once; a second experiment counts too.
  await storeSpan(client, PROJECT_ID, "2026-07-02T10:00:00Z", { name: "rerank", arm: "control" });
  await storeSpan(client, PROJECT_ID, "2026-07-02T11:00:00Z", { name: "rerank", arm: "shadow" });
  await storeSpan(client, PROJECT_ID, "2026-07-03T10:00:00Z", { name: "bm25-k", arm: "k10" });
  // No arm, a blank arm, outside the window, another project: none count.
  await storeSpan(client, PROJECT_ID, "2026-07-02T12:00:00Z", { name: "no-arm", arm: null });
  await storeSpan(client, PROJECT_ID, "2026-07-02T12:00:00Z", { name: "blank-arm", arm: " " });
  await storeSpan(client, PROJECT_ID, "2026-06-30T23:59:59Z", { name: "before", arm: "a" });
  await storeSpan(client, PROJECT_ID, "2026-07-08T00:00:00Z", { name: "after", arm: "a" });
  await storeSpan(client, OTHER_PROJECT_ID, "2026-07-02T10:00:00Z", { name: "theirs", arm: "a" });

  const counts = await getProjectHomeEntityCounts(
    PROJECT_ID,
    new Date("2026-07-01T00:00:00Z"),
    new Date("2026-07-08T00:00:00Z"),
    db,
  );

  assert.deepEqual(counts, { skills: 3, activeExperiments: 2 });
});

test("an empty project counts nothing", async () => {
  const { db } = await setup();

  assert.deepEqual(
    await getProjectHomeEntityCounts(
      PROJECT_ID,
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-08T00:00:00Z"),
      db,
    ),
    { skills: 0, activeExperiments: 0 },
  );
});
