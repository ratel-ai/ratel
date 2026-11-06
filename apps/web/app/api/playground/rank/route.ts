import { composition } from "@/lib/composition/ports";
import { findProject } from "@/lib/console/navigation";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { loadBench } from "@/lib/synthesis/playground/catalog";
import { createFixedWindowQuota } from "@/lib/synthesis/playground/quota";
import { rankResponse } from "@/lib/synthesis/playground/rank-route";

// The native BM25 registries and node:crypto both need the Node runtime.
export const runtime = "nodejs";

const logger = getLogger("playground/rank");

/** Embedding-backed runs per user per hour: a blast-radius cap, see `quota.ts`. */
const EMBEDDING_RUNS_PER_HOUR = 120;
const embeddingQuota = createFixedWindowQuota(EMBEDDING_RUNS_PER_HOUR, 60 * 60 * 1000);

export const POST = withRequestLog(handlePost);

async function handlePost(request: Request): Promise<Response> {
  if (!isDbConfigured()) {
    return Response.json({ error: "No database connected." }, { status: 503 });
  }
  const session = await getSessionContext();
  return rankResponse(await request.json().catch(() => null), {
    getSession: async () =>
      session ? { userId: session.user.id, externalId: session.user.externalId } : null,
    // One organization per session: the project must be one of its projects.
    findProject: async (projectId) => {
      if (!session) return null;
      const projects = await listProjectsForOrganization(session.organization.id);
      return findProject(projects, projectId)
        ? { projectId, organizationId: session.organization.id }
        : null;
    },
    loadBench: (projectId) => loadBench(projectId, { includeSyncedTools: true }),
    provider: composition.embeddingProvider,
    quota: embeddingQuota,
    setLogContext: (context) => setRequestLogContext(request, context),
    logError: (fields, message) => logger.error(fields, message),
    trackRun: (properties, context) =>
      trackServerEvent("playground_run_completed", context, properties),
  });
}
