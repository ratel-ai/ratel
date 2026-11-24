import type { Organization } from "@/lib/platform/organizations";
import { projectEntitiesEnabled } from "./flag";

/**
 * The rail's check (RP-28): the organizations whose rail shows Agents and MCP servers under
 * Traces. Upstream's (`lib/agents/navigation.ts`, `lib/mcp-servers/navigation.ts`) also reads each
 * project's spans; here the owner's decision is that both items show whenever `agentsPages`
 * is on, and each page has its own empty state. A failed decision hides them.
 */
export async function entityPagesOrganizationIds(
  organizations: readonly Pick<Organization, "id">[],
  enabled: (organization: Pick<Organization, "id">) => Promise<boolean> = projectEntitiesEnabled,
): Promise<string[]> {
  const decided = await Promise.all(
    organizations.map(async (organization) =>
      (await enabled(organization).catch(() => false)) ? [organization.id] : [],
    ),
  );
  return decided.flat();
}
