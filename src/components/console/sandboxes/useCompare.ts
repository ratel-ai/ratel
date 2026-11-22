"use client";

import { useCallback, useRef, useState } from "react";
import type { RecordedItemView } from "@/lib/views/sandboxes/page";
import {
  type CompareArm,
  checkCompareSelection,
  itemLabel,
  type ReplayArm,
  type RunMetrics,
  runPool,
} from "@/lib/views/sandboxes/replay";

export interface CompareArmState extends CompareArm {
  runId: string | null;
  traceId: string | null;
  error: string | null;
}

export interface CompareItemRow {
  spanId: string;
  sourceTraceId: string;
  label: string;
  recordedOutput: unknown;
  baseline: CompareArmState;
  candidate: CompareArmState;
}

export type ComparePhase = "idle" | "resolving" | "running" | "done" | "stopped";

export interface CompareState {
  phase: ComparePhase;
  rows: CompareItemRow[];
  /** The candidate's changed params, as they were when the compare started. */
  overrides: string[];
  error: string | null;
}

export interface CompareStart {
  spanIds: readonly string[];
  runnerId: string;
  /** The candidate's params: only the changed ones. The baseline sends none. */
  candidateParams: Record<string, unknown>;
  changed: readonly string[];
  maxConcurrency: number;
  /** Called once every run has ended, e.g. to refresh the runs list. */
  onSettled?: () => void;
}

interface RunEnd {
  status: string;
  output: unknown;
  traceId: string | null;
  error: string | null;
}

const IDLE: CompareState = { phase: "idle", rows: [], overrides: [], error: null };
const QUEUED: CompareArmState = {
  status: "queued",
  output: null,
  metrics: null,
  runId: null,
  traceId: null,
  error: null,
};
/** The runner exports a run's spans in batches: its metrics land a few seconds after its end. */
const METRICS_POLL_MS = 1_500;
const METRICS_POLLS = 12;

/**
 * Compare over recorded items (RC-1103, spec §9): for each item, a baseline
 * run (the code defaults) and a candidate run (the edits), as a loop over
 * single runs on the caller's runner, at most its concurrency at once. Each
 * run is a replay of its item's trace. Its tokens, cost and latency come from
 * the run's own trace once its spans are in.
 */
export function useCompare(api: string, sandboxId: string) {
  const [state, setState] = useState<CompareState>(IDLE);
  const stopped = useRef(false);

  const updateArm = useCallback(
    (index: number, arm: ReplayArm, patch: Partial<CompareArmState>) => {
      setState((current) => ({
        ...current,
        rows: current.rows.map((row, i) =>
          i === index ? { ...row, [arm]: { ...row[arm], ...patch } } : row,
        ),
      }));
    },
    [],
  );

  const start = useCallback(
    async (request: CompareStart) => {
      const refusal = checkCompareSelection(request.spanIds);
      if (refusal) {
        setState({ ...IDLE, error: refusal });
        return;
      }
      stopped.current = false;
      setState({ phase: "resolving", rows: [], overrides: [...request.changed], error: null });
      const resolved = await resolveItems(api, sandboxId, request.spanIds);
      if ("error" in resolved) {
        setState({ ...IDLE, error: resolved.error });
        return;
      }
      const rows: CompareItemRow[] = resolved.items.map((item) => ({
        spanId: item.spanId,
        sourceTraceId: item.sourceTraceId,
        label: itemLabel(item.input, item.spanId),
        recordedOutput: item.recordedOutput,
        baseline: QUEUED,
        candidate: QUEUED,
      }));
      setState({
        phase: "running",
        rows,
        overrides: [...request.changed],
        error:
          resolved.missing > 0
            ? `${resolved.missing} picked items are no longer recorded and were left out.`
            : null,
      });

      // Every run of the compare goes in one session: the first start opens it.
      let openSession: (id: string | undefined) => void = () => {};
      const session = new Promise<string | undefined>((resolve) => (openSession = resolve));
      const tasks = resolved.items.flatMap((item, index) =>
        (["baseline", "candidate"] as const).map((arm) => async () => {
          const first = index === 0 && arm === "baseline";
          const sessionId = first ? undefined : await session;
          if (stopped.current) {
            if (first) openSession(undefined);
            updateArm(index, arm, { status: "canceled", error: "Stopped before it ran." });
            return;
          }
          updateArm(index, arm, { status: "running" });
          const started = await startRun(api, {
            runnerId: request.runnerId,
            sandboxId,
            sessionId,
            input: item.input,
            params: arm === "baseline" ? {} : request.candidateParams,
            replay: { sourceTraceId: item.sourceTraceId, arm },
          });
          if (first) openSession("runId" in started ? started.sessionId : undefined);
          if (!("runId" in started)) {
            updateArm(index, arm, { status: "error", error: started.error });
            return;
          }
          updateArm(index, arm, { runId: started.runId });
          const end = await followRun(api, started.runId);
          updateArm(index, arm, {
            status: end.status,
            output: end.output,
            traceId: end.traceId,
            error: end.error,
          });
          if (end.status === "ok")
            void pollMetrics(api, started.runId).then((metrics) =>
              updateArm(index, arm, { metrics }),
            );
        }),
      );
      await runPool(tasks, request.maxConcurrency);
      setState((current) => ({ ...current, phase: stopped.current ? "stopped" : "done" }));
      request.onSettled?.();
    },
    [api, sandboxId, updateArm],
  );

  const stop = useCallback(() => {
    stopped.current = true;
  }, []);

  const close = useCallback(() => {
    stopped.current = true;
    setState(IDLE);
  }, []);

  return { state, start, stop, close };
}

async function resolveItems(
  api: string,
  sandboxId: string,
  spanIds: readonly string[],
): Promise<
  { items: (RecordedItemView & { sourceTraceId: string })[]; missing: number } | { error: string }
> {
  try {
    const res = await fetch(`${api}/compare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sandboxId, spanIds }),
    });
    const body = (await res.json().catch(() => null)) as {
      items?: (RecordedItemView & { sourceTraceId: string })[];
      missing?: string[];
      message?: string;
    } | null;
    if (!res.ok || !body?.items)
      return { error: body?.message ?? "Couldn't start the compare. Try again in a moment." };
    if (body.items.length === 0)
      return { error: "None of the picked items are recorded any more." };
    return { items: body.items, missing: body.missing?.length ?? 0 };
  } catch {
    return { error: "Couldn't reach Ratel. Check your connection and compare again." };
  }
}

async function startRun(
  api: string,
  body: {
    runnerId: string;
    sandboxId: string;
    sessionId?: string;
    input: unknown;
    params: Record<string, unknown>;
    replay: { sourceTraceId: string; arm: ReplayArm };
  },
): Promise<{ runId: string; sessionId: string } | { error: string }> {
  try {
    const res = await fetch(`${api}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, toolModes: {}, context: {} }),
    });
    const json = (await res.json().catch(() => null)) as {
      runId?: string;
      sessionId?: string;
      message?: string;
      error?: string;
    } | null;
    if (res.status === 201 && json?.runId && json.sessionId)
      return { runId: json.runId, sessionId: json.sessionId };
    if (json?.error === "runner_offline") return { error: "Your runner is paused." };
    return { error: json?.message ?? "The run did not start." };
  } catch {
    return { error: "Couldn't reach Ratel." };
  }
}

/** Waits for the run's end on its event stream. */
function followRun(api: string, runId: string): Promise<RunEnd> {
  return new Promise((resolve) => {
    const events = new EventSource(`${api}/runs/${encodeURIComponent(runId)}/events`);
    const end: RunEnd = { status: "running", output: null, traceId: null, error: null };
    events.addEventListener("run.end", (event) => {
      const payload = parse((event as MessageEvent<string>).data);
      end.output = payload.output ?? null;
      end.traceId = typeof payload.traceId === "string" ? payload.traceId : null;
      end.error = errorText(payload.error);
    });
    events.addEventListener("run.status", (event) => {
      const payload = parse((event as MessageEvent<string>).data);
      events.close();
      resolve({
        ...end,
        status: String(payload.status ?? "unknown"),
        error: end.error ?? errorText(payload.error),
      });
    });
    events.onerror = () => {
      // EventSource reconnects by itself; CLOSED means the server refused the stream.
      if (events.readyState !== EventSource.CLOSED) return;
      resolve({ ...end, status: "unknown", error: "Lost the run's live output." });
    };
  });
}

/** The run's metrics once its spans are in, or null when they do not arrive in time. */
export async function pollMetrics(api: string, runId: string): Promise<RunMetrics | null> {
  for (let attempt = 0; attempt < METRICS_POLLS; attempt += 1) {
    const res = await fetch(`${api}/runs/${encodeURIComponent(runId)}/metrics`, {
      cache: "no-store",
    }).catch(() => null);
    const body = res?.ok
      ? ((await res.json().catch(() => null)) as ({ ready: boolean } & Partial<RunMetrics>) | null)
      : null;
    if (body?.ready) {
      return {
        inputTokens: body.inputTokens ?? 0,
        outputTokens: body.outputTokens ?? 0,
        costUsd: body.costUsd ?? 0,
        latencyMs: body.latencyMs ?? null,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, METRICS_POLL_MS));
  }
  return null;
}

function parse(data: string): Record<string, unknown> {
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    // A frame that is not JSON carries nothing to show.
    return {};
  }
}

function errorText(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}
