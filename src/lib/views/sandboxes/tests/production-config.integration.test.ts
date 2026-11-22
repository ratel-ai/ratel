import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { SandboxDb } from "../adapters/pg-store";
import { readProductionConfigHash } from "../adapters/production-config";

/**
 * The production config hash of a sandbox against real PGlite: the newest
 * production root span of the project in the last 30 days that carries the
 * sandbox's stamps. Playground roots, other projects, other sandboxes and old spans
 * do not count.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJ = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-11-20T12:00:00Z");

async function setup(): Promise<{ client: PGlite; db: SandboxDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJ}', '${ORG}', 'A', 'a'), ('${OTHER_PROJ}', '${ORG}', 'B', 'b');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as SandboxDb };
}

async function span(
  client: PGlite,
  options: {
    project?: string;
    startedAt: string;
    attributes: Record<string, unknown>;
    parent?: string | null;
  },
): Promise<void> {
  await client.query(
    `insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, attributes)
     values ($1, $2, $3, $4, $5, 'invoke_agent label_workflows', 1, 'agent', $6, $6, 1, 0, $7)`,
    [
      randomUUID(),
      options.project ?? PROJ,
      randomUUID().replaceAll("-", ""),
      randomUUID().slice(0, 16),
      options.parent ?? null,
      options.startedAt,
      JSON.stringify(options.attributes),
    ],
  );
}

const stamps = (hash: string, sandbox = "workflow-label") => ({
  "ratel.sandbox.id": sandbox,
  "ratel.sandbox.config_hash": hash,
});

test("the newest production root of the sandbox gives the hash", async () => {
  const { client, db } = await setup();
  await span(client, { startedAt: "2026-11-18T10:00:00Z", attributes: stamps("old") });
  await span(client, { startedAt: "2026-11-19T10:00:00Z", attributes: stamps("new") });
  await span(client, {
    startedAt: "2026-11-20T10:00:00Z",
    attributes: { ...stamps("play"), "deployment.environment.name": "playground" },
  });
  await span(client, {
    startedAt: "2026-11-20T11:00:00Z",
    attributes: stamps("other-sandbox", "topic-place"),
  });
  await span(client, {
    project: OTHER_PROJ,
    startedAt: "2026-11-20T11:00:00Z",
    attributes: stamps("other-project"),
  });

  assert.equal(
    await readProductionConfigHash(db, { projectId: PROJ, sandboxId: "workflow-label", now: NOW }),
    "new",
  );
});

test("a production environment other than playground counts", async () => {
  const { client, db } = await setup();
  await span(client, {
    startedAt: "2026-11-19T10:00:00Z",
    attributes: { ...stamps("prod"), "deployment.environment.name": "production" },
  });

  assert.equal(
    await readProductionConfigHash(db, { projectId: PROJ, sandboxId: "workflow-label", now: NOW }),
    "prod",
  );
});

test("no stamped root in the last 30 days gives null", async () => {
  const { client, db } = await setup();
  await span(client, { startedAt: "2026-10-01T10:00:00Z", attributes: stamps("too-old") });
  await span(client, {
    startedAt: "2026-11-19T10:00:00Z",
    attributes: { "ratel.sandbox.id": "workflow-label" },
  });

  assert.equal(
    await readProductionConfigHash(db, { projectId: PROJ, sandboxId: "workflow-label", now: NOW }),
    null,
  );
});
