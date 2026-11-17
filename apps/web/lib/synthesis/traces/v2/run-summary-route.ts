import type { PayloadContent } from "@/lib/synthesis/traces/payload-content";
import { buildRunSummary, type RunSpan, type RunSummary } from "./run-summary";

/**
 * The run Panel's read (`GET /api/projects/:projectId/traces/:traceId/summary`):
 * one run told as a conversation, for a signed-in member of its project.
 *
 * A route rather than a Server Action: an action posts to the page's own
 * `/project/…` URL, where the proxy refreshes the last-project cookie, and a
 * cookie change makes Next re-render the whole page and scroll it to the top
 * after every action. A plain GET under `/api` is a read and stays one.
 */

export type RunSummaryResult =
  | { ok: true; summary: RunSummary; truncated: boolean }
  | { ok: false; message: string };

export interface RunSummaryRouteDeps {
  getSession: () => Promise<{ userId: string; externalId: string } | null>;
  findProject: (
    projectId: string,
    userId: string,
  ) => Promise<{ projectId: string; organizationId: string } | null>;
  loadSpans: (
    projectId: string,
    traceId: string,
  ) => Promise<{ spans: readonly RunSpan[]; truncated: boolean }>;
  /** The trace's `events.payload` content for this reader, or null (flag off, nothing stored). */
  loadPayload?: (
    projectId: string,
    traceId: string,
    actor: string,
  ) => Promise<PayloadContent | null>;
  setLogContext: (context: { project_id: string; org_id: string; distinct_id: string }) => void;
  logError: (fields: Record<string, unknown>, message: string) => void;
  reportException: (
    error: unknown,
    distinctId: string,
    properties: Record<string, unknown>,
  ) => void;
  /** The Panel moved on and dropped this read: skip the span load nobody will see. */
  aborted?: () => boolean;
}

/** Nginx's "client closed request": nobody reads this response. */
const CLIENT_GONE = 499;

const TRACE_ID = /^[0-9a-f]{32}$/i;
const NOT_FOUND: RunSummaryResult = { ok: false, message: "This run isn't available." };

export async function runSummaryResponse(
  params: { projectId: string; traceId: string },
  deps: RunSummaryRouteDeps,
): Promise<Response> {
  if (!TRACE_ID.test(params.traceId)) return json(404, NOT_FOUND);
  const session = await deps.getSession();
  if (!session) return json(401, { ok: false, message: "Sign in to see this run." });
  // Not a member reads exactly like a missing project: nothing to probe.
  const project = await deps.findProject(params.projectId, session.userId);
  if (!project) return json(404, NOT_FOUND);
  deps.setLogContext({
    project_id: project.projectId,
    org_id: project.organizationId,
    distinct_id: session.externalId,
  });
  if (deps.aborted?.())
    return json(CLIENT_GONE, { ok: false, message: "This read was cancelled." });

  const traceId = params.traceId.toLowerCase();
  try {
    const [load, payload] = await Promise.all([
      deps.loadSpans(project.projectId, traceId),
      loadPayload(deps, project.projectId, traceId, session.externalId),
    ]);
    if (load.spans.length === 0)
      return json(404, { ok: false, message: "This run is no longer retained." });
    return json(200, {
      ok: true,
      summary: buildRunSummary(load.spans, undefined, payload),
      truncated: load.truncated,
    });
  } catch (err) {
    deps.logError(
      { err, project_id: project.projectId, trace_id: traceId },
      "run summary load failed",
    );
    deps.reportException(err, `project:${project.projectId}`, {
      operation: "trace_run_summary",
      project_id: project.projectId,
    });
    return json(500, { ok: false, message: "Couldn't load this run. Try again in a moment." });
  }
}

/** The payload is an extra: a failed read is logged and reported, and the run reads from its spans. */
async function loadPayload(
  deps: RunSummaryRouteDeps,
  projectId: string,
  traceId: string,
  actor: string,
): Promise<PayloadContent | null> {
  if (!deps.loadPayload) return null;
  try {
    return await deps.loadPayload(projectId, traceId, actor);
  } catch (err) {
    deps.logError({ err, project_id: projectId, trace_id: traceId }, "run payload load failed");
    deps.reportException(err, `project:${projectId}`, {
      operation: "trace_run_payload",
      project_id: projectId,
    });
    return null;
  }
}

function json(status: number, body: RunSummaryResult): Response {
  // Per member and per moment (late spans still arrive): never shared, never stored.
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
