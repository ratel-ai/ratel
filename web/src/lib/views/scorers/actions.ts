import { parseProjectUuid } from "@/lib/console/scope/cookie";
import { parseScorerDraft } from "./config";
import type { Scorer, ScorerDraft, ScorerKind } from "./types";

export type ScorerChange =
  | { action: "create"; draft: ScorerDraft }
  | { action: "update"; scorerId: string; draft: ScorerDraft }
  | { action: "set_enabled"; scorerId: string; enabled: boolean }
  | { action: "delete"; scorerId: string };

export type ScorerActionResult = { ok: true; scorerId: string } | { ok: false; error: string };

/** Who may act on which project: every scorer action passes through it. */
export interface ScorerAccessDeps {
  getSession(): Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope(
    projectId: string,
    userId: string,
  ): Promise<{ project: { id: string }; organization: { id: string } } | null>;
  enabled(subject: { projectId: string; organizationId: string; actor: string }): Promise<boolean>;
}

export interface ScorerActionDeps extends ScorerAccessDeps {
  get(projectId: string, scorerId: string): Promise<Scorer | null>;
  create(projectId: string, draft: ScorerDraft, actor: string): Promise<string>;
  update(projectId: string, scorerId: string, draft: ScorerDraft, actor: string): Promise<boolean>;
  setEnabled(
    projectId: string,
    scorerId: string,
    enabled: boolean,
    actor: string,
  ): Promise<boolean>;
  remove(projectId: string, scorerId: string): Promise<boolean>;
  observe(fields: {
    project_id: string;
    organization_id: string;
    scorer_id: string;
    kind: ScorerKind;
    actor: string;
    action: ScorerChange["action"];
  }): Promise<void>;
}

/** Check and apply one change to a project's scorers: membership and the flag come first. */
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
    const done =
      change.action === "update"
        ? await deps.update(projectId, scorerId, change.draft, actor)
        : change.action === "set_enabled"
          ? await deps.setEnabled(projectId, scorerId, change.enabled, actor)
          : await deps.remove(projectId, scorerId);
    if (!done) return { ok: false, error: "The scorer does not exist." };
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

/** Require a session, project membership and the project's flag. */
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
  if (!(await deps.enabled(subject)))
    return { ok: false, error: "Scorers are off for this project." };
  return { ok: true, ...subject };
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
