import { type LineageRef, stageOfKind } from "./types";

/**
 * The lineage endpoint's logic (`app/api/projects/[projectId]/lineage`), with
 * every boundary injected so it is tested without Next or a database: the
 * flag, the session, the project scope (and whether the plan may name a run),
 * the resolver, logging and exception reporting.
 */

export interface LineageQuery {
  kind: string | null;
  id: string | null;
  /** The whole chain back to Monitor instead of one step. */
  chain: boolean;
}

export interface LineageRouteDeps {
  enabled: () => Promise<boolean>;
  dbConfigured: () => boolean;
  getSession: () => Promise<{ userId: string } | null>;
  findProject: (
    projectId: string,
    userId: string,
  ) => Promise<{ projectId: string; organizationId: string; traces: boolean } | null>;
  resolve: (
    ref: LineageRef,
    ctx: { projectId: string; traces: boolean },
    chain: boolean,
  ) => Promise<LineageRef | LineageRef[] | null>;
  setLogContext: (fields: { project_id: string; org_id: string }) => void;
  logError: (fields: Record<string, unknown>, message: string) => void;
  reportException: (
    error: unknown,
    distinctId: string,
    properties: Record<string, unknown>,
  ) => void;
}

export type LineageResponseBody =
  | { ok: true; ref: LineageRef; source: LineageRef | null }
  | { ok: true; ref: LineageRef; chain: LineageRef[] }
  | { ok: false; message: string };

const MAX_ID = 512;
const NO_STORE = { "cache-control": "no-store" };

function fail(status: number, message: string): Response {
  return Response.json({ ok: false, message } satisfies LineageResponseBody, {
    status,
    headers: NO_STORE,
  });
}

export async function lineageResponse(
  projectId: string,
  query: LineageQuery,
  deps: LineageRouteDeps,
): Promise<Response> {
  if (!(await deps.enabled())) return fail(404, "Not found.");
  if (!deps.dbConfigured()) return fail(404, "Lineage isn't available yet.");
  const session = await deps.getSession();
  if (!session) return fail(401, "Sign in to see where this came from.");
  const scope = await deps.findProject(projectId, session.userId);
  if (!scope) return fail(404, "Not found.");
  deps.setLogContext({ project_id: scope.projectId, org_id: scope.organizationId });

  const stage = query.kind ? stageOfKind(query.kind) : null;
  if (!stage || !query.kind || !query.id || query.id.length > MAX_ID)
    return fail(400, "Name an object by its kind and id.");
  const ref: LineageRef = { stage, kind: query.kind, id: query.id };

  try {
    const resolved = await deps.resolve(
      ref,
      { projectId: scope.projectId, traces: scope.traces },
      query.chain,
    );
    const body: LineageResponseBody = query.chain
      ? { ok: true, ref, chain: Array.isArray(resolved) ? resolved : [ref] }
      : { ok: true, ref, source: Array.isArray(resolved) ? null : resolved };
    return Response.json(body, { headers: NO_STORE });
  } catch (err) {
    deps.logError({ err, project_id: scope.projectId, kind: ref.kind }, "lineage read failed");
    deps.reportException(err, `project:${scope.projectId}`, {
      operation: "lineage_resolve",
      kind: ref.kind,
    });
    return fail(503, "Couldn't read where this came from. Try again in a moment.");
  }
}
