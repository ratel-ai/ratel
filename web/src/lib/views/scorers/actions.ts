import { parseProjectUuid } from "@/lib/console/scope/cookie";
import { MAX_SCORERS, MAX_TASKS, parseScorerDraft, parseTaskId } from "./config";
import { limitText } from "./format";
import type { PreviewResult } from "./preview";
import type { Scorer, ScorerDraft, ScorerKind } from "./types";

export type ScorerChange =
  | { action: "create"; draft: ScorerDraft }
  | { action: "update"; scorerId: string; draft: ScorerDraft }
  | { action: "set_enabled"; scorerId: string; enabled: boolean }
  | { action: "delete"; scorerId: string }
  /** `narrow`: the person agreed that a scorer of every trace becomes one of this task only. */
  | { action: "attach"; scorerId: string; taskId: string; narrow: boolean }
  | { action: "detach"; scorerId: string; taskId: string };

export type ScorerActionResult = { ok: true; scorerId: string } | { ok: false; error: string };

/** Who may act on which project: every scorer action passes through it. */
export interface ScorerAccessDeps {
  getSession(): Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope(
    projectId: string,
    userId: string,
  ): Promise<{ project: { id: string }; organization: { id: string } } | null>;
  /** An admin support session may look but not change. */
  isRestricted(): Promise<boolean>;
}

export interface ScorerActionDeps extends ScorerAccessDeps {
  get(projectId: string, scorerId: string): Promise<Scorer | null>;
  count(projectId: string): Promise<number>;
  create(projectId: string, draft: ScorerDraft, actor: string): Promise<string>;
  update(projectId: string, scorerId: string, draft: ScorerDraft, actor: string): Promise<boolean>;
  setEnabled(
    projectId: string,
    scorerId: string,
    enabled: boolean,
    actor: string,
  ): Promise<boolean>;
  remove(projectId: string, scorerId: string): Promise<boolean>;
  attach(projectId: string, scorerId: string, taskId: string, actor: string): Promise<boolean>;
  detach(projectId: string, scorerId: string, taskId: string, actor: string): Promise<boolean>;
  observe(fields: {
    project_id: string;
    organization_id: string;
    scorer_id: string;
    kind: ScorerKind;
    actor: string;
    action: ScorerChange["action"];
  }): Promise<void>;
}

/** Check and apply one change to a project's scorers: membership comes first. */
export async function changeScorer(
  raw: unknown,
  deps: ScorerActionDeps,
): Promise<ScorerActionResult> {
  const parsed = parseChange(raw);
  if (!parsed.ok) return parsed;
  const { change } = parsed;
  const access = await authorizeScorers(parsed.projectId, deps);
  if (!access.ok) return access;
  const { projectId, organizationId, actor } = access;

  let scorerId: string;
  let kind: ScorerKind;
  if (change.action === "create") {
    // Over the limit too: a project may hold more after the task scorers' conversion.
    const limit = limitText(await deps.count(projectId), MAX_SCORERS);
    if (limit.full) return { ok: false, error: limit.text };
    scorerId = await deps.create(projectId, change.draft, actor);
    kind = change.draft.kind;
  } else {
    scorerId = change.scorerId;
    const current = await deps.get(projectId, scorerId);
    if (!current) return { ok: false, error: "The scorer does not exist." };
    kind = current.kind;
    if (change.action === "update" && !sameScale(current, change.draft))
      return {
        ok: false,
        error: "A scorer keeps its kind and its answer. Create a new scorer instead.",
      };
    if (change.action === "attach") {
      if (current.tasks === null && !change.narrow)
        return { ok: false, error: "This scorer covers every trace. Confirm the change first." };
      if (
        current.tasks &&
        current.tasks.length >= MAX_TASKS &&
        !current.tasks.includes(change.taskId)
      )
        return { ok: false, error: `A scorer covers up to ${MAX_TASKS} tasks.` };
    }
    if (!(await applied(projectId, change, actor, deps)))
      return { ok: false, error: "The scorer does not exist." };
  }
  await deps.observe({
    project_id: projectId,
    organization_id: organizationId,
    scorer_id: scorerId,
    kind,
    actor,
    action: change.action,
  });
  return { ok: true, scorerId };
}

/** Run a draft on the newest matching traces; a judge spends, so the checks are those of a change. */
export async function testScorer(
  rawProjectId: string,
  rawDraft: unknown,
  deps: ScorerAccessDeps & {
    preview(projectId: string, draft: ScorerDraft): Promise<PreviewResult[]>;
  },
): Promise<{ ok: true; results: PreviewResult[] } | { ok: false; error: string }> {
  const parsed = parseScorerDraft(rawDraft);
  if (!parsed.ok) return parsed;
  const access = await authorizeScorers(rawProjectId, deps);
  if (!access.ok) return access;
  return { ok: true, results: await deps.preview(access.projectId, parsed.draft) };
}

/** Require a session and project membership, outside a support session. */
export async function authorizeScorers(
  projectId: string,
  deps: ScorerAccessDeps,
): Promise<
  | { ok: true; projectId: string; organizationId: string; actor: string }
  | { ok: false; error: string }
> {
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to edit scorers." };
  const scope = await deps.findProjectScope(projectId, session.user.id);
  if (!scope) return { ok: false, error: "You cannot edit this project's scorers." };
  const subject = {
    projectId: scope.project.id,
    organizationId: scope.organization.id,
    actor: session.user.externalId,
  };
  if (await deps.isRestricted())
    return { ok: false, error: "A support session cannot change scorers." };
  return { ok: true, ...subject };
}

function applied(
  projectId: string,
  change: Exclude<ScorerChange, { action: "create" }>,
  actor: string,
  deps: ScorerActionDeps,
): Promise<boolean> {
  const { scorerId } = change;
  switch (change.action) {
    case "update":
      return deps.update(projectId, scorerId, change.draft, actor);
    case "set_enabled":
      return deps.setEnabled(projectId, scorerId, change.enabled, actor);
    case "attach":
      return deps.attach(projectId, scorerId, change.taskId, actor);
    case "detach":
      return deps.detach(projectId, scorerId, change.taskId, actor);
    case "delete":
      return deps.remove(projectId, scorerId);
  }
}

function parseChange(
  raw: unknown,
): { ok: true; projectId: string; change: ScorerChange } | { ok: false; error: string } {
  const invalid = { ok: false, error: "The scorer settings are invalid." } as const;
  if (typeof raw !== "object" || raw === null) return invalid;
  const input = raw as Record<string, unknown>;
  const projectId = uuidOf(input.projectId);
  if (!projectId) return invalid;
  const { action } = input;
  if (action === "create") {
    const parsed = parseScorerDraft(input.draft);
    return parsed.ok ? { ok: true, projectId, change: { action, draft: parsed.draft } } : parsed;
  }
  const scorerId = uuidOf(input.scorerId);
  if (!scorerId) return invalid;
  if (action === "update") {
    const parsed = parseScorerDraft(input.draft);
    return parsed.ok
      ? { ok: true, projectId, change: { action, scorerId, draft: parsed.draft } }
      : parsed;
  }
  if (action === "set_enabled" && typeof input.enabled === "boolean")
    return { ok: true, projectId, change: { action, scorerId, enabled: input.enabled } };
  const taskId = parseTaskId(input.taskId);
  if (action === "attach" && taskId)
    return {
      ok: true,
      projectId,
      change: { action, scorerId, taskId, narrow: input.narrow === true },
    };
  if (action === "detach" && taskId)
    return { ok: true, projectId, change: { action, scorerId, taskId } };
  if (action === "delete") return { ok: true, projectId, change: { action, scorerId } };
  return invalid;
}

/** Results of one scorer share one scale, so an edit never mixes a pass rate with a 1 to 5 average. */
function sameScale(current: ScorerDraft, next: ScorerDraft): boolean {
  if (current.kind === "judge" && next.kind === "judge")
    return current.config.output === next.config.output;
  return current.kind === next.kind;
}

function uuidOf(raw: unknown): string | null {
  return typeof raw === "string" ? parseProjectUuid(raw) : null;
}
