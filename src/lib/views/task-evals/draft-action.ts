import { parseProjectUuid } from "@/lib/console/scope/cookie";
import type { TaskEvalActionDeps } from "./actions";
import type { TestProposal } from "./test-proposal";

export type DraftTestResult = { ok: true; proposal: TestProposal } | { ok: false; error: string };
export type DraftTestActionDeps = Pick<
  TaskEvalActionDeps,
  "getSession" | "findProjectScope" | "enabled"
> & {
  draft(projectId: string, taskId: string, turnId: string, actor: string): Promise<TestProposal>;
};

/** Require membership and the flag before a model call. */
export async function draftTaskTest(
  raw: unknown,
  deps: DraftTestActionDeps,
): Promise<DraftTestResult> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "The run settings are invalid." };
  const value = raw as Record<string, unknown>;
  const projectId = typeof value.projectId === "string" ? parseProjectUuid(value.projectId) : null;
  const turnId = typeof value.turnId === "string" ? parseProjectUuid(value.turnId) : null;
  const taskId = typeof value.taskId === "string" ? value.taskId.trim() : "";
  if (!projectId || !turnId || !taskId || taskId.length > 500)
    return { ok: false, error: "The run settings are invalid." };
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to draft a test." };
  const scope = await deps.findProjectScope(projectId, session.user.id);
  if (!scope) return { ok: false, error: "You cannot edit this project's evals." };
  const actor = session.user.externalId;
  if (!(await deps.enabled(scope.project.id, actor)))
    return { ok: false, error: "Evals are off for this project." };
  return { ok: true, proposal: await deps.draft(scope.project.id, taskId, turnId, actor) };
}
