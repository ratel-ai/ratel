import { getPrimaryApiKeyForProject } from "@/lib/platform/projects/queries";
import { loadOrFallback, type ResilientReadDeps } from "@/lib/platform/resilient-read";

/**
 * Whether the project has a key that still works (not revoked, not expired):
 * the one `getPrimaryApiKeyForProject` would show. Onboarding issues one, so
 * the "nothing sent yet" CTAs (`ApiKeyCta`) say "View API keys" instead of
 * asking for another. A failed read counts as no key, which is what those CTAs
 * said before they looked.
 */
export function hasUsableApiKey(
  projectId: string,
  findPrimary: (projectId: string) => Promise<unknown> = getPrimaryApiKeyForProject,
  deps?: ResilientReadDeps,
): Promise<boolean> {
  return loadOrFallback(
    {
      operation: "has_usable_api_key",
      distinctId: `project:${projectId}`,
      fallback: false,
      load: async () => (await findPrimary(projectId)) !== null,
    },
    deps,
  );
}
