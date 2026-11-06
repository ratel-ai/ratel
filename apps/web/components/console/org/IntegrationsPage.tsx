import { CodeBlock } from "@ratel/design-system/code";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { notFound } from "next/navigation";
import { composition } from "@/lib/composition/ports";
import { assembleOperations } from "@/lib/mcp/operations";
import { mcpOriginFromHeaders } from "@/lib/mcp/public-origin";
import {
  listApiKeysForProject,
  listProjectsForOrganization,
} from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";
import { McpConnect } from "./McpConnect";
import { McpCapabilities, McpExample } from "./McpExample";

/**
 * Integrations: the MCP server, at organization scope like the
 * v1 page. One endpoint per deployment; a client reaches the project its key
 * belongs to. The organization is the session's (any other slug is a 404), and
 * no key is minted inside an admin support session.
 */
export async function IntegrationsPage({ slug }: { slug: string }) {
  const context = await getSessionContext();
  if (!context || context.organization.slug !== slug) notFound();
  const { organization } = context;
  const [origin, projects, actingAs] = await Promise.all([
    mcpOriginFromHeaders(),
    listProjectsForOrganization(organization.id),
    composition.session.actingAs(),
  ]);
  const endpoint = `${origin}/api/mcp`;
  // Prefixes only, per project: enough to say whether the CI path has a key.
  const keyPrefixesByProject = Object.fromEntries(
    await Promise.all(
      projects.map(async (project) => [
        project.id,
        (await listApiKeysForProject(project.id))
          .filter((key) => !key.revokedAt)
          .map((key) => key.keyPrefix),
      ]),
    ),
  ) as Record<string, string[]>;
  const toolCount = assembleOperations().length + 1;

  return (
    <Page>
      <PageHeader
        title="Integrations"
        description={`Connect Claude, Cursor or any MCP client to every project in ${organization.name}.`}
      />
      <PageBody className="*:min-w-0">
        <Section
          title="MCP server"
          description={`${toolCount} tools that read and improve your projects.`}
        >
          <McpConnect
            endpoint={endpoint}
            organizationId={organization.id}
            organizationSlug={organization.slug}
            projects={projects.map((project) => ({
              id: project.id,
              name: project.name,
              slug: project.slug,
            }))}
            keyPrefixesByProject={keyPrefixesByProject}
            restricted={actingAs !== null}
          />
        </Section>
        <Section title="Then ask it something">
          <McpExample />
        </Section>
        <Section
          title="What it can reach"
          description="Tools for a feature your organization has turned off say so. Ask get_flag_status to see which are on."
        >
          <McpCapabilities />
        </Section>
        <Section title="Endpoint">
          <CodeBlock samples={[{ label: "URL", code: endpoint }]} />
        </Section>
      </PageBody>
    </Page>
  );
}
