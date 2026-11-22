import { getLogger } from "@/lib/platform/logger";
import type { FixHandoffRow, RepoLinkRow } from "@/lib/views/code-handoff/schema";
import type { GitHubRepo, RepoRef } from "../ports";
import type { NewFixHandoff } from "../store";
import type { LoadedBrief } from "./load-brief";
import type { HandoffTarget } from "./target";

/**
 * Hand a fix off to a coding agent (RC-918): the one action of code handoff,
 * from Fixes and from MCP (`handoff_fix`). Behind `FF_CODE_HANDOFF`. It
 * needs a linked repo. A fix is handed off once per target: a second call
 * returns the first issue, and the unique index on `fix_handoffs` settles a
 * race. `fix_handed_off` is emitted once per new handoff. The brief holds
 * trace data, so the repo must be private: visibility is read live at each
 * handoff, since it can change after the link.
 */

export type HandoffSurface = "fixes" | "mcp";
export type HandoffError = "flag_off" | "no_repo_linked" | "public_repo" | "fix_not_found";
export type HandoffResult =
  | { ok: true; fixId: string; url: string; externalId: string; target: string; created: boolean }
  | { ok: false; error: HandoffError };

/** The analytics context of whoever handed it off (a person or an API key). */
export type HandoffEventContext =
  | { externalId: string; projectId: string; orgId?: string }
  | { projectId: string; orgId?: string };

export interface HandoffFixInput {
  projectId: string;
  fixId: string;
  /** A Clerk id, or `project:<id>` for an API key. */
  handedOffBy: string;
  context: HandoffEventContext;
  surface: HandoffSurface;
}

export interface HandoffFixDeps {
  flagEnabled: (projectId: string) => Promise<boolean>;
  getRepoLink: (projectId: string) => Promise<RepoLinkRow | null>;
  /** The linked repo as GitHub sees it now, or null when the installation cannot read it. */
  getRepo: (installationId: number, repo: RepoRef) => Promise<GitHubRepo | null>;
  getHandoff: (projectId: string, fixId: string, target: string) => Promise<FixHandoffRow | null>;
  loadBrief: (projectId: string, fixId: string) => Promise<LoadedBrief | null>;
  target: HandoffTarget;
  /** Store the handoff; when one exists for the fix and target, return it. */
  recordHandoff: (handoff: NewFixHandoff) => Promise<FixHandoffRow>;
  track: (
    event: "fix_handed_off",
    context: HandoffEventContext,
    properties: Record<string, unknown>,
  ) => Promise<void>;
  /** Refresh a stale code index in the background; the brief uses the pointers it has. */
  requestIndex: (projectId: string) => Promise<void>;
}

const logger = getLogger("code-handoff/handoff");

export async function handoffFix(
  input: HandoffFixInput,
  deps: HandoffFixDeps,
): Promise<HandoffResult> {
  const { projectId } = input;
  if (!(await deps.flagEnabled(projectId))) return { ok: false, error: "flag_off" };
  const link = await deps.getRepoLink(projectId);
  if (!link) return { ok: false, error: "no_repo_linked" };
  const target = deps.target.id;

  const known = await deps.getHandoff(projectId, input.fixId, target);
  if (known) return existing(known);

  const repo = await deps.getRepo(link.installationId, { owner: link.owner, name: link.name });
  if (!repo?.private) return { ok: false, error: "public_repo" };

  await deps
    .requestIndex(projectId)
    .catch((error: unknown) =>
      logger.warn({ project_id: projectId, err: error }, "code index request failed"),
    );
  const loaded = await deps.loadBrief(projectId, input.fixId);
  if (!loaded) return { ok: false, error: "fix_not_found" };
  // The id asked for may be an alias: the handoff is stored under the fix's own id.
  const fixId = loaded.fix.id;
  if (fixId !== input.fixId) {
    const own = await deps.getHandoff(projectId, fixId, target);
    if (own) return existing(own);
  }

  const made = await deps.target.handoff(
    { fixId, title: loaded.fix.title, brief: loaded.brief },
    { installationId: link.installationId, owner: link.owner, name: link.name },
  );
  const row = await deps.recordHandoff({
    projectId,
    fixId,
    target,
    externalId: made.externalId,
    url: made.url,
    handedOffBy: input.handedOffBy,
  });
  // Lost a race: another call stored its issue first; that one is the handoff.
  if (row.externalId !== made.externalId) return existing(row);
  await deps.track("fix_handed_off", input.context, {
    fix_id: fixId,
    fix_kind: loaded.fix.kind,
    target,
    surface: input.surface,
  });
  return { ok: true, fixId, url: row.url, externalId: row.externalId, target, created: true };
}

function existing(row: FixHandoffRow): HandoffResult {
  return {
    ok: true,
    fixId: row.fixId,
    url: row.url,
    externalId: row.externalId,
    target: row.target,
    created: false,
  };
}
