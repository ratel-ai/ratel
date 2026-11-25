import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getDb } from "@/lib/platform/db/client";
import { sealedSecretsKey } from "@/lib/platform/sealed-secrets";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { createDrizzleSecretStore } from "./adapters/drizzle-secret-store";
import type { ConsoleAccessDeps } from "./console-access";
import { sandboxesEnabledForProject } from "./gate";
import { runDeps } from "./run-deps";
import type { RunsApiDeps } from "./runs-api";
import type { SecretsApiDeps } from "./secrets-api";

/** The session routes over the real session, database and key. */
export const consoleAccess: ConsoleAccessDeps = {
  getSession: getSessionContext,
  findProjectScope,
  enabled: (projectId) => sandboxesEnabledForProject(projectId),
  isRestricted: isRestrictedBySupportSession,
};

export const secretsApiDeps: SecretsApiDeps = {
  ...consoleAccess,
  secrets: () => createDrizzleSecretStore(getDb()),
  sealingKey: () => sealedSecretsKey(),
};

export const runsApiDeps: RunsApiDeps = {
  ...consoleAccess,
  runDeps,
  track: ({ externalId, projectId, organizationId, outcome }) =>
    trackServerEvent(
      "sandbox_run_started",
      { externalId, projectId, orgId: organizationId },
      { object_action: "sandbox_run_started", outcome, surface: "console" },
    ),
};
