import { getJobForProject } from "@/lib/jobs/queries";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";

export const runtime = "nodejs";

/**
 * GET /api/v1/jobs/[id] — poll an async job (Bearer-authed), scoped to the key's
 * project:
 *  - `status` is `queued` | `running` | `done` | `error`;
 *  - while queued/running, keep polling ("still being worked on");
 *  - on `done`, `result` carries the handler output.
 *
 * `404` when the job isn't in the key's project.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await resolveProjectFromBearer(req);
  if (!resolved.ok) return resolved.response;
  setRequestLogContext(req, { project_id: resolved.projectId });

  const { id } = await params;
  const job = await getJobForProject(resolved.projectId, id);
  if (!job) return Response.json({ error: "not_found" }, { status: 404 });

  return Response.json({
    id: job.id,
    kind: job.kind,
    status: job.status,
    result: job.result,
    error: job.error,
  });
}
