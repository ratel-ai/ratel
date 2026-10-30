import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { replaceCatalogSnapshot } from "@/lib/ingest/catalogs/queries";
import { parseCatalogSnapshot } from "@/lib/ingest/catalogs/snapshot";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadBench, MAX_BENCH_CAPABILITIES } from "./catalog";
import { rankCapabilities } from "./rank";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

test("loadBench returns live skills and observed tools for one project", async () => {
  const { client, db } = await setup();
  await client.exec(`
    insert into skills (project_id, name, description, body, tags, status) values
      ('${PROJECT_ID}', 'published-one', 'A published skill.', 'body', '["git"]', 'published'),
      ('${PROJECT_ID}', 'draft-one', 'A drafted skill.', 'body', '[]', 'draft'),
      ('${PROJECT_ID}', 'archived-one', 'An archived skill.', 'body', '[]', 'archived'),
      ('${OTHER_PROJECT_ID}', 'other-project', 'Not ours.', 'body', '[]', 'published');

    insert into events (id, project_id, received_at) values
      ('40000000-0000-4000-8000-000000000001', '${PROJECT_ID}', '2026-08-01T10:00:00Z'),
      ('40000000-0000-4000-8000-000000000002', '${OTHER_PROJECT_ID}', '2026-08-01T10:00:00Z');

    insert into event_metrics
      (event_id, project_id, event_time, tokens_by_category, splits, tools_by_name,
       input_tokens, cost_usd, categorizer_version)
    values
      (
        '40000000-0000-4000-8000-000000000001', '${PROJECT_ID}', '2026-08-01T10:00:00Z',
        '{}', '{}', '{"ripgrep":{"calls":4,"tokens":40}}', 100, 1.00, 4
      ),
      (
        '40000000-0000-4000-8000-000000000002', '${OTHER_PROJECT_ID}', '2026-08-01T10:00:00Z',
        '{}', '{}', '{"not-ours":{"calls":9,"tokens":90}}', 100, 1.00, 4
      );
  `);

  const bench = await loadBench(PROJECT_ID, db);

  // Drafts are included on purpose: rehearsing a draft's retrievability before
  // publishing it is the main thing the bench is for. Archived ones are not
  // part of any live ranking.
  assert.deepEqual(bench.skills.map((skill) => skill.name).sort(), ["draft-one", "published-one"]);
  const published = bench.skills.find((s) => s.name === "published-one");
  assert.equal(published?.description, "A published skill.");
  assert.deepEqual(published?.tags, ["git"]);
  assert.equal(published?.status, "published");
  assert.ok((published?.version ?? 0) >= 1, "version carries the CAS guard");

  assert.deepEqual(
    bench.tools.map((tool) => ({
      name: tool.name,
      hasDefinition: tool.hasDefinition,
      description: tool.description,
      calls: tool.calls,
    })),
    [{ name: "ripgrep", hasDefinition: false, description: "", calls: 4 }],
  );
  assert.deepEqual(bench.truncated, { skills: false, tools: false });
  await client.close();
});

test("loadBench joins synced tool definitions onto observed usage", async () => {
  // A tool with no description has nothing for a prompt to match, so it can
  // never be retrieved. This is the join that makes tools rankable at all.
  const { client, db } = await setup();
  await client.exec(`
    insert into events (id, project_id, received_at) values
      ('40000000-0000-4000-8000-000000000001', '${PROJECT_ID}', '2026-08-01T10:00:00Z');
    insert into event_metrics
      (event_id, project_id, event_time, tokens_by_category, splits, tools_by_name,
       input_tokens, cost_usd, categorizer_version)
    values
      (
        '40000000-0000-4000-8000-000000000001', '${PROJECT_ID}', '2026-08-01T10:00:00Z',
        '{}', '{}', '{"ripgrep":{"calls":4,"tokens":40},"undescribed":{"calls":2,"tokens":20}}',
        100, 1.00, 4
      );

    insert into tool_definitions (project_id, name, description) values
      ('${PROJECT_ID}', 'ripgrep', 'Search a tree for a regular expression.'),
      ('${PROJECT_ID}', 'never_called', 'Declared but telemetry has not seen it.'),
      ('${OTHER_PROJECT_ID}', 'ripgrep', 'Another project''s definition.');
  `);

  const bench = await loadBench(PROJECT_ID, db);
  const byName = new Map(bench.tools.map((tool) => [tool.name, tool]));

  assert.equal(byName.get("ripgrep")?.description, "Search a tree for a regular expression.");
  assert.equal(byName.get("ripgrep")?.hasDefinition, true);
  assert.equal(byName.get("ripgrep")?.calls, 4);

  // Observed with no definition: the blank is the finding, not a gap to fill.
  assert.equal(byName.get("undescribed")?.description, "");
  assert.equal(byName.get("undescribed")?.hasDefinition, false);

  // Described but never called still belongs on the bench: it is rankable, so
  // it can win a prompt, and "declared but unused" is worth seeing.
  assert.equal(byName.get("never_called")?.hasDefinition, true);
  assert.equal(byName.get("never_called")?.calls, 0);

  assert.equal(bench.tools.length, 3, "another project's definition stays out");
  await client.close();
});

test("loadBench includes tools registered by runtime catalog snapshots", async () => {
  const { client, db } = await setup();
  await replaceCatalogSnapshot(
    PROJECT_ID,
    parseCatalogSnapshot({
      source_id: "runtime-worker",
      tools: [
        {
          id: "calendar.create",
          name: "calendar.create",
          description: "Create a calendar event.",
        },
      ],
    }),
    db,
  );

  assert.deepEqual((await loadBench(PROJECT_ID, db)).tools, []);
  const bench = await loadBench(PROJECT_ID, { includeSyncedTools: true }, db);

  assert.deepEqual(bench.tools, [
    {
      name: "calendar.create",
      description: "Create a calendar event.",
      // The snapshot registered a runtime entry, so the bench carries its key
      // and its retrieval text. Ingest copies the description across, which is
      // why the two are the same string here and no override is set.
      entryId: "calendar.create",
      searchableDescription: "Create a calendar event.",
      searchableDescriptionOverride: null,
      hasDefinition: true,
      calls: 0,
      // Nothing has been observed calling it, so usage is absent rather than
      // a confident zero.
      tokens: 0,
      tokensProvenance: "absent",
      costUsd: 0,
      costProvenance: "absent",
    },
  ]);
  await client.close();
});

/**
 * The end-to-end half of the retrieval-description fix.
 *
 * `rank.test.ts` proves the ranker matches on the right field given the right
 * input. This proves the input actually arrives: `loadBench` has to reach
 * `runtime_catalog_entries` at all, which is the thing it never used to do —
 * the columns existed, the product used them, and the bench simply never read
 * the table.
 */
test("loadBench carries the searchable description and Cloud override through to the ranker", async () => {
  const { client, db } = await setup();
  await client.exec(`
    insert into runtime_catalog_entries
      (project_id, kind, entry_id, name, description, tags,
       searchable_description, searchable_description_overridden,
       searchable_description_override, content_hash)
    values
      (
        '${PROJECT_ID}', 'tool', 'calendar.create', 'calendar_create',
        'Persists an ICS entity to the organizer backend.', '[]',
        'schedule a meeting, book an appointment', false,
        'reserve a conference room', 'hash-1'
      ),
      (
        '${PROJECT_ID}', 'tool', 'ripgrep', 'ripgrep',
        'Search the repository.', '[]',
        'Search the repository.', false, null, 'hash-2'
      );

    insert into skills (project_id, name, description, searchable_description, body, tags, status)
    values (
      '${PROJECT_ID}', 'triage-incident',
      'Executes the runbook associated with a severity declaration.',
      'page the on-call, escalate an outage',
      'body', '[]', 'published'
    );

    -- Observed, so both tools sit on the bench without asking for synced tools:
    -- the retrieval join is a correctness fix and must not depend on that
    -- option.
    insert into events (id, project_id, received_at) values
      ('50000000-0000-4000-8000-000000000001', '${PROJECT_ID}', '2026-08-01T10:00:00Z');
    insert into event_metrics
      (event_id, project_id, event_time, tokens_by_category, splits, tools_by_name,
       input_tokens, cost_usd, categorizer_version)
    values (
      '50000000-0000-4000-8000-000000000001', '${PROJECT_ID}', '2026-08-01T10:00:00Z',
      '{}', '{}', '{"calendar_create":{"calls":3,"tokens":30},"ripgrep":{"calls":1,"tokens":10}}',
      100, 1.00, 4
    );
  `);

  const bench = await loadBench(PROJECT_ID, db);
  const calendar = bench.tools.find((tool) => tool.name === "calendar_create");
  assert.equal(calendar?.entryId, "calendar.create");
  assert.equal(calendar?.searchableDescription, "schedule a meeting, book an appointment");
  assert.equal(calendar?.searchableDescriptionOverride, "reserve a conference room");
  assert.equal(
    calendar?.description,
    "Persists an ICS entity to the organizer backend.",
    "the agent description is untouched by either retrieval field",
  );

  const skill = bench.skills.find((s) => s.name === "triage-incident");
  assert.equal(skill?.searchableDescription, "page the on-call, escalate an outage");

  // Observed usage still lands on the same row: the join adds the retrieval
  // fields, it does not replace what the catalog builder already knew.
  assert.equal(calendar?.calls, 3);
  assert.equal(calendar?.tokens, 30);
  assert.equal(calendar?.tokensProvenance, "otel");

  // And the whole point: ranked against the same catalog the reader sees, the
  // override is what a prompt matches.
  const rankOptions = {
    mode: "bm25" as const,
    topKSkills: 5,
    topKTools: 5,
    embeddingWeight: 0.5,
  };
  const empty = { editedSkillIds: new Set<string>(), editedToolIds: new Set<string>() };
  const matched = rankCapabilities({
    query: "reserve a room",
    skills: bench.skills,
    tools: bench.tools,
    options: rankOptions,
    ...empty,
  });
  assert.deepEqual(
    matched.tools.map((hit) => hit.id),
    ["calendar_create"],
  );
  assert.equal(
    matched.tools[0].description,
    "Persists an ICS entity to the organizer backend.",
    "the payload still hands the agent its own description",
  );
  assert.deepEqual(
    rankCapabilities({
      query: "organizer backend ICS",
      skills: bench.skills,
      tools: bench.tools,
      options: rankOptions,
      ...empty,
    }).tools,
    [],
    "the agent description is never what a prompt is matched against",
  );

  assert.deepEqual(
    rankCapabilities({
      query: "escalate an outage",
      skills: bench.skills,
      tools: bench.tools,
      options: rankOptions,
      ...empty,
    }).skills.map((hit) => hit.id),
    ["triage-incident"],
  );

  await client.close();
});

test("loadBench reports truncation once a bucket passes its cap", async () => {
  const { client, db } = await setup();
  const rows = Array.from(
    { length: MAX_BENCH_CAPABILITIES + 5 },
    (_, i) =>
      `('${PROJECT_ID}', 'skill-${String(i).padStart(3, "0")}', 'Description ${i}.', 'body', '[]', 'published')`,
  ).join(",\n");
  await client.exec(`
    insert into skills (project_id, name, description, body, tags, status) values
    ${rows};
  `);

  const bench = await loadBench(PROJECT_ID, db);
  assert.equal(bench.skills.length, MAX_BENCH_CAPABILITIES);
  assert.equal(bench.truncated.skills, true);
  assert.equal(bench.truncated.tools, false);
  await client.close();
});

test("loadBench on an empty project is empty, not an error", async () => {
  const { client, db } = await setup();
  const bench = await loadBench(PROJECT_ID, db);
  assert.deepEqual(bench.skills, []);
  assert.deepEqual(bench.tools, []);
  assert.deepEqual(bench.truncated, { skills: false, tools: false });
  await client.close();
});

async function setup(): Promise<{
  client: PGlite;
  db: Parameters<typeof loadBench>[1];
}> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug)
    values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  return {
    client,
    db: drizzle(client, { schema }) as unknown as Parameters<typeof loadBench>[1],
  };
}
