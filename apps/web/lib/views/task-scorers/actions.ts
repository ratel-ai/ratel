import { parseProjectUuid } from "@/lib/console/scope/cookie";
import type { ScorerInput } from "@/lib/views/task-scorers/store";
import { SCORER_KINDS, type Scorer, type ScorerKind } from "@/lib/views/task-scorers/types";

export type ScorerActionInput = {
  projectId: string;
  taskId: string;
} & ({ action: "save"; scorer: Scorer; enabled: boolean } | { action: "reset"; kind: ScorerKind });

export type ScorerActionResult = { ok: true } | { ok: false; error: string };

export interface ScorerActionDeps {
  getSession(): Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope(
    projectId: string,
    userId: string,
  ): Promise<{ project: { id: string }; organization: { id: string } } | null>;
  enabled(projectId: string, actor: string): Promise<boolean>;
  save(input: ScorerInput): Promise<unknown>;
  reset(projectId: string, taskId: string, kind: ScorerKind): Promise<unknown>;
  observe(fields: {
    project_id: string;
    organization_id: string;
    task_id: string;
    kind: ScorerKind;
    actor: string;
    action: "save" | "reset";
  }): Promise<void>;
}

/** Require project membership and the project flag before a scorer write. */
export async function changeTaskScorer(
  raw: unknown,
  deps: ScorerActionDeps,
): Promise<ScorerActionResult> {
  const input = parseInput(raw);
  if (!input) return { ok: false, error: "The scorer settings are invalid." };
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to edit scorers." };
  const scope = await deps.findProjectScope(input.projectId, session.user.id);
  if (!scope) return { ok: false, error: "You cannot edit this project's scorers." };
  const actor = session.user.externalId;
  if (!(await deps.enabled(scope.project.id, actor)))
    return { ok: false, error: "Scorers are off for this project." };
  if (input.action === "save") {
    await deps.save({
      projectId: scope.project.id,
      taskId: input.taskId,
      scorer: input.scorer,
      enabled: input.enabled,
      source: "user",
      updatedBy: actor,
    });
  } else {
    await deps.reset(scope.project.id, input.taskId, input.kind);
  }
  await deps.observe({
    project_id: scope.project.id,
    organization_id: scope.organization.id,
    task_id: input.taskId,
    kind: input.action === "save" ? input.scorer.kind : input.kind,
    actor,
    action: input.action,
  });
  return { ok: true };
}

function parseInput(raw: unknown): ScorerActionInput | null {
  if (!isRecord(raw) || typeof raw.projectId !== "string" || typeof raw.taskId !== "string")
    return null;
  const projectId = parseProjectUuid(raw.projectId);
  const taskId = raw.taskId.trim();
  if (!projectId || !taskId || taskId.length > 500) return null;
  if (raw.action === "reset" && isKind(raw.kind))
    return { projectId, taskId, action: "reset", kind: raw.kind };
  if (raw.action !== "save" || typeof raw.enabled !== "boolean" || !isRecord(raw.scorer))
    return null;
  const { kind, max, tool, criteria } = raw.scorer;
  if (!isKind(kind)) return null;
  let scorer: Scorer;
  if (kind === "ends_well") scorer = { kind };
  else if (kind === "judge_criteria") {
    if (typeof criteria !== "string" || !criteria.trim() || criteria.length > 5000) return null;
    scorer = { kind, criteria: criteria.trim() };
  } else if (kind === "expected_tool") {
    if (typeof tool !== "string" || !tool.trim() || tool.length > 500) return null;
    scorer = { kind, tool: tool.trim() };
  } else {
    if (typeof max !== "number" || !Number.isFinite(max) || max < 0) return null;
    if (
      (kind === "max_tool_calls" || kind === "max_self_corrections") &&
      !Number.isSafeInteger(max)
    )
      return null;
    scorer = { kind, max };
  }
  return { projectId, taskId, action: "save", scorer, enabled: raw.enabled };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is ScorerKind {
  return typeof value === "string" && SCORER_KINDS.some((kind) => kind === value);
}
