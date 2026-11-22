import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getLogger } from "@/lib/platform/logger";
import { setRequestLogContext } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException } from "@/lib/platform/telemetry";
import { loadStepContent } from "@/lib/views/session-chat/inspect-load";
import { loadSessionChat } from "@/lib/views/session-chat/load";
import type { PanelChat, PanelRouteDeps } from "@/lib/views/session-chat/panel-route";
import { loadTurnTraceIds } from "@/lib/views/session-chat/turn-traces";
import { contentOptIn } from "@/lib/views/session-replay/runs";

const logger = getLogger("session-chat/panel-route");

/** The real deps of the session chat's GET routes (panel-route.ts). */
export function panelRouteDeps(request: Request): PanelRouteDeps {
  return {
    getSession: async () => {
      const session = await getSessionContext();
      return session ? { userId: session.user.id, externalId: session.user.externalId } : null;
    },
    // Owned (ADR-0030): the project scope reads the session itself and takes the project id
    // only; the project must be the session organization's.
    findProject: async (projectId) => {
      const scope = await findProjectScope(projectId);
      return scope ? { projectId: scope.project.id, organizationId: scope.organization.id } : null;
    },
    readContent: (projectId) => contentOptIn(projectId),
    loadChat: loadPanelChat,
    loadStepContent: (projectId, stepRequest, readContent) =>
      loadStepContent(projectId, stepRequest, { readContent }),
    setLogContext: (fields) => setRequestLogContext(request, fields),
    logError: (fields, message) => logger.error(fields, message),
    reportException: reportServerException,
  };
}

/** The whole session as chat, each turn with the trace it opens; null before a turn ends. */
async function loadPanelChat(
  projectId: string,
  sessionId: string,
  readContent: boolean,
): Promise<PanelChat | null> {
  const chat = await loadSessionChat(projectId, sessionId, { readContent });
  if (!chat) return null;
  const traces = await loadTurnTraceIds(
    projectId,
    chat.turns.map((turn) => turn.turnId),
  );
  return {
    textOff: chat.textOff,
    turns: chat.turns.map(({ turnId, turnIndex, ask, reply, startedAt, endedAt, work }) => ({
      turnIndex,
      ask,
      reply,
      startedAt,
      endedAt,
      work,
      traceId: traces.get(turnId)?.[0] ?? null,
    })),
  };
}
