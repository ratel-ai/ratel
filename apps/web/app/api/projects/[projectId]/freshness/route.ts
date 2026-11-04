import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { loadAnalysisFreshness, loadSectionProgress } from "@/lib/views/freshness/load";
import type { AnalysisFreshness, SectionProgress } from "@/lib/views/freshness/model";
import { isAnalysisSection, sectionJobKinds } from "@/lib/views/freshness/sections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = getLogger("freshness/route");

/**
 * GET /api/projects/:projectId/freshness: when the project's analysis last
 * updated and whether more is on the way (RC-39), polled by the sidebar every
 * 30 seconds while the tab is visible. A read; no product event. A slow read
 * answers 204 and the sidebar keeps what it showed.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  if (!isDbConfigured()) return new Response(null, { status: 204 });
  const session = await getSessionContext();
  if (!session) return Response.json({ ok: false }, { status: 401 });
  const { projectId } = await context.params;
  const scope = await findProjectScope(projectId, session.user.id);
  if (!scope) return Response.json({ ok: false }, { status: 404 });
  setRequestLogContext(request, { project_id: scope.project.id, org_id: scope.organization.id });
  // ?section=intents answers for one page's jobs instead (RC-210).
  const section = new URL(request.url).searchParams.get("section");
  if (section !== null && !isAnalysisSection(section)) {
    return Response.json({ ok: false, error: "unknown section" }, { status: 400 });
  }
  try {
    const body = await withStatementTimeout<AnalysisFreshness | SectionProgress>(
      (db) =>
        section === null
          ? loadAnalysisFreshness(db, scope.project.id)
          : loadSectionProgress(db, scope.project.id, sectionJobKinds(section)),
      {
        operation: section === null ? "analysis_freshness" : "analysis_section_progress",
        timeoutMs: supplementaryReadTimeoutMs(),
      },
    );
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    // The sidebar or the page keeps what it showed; the failure is still visible to us.
    logger.error({ err, project_id: scope.project.id, section }, "analysis freshness read failed");
    return new Response(null, { status: 204 });
  }
}
