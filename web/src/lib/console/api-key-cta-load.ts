import { type ApiKeyCta, apiKeyCta, noApiKeyCta } from "@/lib/console/api-key-cta";
import { listApiKeysForProject } from "@/lib/platform/projects/queries";
import { loadOrFallback } from "@/lib/platform/resilient-read";

/**
 * The project's API-key CTA (`apiKeyCta`), read on the server for the pages
 * that draw `ApiKeyCta`. A failed read degrades to "Create an API key", the
 * CTA every page showed before it looked.
 */
export function loadApiKeyCta(projectId: string, now: Date = new Date()): Promise<ApiKeyCta> {
  return loadOrFallback({
    operation: "api_key_cta",
    distinctId: `project:${projectId}`,
    fallback: noApiKeyCta(projectId),
    load: async () => apiKeyCta(projectId, await listApiKeysForProject(projectId), now),
  });
}
