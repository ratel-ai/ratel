import { cache } from "react";
import { type ApiKeyCta, apiKeyCta, noApiKeyCta } from "@/lib/console/api-key-cta";
import { listApiKeysForProject } from "@/lib/platform/projects/queries";
import { loadOrFallback } from "@/lib/platform/resilient-read";

/**
 * The project's API-key CTA (`apiKeyCta`), read on the server by `WithApiKeyCta`.
 * Once per request and project, however many places draw it. A failed read
 * degrades to "Create an API key", the CTA every page showed before it looked.
 */
export const loadApiKeyCta = cache(
  (projectId: string): Promise<ApiKeyCta> =>
    loadOrFallback({
      operation: "api_key_cta",
      distinctId: `project:${projectId}`,
      fallback: noApiKeyCta(projectId),
      load: async () => apiKeyCta(projectId, await listApiKeysForProject(projectId), new Date()),
    }),
);
