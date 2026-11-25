import type { MemberAccessDeps } from "@/lib/console/scope/member-access";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getDb } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { listSandboxVersions } from "@/lib/views/sandboxes";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import { createDrizzleCaseStore } from "./adapters/drizzle-case-store";
import type { CasesApiDeps } from "./cases-api";
import { loadTurnContent } from "./turn-content";

/** The session routes over the real session and database. */
export const evalsAccess: MemberAccessDeps = {
  getSession: getSessionContext,
  findProjectScope,
  isRestricted: isRestrictedBySupportSession,
};

export const casesApiDeps: CasesApiDeps = {
  ...evalsAccess,
  cases: () => createDrizzleCaseStore(getDb()),
  readContent: (projectId) => contentOptIn(projectId),
  loadTurn: loadTurnContent,
  readOnlyTools,
  track: ({ name, ...fields }, { externalId, projectId, organizationId }) =>
    trackServerEvent(
      name,
      { externalId, projectId, orgId: organizationId },
      { object_action: name, surface: "console", ...fields },
    ),
  now: () => new Date(),
};

/** A tool that the newest version of any sandbox declares with side effects is not read-only. */
async function readOnlyTools(projectId: string): Promise<ReadonlySet<string>> {
  const newest = new Map<string, boolean>();
  const seen = new Set<string>();
  for (const { sandboxId, tools } of await listSandboxVersions(projectId, 100)) {
    if (seen.has(sandboxId)) continue;
    seen.add(sandboxId);
    for (const { name, sideEffect } of tools) {
      newest.set(name, (newest.get(name) ?? false) || sideEffect);
    }
  }
  return new Set([...newest].flatMap(([name, sideEffect]) => (sideEffect ? [] : [name])));
}
