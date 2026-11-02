import { IntegrationsPage } from "@/components/console/org/IntegrationsPage";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";

export const metadata = { title: "Integrations" };

/**
 * The connect surface for the MCP server, at organization scope.
 *
 * It lived under a project first, which was wrong in a way the navigation made
 * obvious: the header entry had to guess which project to link to, because
 * nothing about connecting is per-project. There is one endpoint per
 * deployment; a key belongs to one project, and that is a choice made inside
 * the page rather than in the URL.
 */
export default async function OrganizationMcpPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Integrations">
        The MCP server becomes available once setup finishes.
      </DatabaseUnavailable>
    );
  }

  const { orgSlug } = await params;
  return <IntegrationsPage slug={orgSlug} />;
}
