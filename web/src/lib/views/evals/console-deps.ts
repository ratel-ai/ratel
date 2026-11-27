import type { MemberAccessDeps } from "@/lib/console/scope/member-access";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getDb } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { listSandboxVersions } from "@/lib/views/sandboxes";
import { listScorers } from "@/lib/views/scorers/store";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import { createDrizzleCaseStore } from "./adapters/drizzle-case-store";
import { createDrizzleDatasetStore } from "./adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "./adapters/drizzle-eval-store";
import { createTaskLinks } from "./adapters/task-links";
import { createTraceSource } from "./adapters/trace-source";
import type { CasesApiDeps } from "./cases-api";
import type { DatasetsApiDeps } from "./datasets-api";
import type { EvalDialogDeps } from "./eval-dialog-api";
import type { EvalsApiDeps } from "./evals-api";
import { evalsEnabledForProject } from "./gate";
import { loadTurnContent } from "./turn-content";

/** The session routes over the real session and database. */
export const evalsAccess: MemberAccessDeps = {
  getSession: getSessionContext,
  findProjectScope,
  enabled: (projectId) => evalsEnabledForProject(projectId),
  isRestricted: isRestrictedBySupportSession,
};

export const casesApiDeps: CasesApiDeps = {
  ...evalsAccess,
  cases: () => createDrizzleCaseStore(getDb()),
  evals: () => createDrizzleEvalStore(getDb()),
  taskLinks: () => createTaskLinks(),
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
export async function readOnlyTools(projectId: string): Promise<ReadonlySet<string>> {
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

export const evalsApiDeps: EvalsApiDeps = {
  ...evalsAccess,
  evals: () => createDrizzleEvalStore(getDb()),
  now: () => new Date(),
};

export const datasetsApiDeps: DatasetsApiDeps = {
  ...evalsAccess,
  datasets: () => createDrizzleDatasetStore(getDb()),
  source: () => createTraceSource(getDb(), { readOnlyTools, now: () => new Date() }),
};

/** The sandbox versions that the "New eval" dialog reads: enough to find each sandbox's newest. */
const DIALOG_VERSIONS = 100;

export const evalDialogDeps: EvalDialogDeps = {
  ...evalsAccess,
  evals: () => createDrizzleEvalStore(getDb()),
  datasets: () => createDrizzleDatasetStore(getDb()),
  library: () => ({ projectScorers: (projectId) => listScorers(projectId, getDb()) }),
  versions: (projectId) => listSandboxVersions(projectId, DIALOG_VERSIONS),
};
