import { PageBody } from "@ratel/design-system/page-header";
import { type ApiKeySummary, toApiKeySummary } from "@/lib/platform/api-key-actions";
import { listApiKeysForProject } from "@/lib/platform/projects/queries";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { ApiKeysTable } from "./ApiKeysTable";
import { LoadError } from "./LoadError";
import { requireProjectScope } from "./project-scope";

/** Settings > API keys: the keys. A key list that fails to load becomes a retry in its place. */
export async function ApiKeysSettings({ projectId }: { projectId: string }) {
  const { project, organization } = await requireProjectScope(projectId);
  const now = new Date();
  const keys = await loadOrFallback<ApiKeySummary[] | null>({
    operation: "settings_api_keys",
    distinctId: `project:${project.id}`,
    fallback: null,
    load: async () =>
      (await listApiKeysForProject(project.id)).map((key) => toApiKeySummary(key, now)),
  });

  return (
    <PageBody className="*:min-w-0">
      {keys ? (
        <ApiKeysTable
          keys={keys}
          projectSlug={project.slug}
          organizationId={organization.id}
          now={now.toISOString()}
        />
      ) : (
        <LoadError what="API keys" />
      )}
    </PageBody>
  );
}
