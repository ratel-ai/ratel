/**
 * Commands from the web app to a gateway. Each kind maps one-to-one to the
 * sandbox/v1 controller frame the gateway sends to the worker; the payload is
 * that frame's payload.
 */

export type SandboxCommandKind =
  | "run.start"
  | "run.cancel"
  | "tool.confirm.decision"
  | "tool.fake.result";

export interface RunStartRequest {
  projectId: string;
  ownerUserId: string;
  runnerId: string;
  sandboxId: string;
  /** Absent: the store opens a new session for this sandbox and owner. */
  sessionId?: string;
  input: unknown;
  params: Record<string, unknown>;
  toolModes: Record<string, "real" | "fake" | "confirm">;
  context: Record<string, unknown>;
  configHash: string;
  overrides: string[];
  replay?: { sourceTraceId?: string; sourceSessionId?: string; arm?: "baseline" | "candidate" };
}

/** The sandbox/v1 `run.start` payload for a run. */
export function runStartPayload(
  request: RunStartRequest,
  sessionId: string,
): Record<string, unknown> {
  return {
    sandboxId: request.sandboxId,
    sessionId,
    input: request.input,
    params: request.params,
    toolModes: request.toolModes,
    context: request.context,
    configHash: request.configHash,
    ...(request.replay ? { replay: request.replay } : {}),
  };
}

/** The sandbox/v1 `run.cancel` payload. */
export function runCancelPayload(reason: string | undefined): Record<string, unknown> {
  return reason ? { reason } : {};
}

/** The sandbox/v1 `tool.confirm.decision` payload: edited args only for edit, the fake value only for fake. */
export function confirmDecisionPayload(input: {
  callId: string;
  decision: "approve" | "edit" | "fake" | "reject";
  args?: unknown;
  result?: unknown;
}): Record<string, unknown> {
  return {
    callId: input.callId,
    decision: input.decision,
    ...(input.decision === "edit" ? { args: input.args ?? null } : {}),
    ...(input.decision === "fake" ? { result: input.result ?? null } : {}),
  };
}
