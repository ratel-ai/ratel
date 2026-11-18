/**
 * The Traces Sessions API reads, for a member of the project: each tab's
 * summary and the next page of the Sessions list. Each read is project-scoped; a project the caller cannot
 * see answers 404, as one that does not exist.
 */

export interface TracesSessionsRouteDeps {
  dbConfigured: () => boolean;
  getSession: () => Promise<{ userId: string } | null>;
  findProject: (
    projectId: string,
    userId: string,
  ) => Promise<{ projectId: string; organizationId: string } | null>;
  setLogContext: (fields: Record<string, unknown>) => void;
}

/** Resolves the caller's project, then answers with `read` of it as JSON. */
export async function tracesSessionsResponse<T>(
  projectId: string,
  read: (projectId: string) => Promise<T>,
  deps: TracesSessionsRouteDeps,
): Promise<Response> {
  if (!deps.dbConfigured())
    return Response.json({ ok: false, message: "Not found." }, { status: 404 });
  const session = await deps.getSession();
  if (!session)
    return Response.json({ ok: false, message: "Sign in to see this project." }, { status: 401 });
  const scope = await deps.findProject(projectId, session.userId);
  if (!scope) return Response.json({ ok: false, message: "Not found." }, { status: 404 });
  deps.setLogContext({ project_id: scope.projectId, organization_id: scope.organizationId });
  return Response.json({ ok: true, data: await read(scope.projectId) });
}
