import { assistantText, type ChatTurn, chatMessages, type RunViewState } from "../playground-state";
import type { ReplayArm } from "../replay";
import type { ToolMode } from "../tools-state";
import type { ReplayTurn } from "./session-source";
import type { ReplayArmTurn, ReplayedCall } from "./turn-compare";

/**
 * The loop of a session replay (RC-1110, RC-1168), pure so a test drives it
 * with in-memory ports: one run per recorded user message, in order. Compare
 * runs each turn twice, baseline (code defaults) then candidate (edits). All
 * runs go in one playground session, so both arms get the session's pins and
 * the recorded fakes of the source session. Each arm's conversation is its own
 * replies so far plus the next recorded message.
 */

export interface ReplayRunRequest {
  runnerId: string;
  sandboxId: string;
  sourceSessionId: string;
  turns: readonly ReplayTurn[];
  compare: boolean;
  /** The candidate's params (only the changed ones). The baseline sends none. */
  candidateParams: Record<string, unknown>;
  changed: readonly string[];
  /** The same modes in both arms. */
  toolModes: Record<string, ToolMode>;
  /** The replay session to run in again ("Run again" keeps its pins); absent: the first run opens one. */
  sessionId?: string | null;
}

/** The body of `POST /sandboxes/runs` for one replay run. */
export interface ReplayRunBody {
  runnerId: string;
  sandboxId: string;
  sessionId?: string;
  input: { messages: ReturnType<typeof chatMessages> };
  params: Record<string, unknown>;
  toolModes: Record<string, ToolMode>;
  context: Record<string, never>;
  replay: { sourceSessionId: string; arm: ReplayArm };
}

export interface ReplayRunPorts {
  startRun(body: ReplayRunBody): Promise<{ runId: string; sessionId: string } | { error: string }>;
  /** Waits for the run's end and gives its folded view. */
  followRun(runId: string): Promise<RunViewState>;
  update(index: number, arm: ReplayArm, patch: Partial<ReplayArmTurn>): void;
  onSession(sessionId: string): void;
  /** A run that ended ok, e.g. to read its metrics. */
  onRunOk?(index: number, arm: ReplayArm, runId: string): void;
  stopped(): boolean;
}

/** Runs the replay; resolves with the session it ran in (null when no run started). */
export async function runSessionReplay(
  request: ReplayRunRequest,
  ports: ReplayRunPorts,
): Promise<{ sessionId: string | null }> {
  const arms: ReplayArm[] = request.compare ? ["baseline", "candidate"] : ["candidate"];
  const history: Record<ReplayArm, ChatTurn[]> = { baseline: [], candidate: [] };
  let sessionId = request.sessionId ?? null;
  for (const [index, turn] of request.turns.entries()) {
    for (const arm of arms) {
      if (ports.stopped()) {
        ports.update(index, arm, { status: "canceled", error: "Stopped before it ran." });
        continue;
      }
      ports.update(index, arm, { status: "running" });
      const started = await ports.startRun({
        runnerId: request.runnerId,
        sandboxId: request.sandboxId,
        ...(sessionId ? { sessionId } : {}),
        input: { messages: chatMessages(history[arm], turn.userMessage) },
        params: arm === "baseline" ? {} : request.candidateParams,
        toolModes: request.toolModes,
        context: {},
        // A single-arm replay with no edits is the baseline; Compare names its arms.
        replay: {
          sourceSessionId: request.sourceSessionId,
          arm: request.compare ? arm : request.changed.length === 0 ? "baseline" : "candidate",
        },
      });
      if (!("runId" in started)) {
        ports.update(index, arm, { status: "error", error: started.error });
        history[arm].push({
          user: turn.userMessage,
          runId: null,
          traceId: null,
          status: "error",
          assistant: null,
          error: started.error,
          tools: [],
        });
        continue;
      }
      if (sessionId !== started.sessionId) {
        sessionId = started.sessionId;
        ports.onSession(sessionId);
      }
      ports.update(index, arm, { runId: started.runId });
      const end = await ports.followRun(started.runId);
      const reply = assistantText(end.text, end.output);
      const status = end.status ?? "unknown";
      ports.update(index, arm, {
        status,
        reply,
        calls: end.tools.map(replayedCall),
        traceId: end.traceId,
        error: status === "ok" ? null : end.error,
      });
      history[arm].push({
        user: turn.userMessage,
        runId: started.runId,
        traceId: end.traceId,
        status,
        assistant: reply,
        error: end.error,
        tools: end.tools,
      });
      if (status === "ok") ports.onRunOk?.(index, arm, started.runId);
    }
  }
  return { sessionId };
}

function replayedCall(call: RunViewState["tools"][number]): ReplayedCall {
  return {
    tool: call.tool,
    args: call.args,
    mode: call.mode,
    fakeSource: call.fakeSource ?? null,
    result: call.result,
    isError: call.isError === true,
    done: call.done,
  };
}
