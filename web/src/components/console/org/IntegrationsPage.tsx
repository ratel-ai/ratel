import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { McpSetupGuide } from "@/components/console/mcp-setup/McpSetupGuide";
import { requireOrganizationScope } from "@/lib/console/scope/organization-scope";

/**
 * Integrations: the MCP server, at organization scope like the v1 page. Any organization the
 * reader belongs to (any other slug is a 404). A project's MCP page draws the same guide.
 */
export async function IntegrationsPage({ slug }: { slug: string }) {
  const { organization } = await requireOrganizationScope(slug);

  return (
    <Page>
      <PageHeader
        title="Integrations"
        description={`Connect Claude, Cursor or any MCP client to every project in ${organization.name}.`}
      />
      <PageBody className="*:min-w-0">
        <McpSetupGuide organization={organization} />
      </PageBody>
    </Page>
  );
}
