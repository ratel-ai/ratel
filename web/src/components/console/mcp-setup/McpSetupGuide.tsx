import { CodeBlock } from "@ratel/design-system/code";
import { Section } from "@ratel/design-system/section";
import { composition } from "@/lib/composition/ports";
import { focusedConsoleEnabled } from "@/lib/console/focused-console";
import { agentToolCount } from "@/lib/mcp/operations";
import { mcpOriginFromHeaders } from "@/lib/mcp/public-origin";
import type { Organization } from "@/lib/platform/organizations";
import {
  listApiKeysForProject,
  listProjectsForOrganization,
} from "@/lib/platform/projects/queries";
import { supportSessionActingAs } from "@/lib/platform/support-session";
import { McpConnect } from "./McpConnect";
import { McpCapabilities, McpExample } from "./McpExample";

/**
 * How to connect an MCP client, written once: the organization's Integrations page and a
 * project's MCP page both draw it. One endpoint per deployment; a client reaches the project its
 * key belongs to, and on a project's page that project is the one picked first. The caller has
 * already checked the reader's access to the organization. No key is minted inside an admin
 * support session.
 */
export async function McpSetupGuide({
  organization,
  projectId,
}: {
  organization: Organization;
  /** The project the key choice starts on; the organization's first project when absent. */
  projectId?: string;
}) {
  const [origin, projects, actingAs] = await Promise.all([
    mcpOriginFromHeaders(),
    listProjectsForOrganization(organization.id),
    supportSessionActingAs(),
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
  const toolCount = agentToolCount({ focusedConsole: await focusedConsoleEnabled(organization) });

  return (
    <>
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
          initialProjectId={projectId}
          keyPrefixesByProject={keyPrefixesByProject}
          restricted={actingAs !== null}
          browserSignIn={composition.mcpOAuth !== undefined}
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
    </>
  );
}
