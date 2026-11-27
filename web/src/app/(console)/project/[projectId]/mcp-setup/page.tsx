import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { McpSetupGuide } from "@/components/console/mcp-setup/McpSetupGuide";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";

export const metadata = { title: "MCP" };

/**
 * The organization's Integrations guide, inside the project: the rail's MCP item, so a reader
 * connects a client without leaving the project. The key choice starts on this project. Not
 * `/mcp`, which is Traces › MCP servers.
 */
export default async function ProjectMcpSetupPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="MCP">
        The MCP server becomes available once setup finishes.
      </DatabaseUnavailable>
    );
  }

  const { projectId } = await params;
  const { project, organization } = await requireProjectScope(projectId);
  return (
    <Page>
      <PageHeader
        title="MCP"
        description={`Connect Claude, Cursor or any MCP client to every project in ${organization.name}.`}
      />
      <PageBody className="*:min-w-0">
        <McpSetupGuide organization={organization} projectId={project.id} />
      </PageBody>
    </Page>
  );
}
