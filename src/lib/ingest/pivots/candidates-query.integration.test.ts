import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { rankCandidates } from "./candidates";
import { sampleRootSpans } from "./candidates-query";

/** RC-882: the candidate sample reads only recent root spans of the project, with a hard limit. */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "11111111-1111-4111-8111-111111111112";
const NOW = new Date("2026-11-17T12:00:00Z");
const HOUR = 60 * 60 * 1000;

type Db = ReturnType<typeof getDb>;

let next = 0;
async function span(
  client: PGlite,
  input: {
    project?: string;
    trace: string;
    parent?: string | null;
    startedAt: Date;
    attributes: Record<string, unknown>;
  },
): Promise<void> {
  next += 1;
  await client.query(
    `insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, attributes)
     values ($1, $2, $3, $4, $5, 'run', 1, 'other', $6, $6, 1, 0, $7)`,
    [
      `c0000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
      input.project ?? PROJECT,
      input.trace,
      `s${next}`,
      input.parent ?? null,
      input.startedAt.toISOString(),
      JSON.stringify(input.attributes),
    ],
  );
}

async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a'), ('${OTHER}', '${ORG}', 'B', 'b');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

test("seeded root spans give ranked candidates; child spans, old spans and other projects are not read", async () => {
  const { client, db } = await setup();
  for (let index = 0; index < 12; index += 1) {
    const trace = `t${index}`;
    await span(client, {
      trace,
      startedAt: new Date(NOW.getTime() - index * HOUR),
      attributes: { "tenant.id": `org-${index % 3}`, "request.id": trace },
    });
    await span(client, {
      trace,
      parent: "x",
      startedAt: NOW,
      attributes: { "child.only": index % 2 ? "a" : "b" },
    });
  }
  await span(client, {
    trace: "old1",
    startedAt: new Date(NOW.getTime() - 30 * 24 * HOUR),
    attributes: { "old.key": "a" },
  });
  await span(client, {
    trace: "old2",
    startedAt: new Date(NOW.getTime() - 30 * 24 * HOUR),
    attributes: { "old.key": "b" },
  });
  await span(client, {
    project: OTHER,
    trace: "o1",
    startedAt: NOW,
    attributes: { "other.key": "a" },
  });
  await span(client, {
    project: OTHER,
    trace: "o2",
    startedAt: NOW,
    attributes: { "other.key": "b" },
  });

  const sample = await sampleRootSpans(PROJECT, db, { now: NOW });
  assert.equal(sample.length, 12);
  assert.deepEqual(rankCandidates(sample), [
    { key: "tenant.id", coverage: 1, traces: 12, distinct: 3, presetId: "client" },
  ]);
});

test("the sample keeps the most recent rows up to its limit", async () => {
  const { client, db } = await setup();
  for (let index = 0; index < 6; index += 1) {
    await span(client, {
      trace: `t${index}`,
      startedAt: new Date(NOW.getTime() - index * HOUR),
      attributes: {},
    });
  }
  const sample = await sampleRootSpans(PROJECT, db, { now: NOW, limit: 4 });
  assert.deepEqual(
    sample.map((row) => row.traceId),
    ["t0", "t1", "t2", "t3"],
  );
  assert.equal((await sampleRootSpans(PROJECT, db, { now: NOW, limit: 100_000 })).length, 6);
});
