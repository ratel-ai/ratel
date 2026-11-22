import { featureEnabled } from "@/lib/platform/experimental-features";
import type { Organization } from "@/lib/platform/organizations";

/**
 * `cloud-project-entities` (RC-771): a project's agents, MCP servers and
 * clients as entities. Ingest derives them with the flag off
 * (`lib/otlp/dimensions`); the flag gates only what a person sees, such as the
 * Agent and MCP server filters of Traces (RC-790).
 *
 * Owned (ADR-0030): the switch is the core's `FF_AGENTS_PAGES`, off by default. Without the
 * edition's flags port it is one switch for the deployment, read from the environment (or
 * `RATEL_EXPERIMENTAL_FEATURES` in the open-source edition); with it, the edition decides it for
 * the organization or the caller (`featureEnabled`). The Traces filters stay on for everyone
 * here. Upstream's names are kept so call sites stay identical.
 */
export const PROJECT_ENTITIES_FLAG = "FF_AGENTS_PAGES" as const;

type Env = Record<string, string | undefined>;

/** The flag for the signed-in person in the project's organization. Off when it cannot be decided. */
export function projectEntitiesEnabled(
  organization: Pick<Organization, "id">,
  env: Env = process.env,
): Promise<boolean> {
  return featureEnabled(PROJECT_ENTITIES_FLAG, { organizationId: organization.id }, { env });
}

/**
 * The flag for a project, before anything is read from the database (RP-83): the four pages
 * decide it first, so with the flag off they are absent even where no database is configured.
 * The context then decides it again for the project's organization.
 */
export function projectEntitiesEnabledForProject(
  projectId: string,
  env: Env = process.env,
): Promise<boolean> {
  return featureEnabled(PROJECT_ENTITIES_FLAG, { projectId }, { env });
}

/**
 * The flag for an MCP caller with no session: `project:<id>` for a key, the person's
 * identity-provider id otherwise. Upstream's `sessionFlagForActor(PROJECT_ENTITIES_FLAG, …)`.
 */
export function projectEntitiesEnabledForActor(
  projectId: string,
  actor: string,
  env: Env = process.env,
): Promise<boolean> {
  return featureEnabled(PROJECT_ENTITIES_FLAG, { projectId, actor }, { env });
}
