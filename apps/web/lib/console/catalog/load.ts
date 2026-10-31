import type { SkillFull } from "@/lib/catalog/agent-tools/outputs";
import { serializeSkillFull } from "@/lib/catalog/agent-tools/serialize";
import { listSkills } from "@/lib/catalog/queries";
import {
  listObservedTools,
  listSkillRunCounts,
  listSyncedTools,
  listToolDefinitions,
} from "@/lib/ingest/catalogs/queries";
import type { Organization } from "@/lib/platform/identity/schema";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  getRuntimeCatalogOverrideAdoption,
  getRuntimeSkillCatalogEntries,
  getRuntimeToolDefinitions,
  getSkillCatalogAdoption,
} from "@/lib/synthesis/catalog/runtime-reads";
import { buildToolsCatalog, type CatalogTool } from "@/lib/synthesis/catalog/tools";
import type { RuntimeCatalogEntry, RuntimeToolDefinition } from "@/lib/synthesis/dashboard";
import { isoOrNull, type SkillRun } from "./items";

/**
 * The server reads behind the v2 Catalog pages. Nothing new is queried here:
 * each loader runs the same reads, behind the same flags, as the v1 page it
 * replaces (`catalogs/tools/page.tsx`, `explore/content.tsx`), plus one small
 * grouped count of skill runs. The pages hand the results to client views,
 * which build items from them with `lib/catalog/v2/items.ts`.
 */

export interface ToolsCatalogData {
  tools: CatalogTool[];
  runtimeEntries: RuntimeToolDefinition[];
  /** A managed tool's searchable description can be saved. */
  editable: boolean;
  /** A runtime pulled this project's overrides recently; null when there is no evidence. */
  adopted: boolean | null;
  /** An empty catalog can show how to sync definitions from the SDK. */
  syncGuide: boolean;
}

export async function loadToolsCatalog(projectId: string): Promise<ToolsCatalogData> {
  const [observed, synced, definitions, runtimeEntries, adopted] = await Promise.all([
    listObservedTools(projectId),
    listSyncedTools(projectId),
    listToolDefinitions(projectId),
    getRuntimeToolDefinitions(projectId),
    getRuntimeCatalogOverrideAdoption(projectId),
  ]);
  return {
    tools: buildToolsCatalog(observed, synced, [...definitions, ...runtimeEntries]),
    runtimeEntries,
    editable: true,
    adopted,
    syncGuide: true,
  };
}

export interface SkillsCatalogData {
  skills: SkillFull[];
  runtimeSkills: RuntimeCatalogEntry[];
  /** Runs per skill id as the runtime reports it. */
  runs: Record<string, SkillRun>;
  /** Cloud skills carry a searchable description. */
  searchableEnabled: boolean;
  /** Cloud copies of runtime skills' text can be saved. */
  runtimeEditable: boolean;
  /** Evidence that a runtime serves the current Cloud skill catalog; null when there is none. */
  adopted: boolean | null;
  /** False when each skill's SKILL.md body was left out (sent as ""), to be fetched on demand. */
  bodiesIncluded: boolean;
}

/** Every Cloud skill the v1 table could show; listSkills defaults to a silent 100-row cap. */
const SKILLS_LIMIT = 500;

export async function loadSkillsCatalog(
  projectId: string,
  organization: Organization | null,
  options: {
    /**
     * Send every skill's SKILL.md along. The Skills page needs them for its
     * editor; the Catalog home leaves them out, since a body can run to 256 KB
     * and the home only shows one when Instructions is opened.
     */
    bodies?: boolean;
  } = {},
): Promise<SkillsCatalogData> {
  const bodiesIncluded = options.bodies ?? true;
  const [skills, runtimeSkills, adopted, runCounts] = await Promise.all([
    listSkills(projectId, { limit: SKILLS_LIMIT }),
    getRuntimeSkillCatalogEntries(projectId),
    getSkillCatalogAdoption(projectId),
    // Run counts decorate the page; a failed read shows no counts rather than no catalog.
    loadOrFallback({
      operation: "catalog_skill_runs",
      distinctId: `project:${projectId}`,
      fallback: [],
      load: () => listSkillRunCounts(projectId),
    }),
  ]);
  return {
    skills: skills.map((skill) => {
      const record = serializeSkillFull(skill);
      return bodiesIncluded ? record : { ...record, body: "" };
    }),
    runtimeSkills,
    runs: Object.fromEntries(
      runCounts.map((count) => [
        count.skillId,
        { runs: count.runs, lastRunAt: isoOrNull(count.lastRunAt) },
      ]),
    ),
    searchableEnabled: true,
    runtimeEditable: true,
    adopted,
    bodiesIncluded,
  };
}
