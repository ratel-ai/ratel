import type { StepContent, StepContentRequest } from "./inspect-load";
import type { ChatTurn } from "./model";

/**
 * RC-530: the session chat's reads as GET routes, for a signed-in member of
 * the project.
 *
 * - `GET /api/projects/:projectId/sessions/:sessionId/chat`: the whole session
 *   as chat for the Sessions tab's side panel, behind `cloud-trace-views-v3`.
 * - `GET /api/projects/:projectId/session-steps?event=…&search=…`: the stored
 *   text behind an inspector view, behind `cloud-session-replay`.
 *
 * Routes rather than Server Actions: a read-only support session refuses every
 * Server Action (a POST) in the browser, and an action from a tab of an older
 * deploy fails. A GET is a read for both. Same checks and the same answers as
 * the actions they replace (`actions.ts`).
 */

/** One turn of the side panel's chat, with the trace it opens. */
export interface PanelChatTurn
  extends Pick<ChatTurn, "turnIndex" | "ask" | "reply" | "startedAt" | "endedAt" | "work"> {
  traceId: string | null;
}

export interface PanelChat {
  textOff: boolean;
  turns: PanelChatTurn[];
}

export type SessionPanelChatResult =
  | { ok: true; chat: PanelChat | null }
  | { ok: false; error: string };
export type StepContentResult =
  | { ok: true; content: StepContent | null }
  | { ok: false; error: string };

/** The flag each read sits behind. */
export type PanelSurface = "trace-views-v3" | "session-replay";

export interface PanelRouteDeps {
  getSession: () => Promise<{ userId: string; externalId: string } | null>;
  findProject: (
    projectId: string,
    userId: string,
  ) => Promise<{ projectId: string; organizationId: string } | null>;
  enabled: (projectId: string, externalId: string, surface: PanelSurface) => Promise<boolean>;
  /** The project's content opt-in: without it no stored text is read. */
  readContent: (projectId: string) => Promise<boolean>;
  loadChat: (
    projectId: string,
    sessionId: string,
    readContent: boolean,
  ) => Promise<PanelChat | null>;
  loadStepContent: (
    projectId: string,
    request: StepContentRequest,
    readContent: boolean,
  ) => Promise<StepContent | null>;
  setLogContext: (context: { project_id: string; org_id: string; distinct_id: string }) => void;
  logError: (fields: Record<string, unknown>, message: string) => void;
  reportException: (
    error: unknown,
    distinctId: string,
    properties: Record<string, unknown>,
  ) => void;
}

const NO_PROJECT = "No project you belong to has that ID.";

export async function sessionPanelChatResponse(
  params: { projectId: string; sessionId: string },
  deps: PanelRouteDeps,
): Promise<Response> {
  const access = await authorize(params.projectId, "trace-views-v3", deps);
  if (!access.ok) {
    return json(access.status, {
      ok: false,
      error:
        access.status === 401 ? "Sign in to see this session." : (access.missing ?? "Not found."),
    });
  }
  try {
    const chat = await deps.loadChat(
      access.projectId,
      params.sessionId,
      await deps.readContent(access.projectId),
    );
    return json(200, { ok: true, chat });
  } catch (err) {
    deps.logError({ err, project_id: access.projectId }, "session_panel_chat_load_failed");
    deps.reportException(err, `project:${access.projectId}`, {
      operation: "session_panel_chat",
      project_id: access.projectId,
    });
    return json(500, { ok: false, error: "This session could not be loaded. Try again." });
  }
}

export async function stepContentResponse(
  params: { projectId: string },
  request: StepContentRequest,
  deps: PanelRouteDeps,
): Promise<Response> {
  const access = await authorize(params.projectId, "session-replay", deps);
  if (!access.ok) {
    const error =
      access.status === 401
        ? "Sign in to see this step."
        : (access.missing ?? "Session replay is off for this organization.");
    return json(access.status, { ok: false, error });
  }
  try {
    const content = await deps.loadStepContent(
      access.projectId,
      request,
      await deps.readContent(access.projectId),
    );
    return json(200, { ok: true, content });
  } catch (err) {
    deps.logError({ err, project_id: access.projectId }, "step_content_load_failed");
    deps.reportException(err, `project:${access.projectId}`, {
      operation: "session_step_content",
      project_id: access.projectId,
    });
    return json(500, { ok: false, error: "This step could not be loaded. Try again." });
  }
}

/** `?event=<id>&event=<id>&search=<id>`: the model calls to read and the search step for its query. */
export function stepContentRequestFromUrl(url: URL): StepContentRequest {
  return {
    eventIds: url.searchParams.getAll("event"),
    searchEventId: url.searchParams.get("search"),
  };
}

type Access = { ok: true; projectId: string } | { ok: false; status: 401 | 404; missing?: string };

async function authorize(
  projectId: string,
  surface: PanelSurface,
  deps: PanelRouteDeps,
): Promise<Access> {
  const session = await deps.getSession();
  if (!session) return { ok: false, status: 401 };
  const project = await deps.findProject(projectId, session.userId);
  if (!project) return { ok: false, status: 404, missing: NO_PROJECT };
  deps.setLogContext({
    project_id: project.projectId,
    org_id: project.organizationId,
    distinct_id: session.externalId,
  });
  if (!(await deps.enabled(project.projectId, session.externalId, surface)))
    return { ok: false, status: 404 };
  return { ok: true, projectId: project.projectId };
}

function json(status: number, body: SessionPanelChatResult | StepContentResult): Response {
  // Per member and per moment (turns still arrive): never shared, never stored.
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
