import type { SkillStatus } from "@/lib/catalog/manage";
import { listSkills } from "@/lib/catalog/queries";
import {
  listObservedTools,
  listSyncedTools,
  listToolDefinitions,
} from "@/lib/ingest/catalogs/queries";
import { getDb } from "@/lib/platform/db/client";
import { getRuntimeToolDefinitions } from "@/lib/synthesis/catalog/runtime-reads";
import { buildToolsCatalog } from "@/lib/synthesis/catalog/tools";
import { MAX_BENCH_CAPABILITIES } from "./contract";
import type { BenchSkill, BenchTool } from "./types";

/**
 * Load the capabilities a project's Playground ranks against.
 *
 * Read once, on the server, and shared by the page and the rank route so both
 * see the same baseline. Archived skills are left out (they are not part of any
 * live ranking) but DRAFTS are included: rehearsing a draft's retrievability
 * before publishing it is the main thing the surface is for.
 *
 * The runtime catalog is joined in unconditionally, because ranking on anything
 * else is a correctness bug rather than a feature: retrieval matches on the
 * searchable description, so a bench that only reads `description` silently
 * scores text no agent is ever ranked on. A project whose runtime has never
 * ingested a definition simply has no rows here, and the resolver in
 * `descriptions.ts` falls back to `description` on its own.
 */

// Declared in `contract.ts` so the bench UI can report it without importing
// this module (and with it, the database) into the browser bundle. Embedding a
// bench this large is fine: `embedTexts` chunks into provider-sized batches.
export { MAX_BENCH_CAPABILITIES } from "./contract";

export interface Bench {
  skills: BenchSkill[];
  tools: BenchTool[];
  /** True when a bucket hit the cap, so the UI can say the view is partial. */
  truncated: { skills: boolean; tools: boolean };
}

type BenchDb = Parameters<typeof listSkills>[2] & Parameters<typeof listObservedTools>[1];

type BenchDbWithRuntime = BenchDb & Parameters<typeof getRuntimeToolDefinitions>[1];

export type LoadBenchOptions = {
  /** Include definitions registered through runtime catalog snapshots. */
  includeSyncedTools?: boolean;
};

export function loadBench(
  projectId: string,
  options: LoadBenchOptions,
  db?: BenchDbWithRuntime,
): Promise<Bench>;
export function loadBench(projectId: string, db?: BenchDbWithRuntime): Promise<Bench>;

export async function loadBench(
  projectId: string,
  optionsOrDb: LoadBenchOptions | BenchDbWithRuntime = {},
  suppliedDb?: BenchDbWithRuntime,
): Promise<Bench> {
  const options = "select" in optionsOrDb ? {} : optionsOrDb;
  const db = "select" in optionsOrDb ? optionsOrDb : (suppliedDb ?? getDb());
  // One over the cap, so "there are more" is detected without a second count.
  const probe = MAX_BENCH_CAPABILITIES + 1;
  const [stored, observed, synced, definitions, runtimeEntries] = await Promise.all([
    listSkills(projectId, { limit: probe }, db),
    listObservedTools(projectId, db),
    options.includeSyncedTools ? listSyncedTools(projectId, {}, db) : Promise.resolve([]),
    listToolDefinitions(projectId, db),
    getRuntimeToolDefinitions(projectId, db),
  ]);
  // Keyed by name, which is the same key telemetry and the definitions join on.
  const runtimeByName = new Map(runtimeEntries.map((entry) => [entry.name, entry]));
  /**
   * Runtime entries are also a SOURCE of tools, not only a join onto them.
   *
   * A tool registered through runtime-catalog ingest but never yet called has no
   * telemetry row and no `tool_definitions` row, so the catalog builder would
   * not know its name at all — and a tool the agent can retrieve today would be
   * missing from the bench entirely. Same failure as ranking on the wrong text:
   * the bench has to hold what production holds.
   *
   * Behind `includeSyncedTools`, because that option is precisely "show tools
   * the runtime registered rather than only those telemetry saw", and letting
   * these in regardless would quietly answer a question the caller had already
   * answered. The searchable descriptions themselves are joined either way: they
   * change how an existing row RANKS, which is a correctness fix, not a
   * widening of what the bench holds.
   *
   * Ordered before `listToolDefinitions` so an existing definition still wins
   * the description; these only add names the builder would otherwise miss.
   */
  const runtimeDefinitions = options.includeSyncedTools
    ? runtimeEntries.map((entry) => ({
        name: entry.name,
        description: entry.description,
      }))
    : [];

  const live = stored.filter((skill) => skill.status !== "archived");
  // Usage joined with definitions. A definition for a tool telemetry has never
  // seen still belongs on the bench: it is rankable, so it can win a prompt, and
  // "declared but never called" is one of the more interesting things the
  // surface can tell you.
  const tools = buildToolsCatalog(observed, synced, [...runtimeDefinitions, ...definitions]);

  return {
    skills: live.slice(0, MAX_BENCH_CAPABILITIES).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      searchableDescription: skill.searchableDescription,
      tags: skill.tags,
      tools: skill.tools,
      status: skill.status as SkillStatus,
      version: skill.version,
    })),
    tools: tools.slice(0, MAX_BENCH_CAPABILITIES).map((tool) => {
      const entry = runtimeByName.get(tool.name);
      return {
        name: tool.name,
        // Observed-only tools have no definition and keep the builder's empty
        // description. Runtime snapshots contribute their registered
        // description, and so does a runtime catalog entry — that column IS the
        // agent description for a tool the runtime registered, so leaving the
        // row blank would show "no description" for something production
        // describes perfectly well. A definition the builder already found
        // still wins; this only fills a gap.
        description: tool.description || entry?.description || "",
        entryId: entry?.entryId ?? null,
        searchableDescription: entry?.searchableDescription ?? null,
        searchableDescriptionOverride: entry?.searchableDescriptionOverride ?? null,
        hasDefinition: tool.definition !== null || tool.sources.length > 0,
        calls: tool.calls,
        // Already loaded by the catalog builder and previously discarded here.
        // Carried with their provenance, never as bare numbers: these are OTel
        // estimates and a surface that shows them as facts is lying quietly.
        tokens: tool.tokens,
        tokensProvenance: tool.tokensProvenance,
        costUsd: tool.costUsd,
        costProvenance: tool.costProvenance,
      };
    }),
    truncated: {
      skills: live.length > MAX_BENCH_CAPABILITIES,
      tools: tools.length > MAX_BENCH_CAPABILITIES,
    },
  };
}
