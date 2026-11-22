/** One run as `GET /api/projects/<id>/sandboxes/runs?sandboxId=` returns it. */
export interface SandboxRunItem {
  id: string;
  sessionId: string | null;
  runnerId: string | null;
  status: string;
  configHash: string;
  overrides: string[];
  input: unknown;
  params: Record<string, unknown>;
  output: unknown;
  error: unknown;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  traceId: string | null;
  createdAt: string;
  endedAt: string | null;
}

/** The status word and tone of a run status. */
export const RUN_STATUS: Record<
  string,
  { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }
> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  ok: { label: "Done", tone: "success" },
  error: { label: "Failed", tone: "danger" },
  canceled: { label: "Canceled", tone: "neutral" },
  rejected: { label: "Refused", tone: "danger" },
  lost: { label: "Lost", tone: "warning" },
};

export function runStatus(status: string | null) {
  return RUN_STATUS[status ?? ""] ?? { label: "Unknown", tone: "neutral" as const };
}

export function traceHref(projectId: string, traceId: string): string {
  return `/project/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}`;
}
