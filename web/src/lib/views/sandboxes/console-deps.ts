import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getDb } from "@/lib/platform/db/client";
import { sealedSecretsKey } from "@/lib/platform/sealed-secrets";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { createDrizzleSecretStore } from "./adapters/drizzle-secret-store";
import type { ConsoleAccessDeps } from "./console-access";
import { sandboxesEnabledForProject } from "./gate";
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
