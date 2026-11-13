import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { getRuntimeToolCatalogEntries } from "./queries";

/**
 * The tool list the readings take their vocabulary from, against an in-process Postgres:
 * managed definitions plus names seen only in retained trace metrics, the newest definition
 * under a shared name, and no gateway tools. The first case is upstream's
 * `catalogs/queries.integration.test.ts` case for this read; the rest cover the branches the
 * engine's integration tests never reach because they seed no `event_metrics`.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

type Db = Parameters<typeof getRuntimeToolCatalogEntries>[1];

async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

/** One runtime tool definition row; `seenAt` is its `last_seen_at`. */
function definition(
  entryId: string,
  name: string,
  seenAt: string,
  provenance = "snapshot",
): string {
  return `('${PROJECT_ID}', 'tool', '${entryId}', '${name}', 'Managed ${name}', '[]',
       'managed ${name}', false, false, '${provenance}', 'hash-${entryId}', '${seenAt}')`;
}

const DEFINITION_COLUMNS = `(project_id, kind, entry_id, name, description, tags,
       searchable_description, searchable_description_overridden,
       use_cloud_definitions, provenance, content_hash, last_seen_at)`;

/** One categorized trace event whose metrics name the given tools. */
function metrics(eventId: string, at: string, toolsByName: Record<string, unknown>): string {
  return `
    insert into events (id, project_id, received_at) values ('${eventId}', '${PROJECT_ID}', '${at}');
    insert into event_metrics
      (event_id, project_id, event_time, tokens_by_category, splits, tools_by_name, categorizer_version)
    values ('${eventId}', '${PROJECT_ID}', '${at}', '{}', '{}', '${JSON.stringify(toolsByName)}', 4);
  `;
}

const summary = (entries: Awaited<ReturnType<typeof getRuntimeToolCatalogEntries>>) =>
  entries.map((entry) => ({
    entryId: entry.entryId,
    name: entry.name,
    provenance: entry.provenance,
    lastSeenAt: entry.lastSeenAt.toISOString(),
  }));

test("runtime catalog entries derive observed-only tools without definition rows", async () => {
  const { client, db } = await setup();
  await client.exec(`
    insert into runtime_catalog_entries ${DEFINITION_COLUMNS} values
      ${definition("managed", "managed", "2026-08-18T12:00:00Z")};
    ${metrics("40000000-0000-4000-8000-000000000021", "2026-08-18T13:00:00Z", {
      managed: { calls: 1, tokens: 5 },
      observed: { calls: 1, tokens: 3 },
    })}
  `);

  const entries = await getRuntimeToolCatalogEntries(PROJECT_ID, db);
  assert.deepEqual(summary(entries), [
    {
      entryId: "managed",
      name: "managed",
      provenance: "snapshot",
      lastSeenAt: "2026-08-18T12:00:00.000Z",
    },
    {
      entryId: null,
      name: "observed",
      provenance: "observed",
      lastSeenAt: "2026-08-18T13:00:00.000Z",
    },
  ]);
  // A definition carries its synced fields; an observed name has none.
  const managed = entries[0];
  assert.ok(managed && managed.entryId !== null);
  assert.equal(managed.description, "Managed managed");
  assert.equal(managed.searchableDescription, "managed managed");
  assert.deepEqual(managed.tags, []);
  await client.close();
});

test("the newest definition wins under a shared name, and a name is observed only once", async () => {
  const { client, db } = await setup();
  await client.exec(`
    insert into runtime_catalog_entries ${DEFINITION_COLUMNS} values
      ${definition("send_email@1", "send_email", "2026-08-18T11:00:00Z", "events")},
      ${definition("send_email@2", "send_email", "2026-08-18T12:00:00Z", "both")};
    ${metrics("40000000-0000-4000-8000-000000000031", "2026-08-18T13:00:00Z", {
      send_email: { calls: 2, tokens: 9 },
    })}
    ${metrics("40000000-0000-4000-8000-000000000032", "2026-08-18T14:00:00Z", {
      send_email: { calls: 1, tokens: 4 },
      docker_build: { calls: 1, tokens: 2 },
    })}
  `);

  assert.deepEqual(summary(await getRuntimeToolCatalogEntries(PROJECT_ID, db)), [
    {
      entryId: null,
      name: "docker_build",
      provenance: "observed",
      lastSeenAt: "2026-08-18T14:00:00.000Z",
    },
    {
      entryId: "send_email@2",
      name: "send_email",
      provenance: "both",
      lastSeenAt: "2026-08-18T12:00:00.000Z",
    },
  ]);
  await client.close();
});

test("gateway tools are left out, defined or only observed; other projects never leak in", async () => {
  const { client, db } = await setup();
  await client.exec(`
    insert into organizations (id, name, slug) values ('33333333-3333-4333-8333-333333333333', 'Other', 'other');
    insert into projects (id, organization_id, name, slug)
    values ('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', 'Other', 'other');
    insert into runtime_catalog_entries ${DEFINITION_COLUMNS} values
      ${definition("search_capabilities", "search_capabilities", "2026-08-18T12:00:00Z")},
      ${definition("gh_run_list", "gh_run_list", "2026-08-18T12:00:00Z")},
      ('44444444-4444-4444-8444-444444444444', 'tool', 'theirs', 'theirs', 'Managed theirs', '[]',
       'managed theirs', false, false, 'snapshot', 'hash-theirs', '2026-08-18T12:00:00Z');
    ${metrics("40000000-0000-4000-8000-000000000041", "2026-08-18T13:00:00Z", {
      invoke_tool: { calls: 3, tokens: 7 },
      gh_run_list: { calls: 1, tokens: 1 },
    })}
  `);

  assert.deepEqual(
    (await getRuntimeToolCatalogEntries(PROJECT_ID, db)).map((entry) => entry.name),
    ["gh_run_list"],
  );
  await client.close();
});
