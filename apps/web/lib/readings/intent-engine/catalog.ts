import { listToolDefinitions } from "@/lib/ingest/catalogs/queries";
import { getRuntimeToolCatalogEntries } from "@/lib/ingest/runtime-catalog/queries";
import { getDb } from "@/lib/platform/db/client";

/**
 * The project's tools as the engine reads them: their names teach it the
 * project's actions and objects (`create_task` → create, task), and their
 * descriptions and input schemas are what an ask with no known verb is matched
 * against. Static catalog facts only, never what the agent ran, so nothing the
 * ranking boosts can feed back into how asks are clustered.
 */

export interface CatalogTool {
  name: string;
  description: string | null;
  inputSchema: unknown;
}

/**
 * Every tool the runtime declares, plus names seen only in traces; the synced
 * definitions when the runtime catalog has none. Gateway tools are left out by
 * both readers.
 */
export async function loadCatalogTools(projectId: string, db = getDb()): Promise<CatalogTool[]> {
  const runtime = await getRuntimeToolCatalogEntries(projectId, db);
  if (runtime.length > 0) {
    // A name seen only in traces has no definition yet: its name still teaches the vocabulary.
    return runtime.map((t) =>
      t.entryId === null
        ? { name: t.name, description: null, inputSchema: null }
        : { name: t.name, description: t.description || null, inputSchema: t.inputSchema ?? null },
    );
  }
  const synced = await listToolDefinitions(projectId, db);
  return synced.map((t) => ({
    name: t.name,
    description: t.description ?? null,
    inputSchema: t.parameters ?? null,
  }));
}
