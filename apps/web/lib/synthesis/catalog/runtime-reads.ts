import { and, asc, desc, eq, sql } from "drizzle-orm";
import { skills } from "@/lib/catalog/schema";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";
import type { RuntimeCatalogEntry, RuntimeToolDefinition } from "@/lib/synthesis/dashboard";

/** The runtime-catalog and adoption reads the Catalog pages load (owned fragment of the upstream queries hub, ADR-0030). */

/** Newest runtime definition for each tool name, ready to join onto usage. */
export async function getRuntimeToolDefinitions(
  projectId: string,
  db: Pick<ReturnType<typeof getDb>, "select"> = getDb(),
): Promise<RuntimeToolDefinition[]> {
  const rows = await db
    .select({
      entryId: runtimeCatalogEntries.entryId,
      name: runtimeCatalogEntries.name,
      description: runtimeCatalogEntries.description,
      tags: runtimeCatalogEntries.tags,
      inputSchema: runtimeCatalogEntries.inputSchema,
      outputSchema: runtimeCatalogEntries.outputSchema,
      searchableDescription: runtimeCatalogEntries.searchableDescription,
      searchableDescriptionOverridden: runtimeCatalogEntries.searchableDescriptionOverridden,
      useCloudDefinitions: runtimeCatalogEntries.useCloudDefinitions,
      provenance: runtimeCatalogEntries.provenance,
      searchableDescriptionOverride: runtimeCatalogEntries.searchableDescriptionOverride,
      lastSeenAt: runtimeCatalogEntries.lastSeenAt,
    })
    .from(runtimeCatalogEntries)
    .where(
      and(eq(runtimeCatalogEntries.projectId, projectId), eq(runtimeCatalogEntries.kind, "tool")),
    )
    .orderBy(
      asc(runtimeCatalogEntries.name),
      desc(runtimeCatalogEntries.lastSeenAt),
      asc(runtimeCatalogEntries.entryId),
    );

  const newestByName = new Map<string, RuntimeToolDefinition>();
  for (const row of rows) {
    if (!newestByName.has(row.name)) {
      newestByName.set(row.name, { ...row, provenance: runtimeCatalogProvenance(row.provenance) });
    }
  }
  return [...newestByName.values()];
}

/** Runtime-registered skills without a matching authored row, plus observed-only ids. */
export async function getRuntimeSkillCatalogEntries(
  projectId: string,
  db: Pick<ReturnType<typeof getDb>, "execute"> = getDb(),
): Promise<RuntimeCatalogEntry[]> {
  const result = await db.execute(sql`
    with definitions as (
      select
        entry_id,
        name,
        description,
        tags,
        input_schema,
        output_schema,
        searchable_description,
        searchable_description_overridden,
        use_cloud_definitions,
        searchable_description_override,
        provenance,
        last_seen_at,
        row_number() over (
          partition by name
          order by last_seen_at desc, entry_id asc
        ) as position
      from ${runtimeCatalogEntries}
      where project_id = ${projectId} and kind = 'skill'
    ),
    observed as (
      select
        skill_id as name,
        max(coalesce(occurred_at, received_at)) as last_seen_at
      from ${traceEvents}
      where project_id = ${projectId} and skill_id is not null
      group by skill_id
    )
    select
      entry_id,
      definitions.name,
      description,
      tags,
      input_schema,
      output_schema,
      searchable_description,
      searchable_description_overridden,
      use_cloud_definitions,
      searchable_description_override,
      provenance,
      last_seen_at
    from definitions
    where position = 1
      and not exists (
        select 1 from ${skills}
        where ${skills.projectId} = ${projectId}
          and (${skills.name} = definitions.name or ${skills.id}::text = definitions.entry_id)
      )
    union all
    select
      null::text as entry_id,
      observed.name,
      null::text as description,
      null::jsonb as tags,
      null::jsonb as input_schema,
      null::jsonb as output_schema,
      null::text as searchable_description,
      null::boolean as searchable_description_overridden,
      null::boolean as use_cloud_definitions,
      null::text as searchable_description_override,
      'observed'::text as provenance,
      observed.last_seen_at
    from observed
    where not exists (
      select 1 from definitions
      where definitions.name = observed.name or definitions.entry_id = observed.name
    )
      and not exists (
        select 1 from ${skills}
        where ${skills.projectId} = ${projectId}
          and (${skills.name} = observed.name or ${skills.id}::text = observed.name)
      )
    order by name asc
  `);
  return result.rows.map(toRuntimeCatalogEntry);
}

/**
 * How recent an override pull has to be before a runtime counts as listening. Runtimes poll
 * every minute and reconcile every five, so an hour survives a quiet period without claiming
 * adoption for a runtime that stopped days ago.
 */
export const OVERRIDE_PULL_FRESH_MS = 60 * 60 * 1000;

/**
 * Evidence that a runtime consumes this project's overrides: a recent pull. `true` or `null`,
 * never `false`: silence is not a refusal, and the notice copy depends on that.
 */
export async function getRuntimeCatalogOverrideAdoption(
  projectId: string,
  db: Pick<ReturnType<typeof getDb>, "select"> = getDb(),
  now: Date = new Date(),
): Promise<boolean | null> {
  const [row] = await db
    .select({ pulledAt: projects.overridesPulledAt })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!row?.pulledAt) return null;
  return now.getTime() - row.pulledAt.getTime() <= OVERRIDE_PULL_FRESH_MS ? true : null;
}

/** Evidence that a runtime has loaded the project's current v2 skill catalog. */
export async function getSkillCatalogAdoption(
  projectId: string,
  db: Pick<ReturnType<typeof getDb>, "execute"> = getDb(),
): Promise<boolean | null> {
  const result = await db.execute(sql`
    select
      ${projects.catalogVersionV2} as current_version,
      exists (
        select 1 from ${traceEvents}
        where ${traceEvents.projectId} = ${projectId}
          and ${traceEvents.catalogVersion} is not null
      ) as has_version_evidence,
      exists (
        select 1 from ${traceEvents}
        where ${traceEvents.projectId} = ${projectId}
          and ${traceEvents.catalogVersion} = ${projects.catalogVersionV2}
      ) as current_version_seen
    from ${projects}
    where ${projects.id} = ${projectId}
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row?.current_version || !row.has_version_evidence) return null;
  return Boolean(row.current_version_seen);
}

function toRuntimeCatalogEntry(raw: unknown): RuntimeCatalogEntry {
  const row = raw as Record<string, unknown>;
  const name = String(row.name);
  const lastSeenAt = new Date(row.last_seen_at as string | Date);
  if (row.entry_id === null) {
    return { entryId: null, name, provenance: "observed", lastSeenAt };
  }
  return {
    entryId: String(row.entry_id),
    name,
    description: String(row.description),
    tags: row.tags as string[],
    inputSchema: row.input_schema,
    outputSchema: row.output_schema,
    searchableDescription: String(row.searchable_description),
    searchableDescriptionOverridden: Boolean(row.searchable_description_overridden),
    useCloudDefinitions: Boolean(row.use_cloud_definitions),
    searchableDescriptionOverride:
      row.searchable_description_override === null
        ? null
        : String(row.searchable_description_override),
    provenance: runtimeCatalogProvenance(row.provenance),
    lastSeenAt,
  };
}

function runtimeCatalogProvenance(value: unknown): RuntimeToolDefinition["provenance"] {
  if (value === "events" || value === "snapshot" || value === "both") return value;
  throw new Error(`invalid runtime catalog provenance: ${String(value)}`);
}
