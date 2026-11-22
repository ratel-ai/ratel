"use client";

import { useCallback, useRef, useState } from "react";
import {
  initialRunView,
  type RunViewState,
  reduceRunView,
} from "@/lib/views/sandboxes/playground-state";
import type { ReplayArm } from "@/lib/views/sandboxes/replay";
import {
  type ReplayRunBody,
  type ReplayRunRequest,
  runSessionReplay,
} from "@/lib/views/sandboxes/replay/replay-run";
import type { ReplayTurn } from "@/lib/views/sandboxes/replay/session-source";
import type { ReplayArmTurn } from "@/lib/views/sandboxes/replay/turn-compare";
import { pollMetrics } from "./useCompare";

export type SessionReplayPhase = "idle" | "running" | "done" | "stopped";

export interface SessionReplayRow {
  turn: ReplayTurn;
  baseline: ReplayArmTurn | null;
  candidate: ReplayArmTurn;
}

export interface SessionReplayState {
  phase: SessionReplayPhase;
  /** Two arms (baseline and candidate) or one (the current config). */
  compare: boolean;
  rows: SessionReplayRow[];
  /** The candidate's changed params, as they were when the replay started. */
  overrides: string[];
  sessionId: string | null;
  error: string | null;
}

export interface SessionReplayStart extends Omit<ReplayRunRequest, "sandboxId" | "sessionId"> {
  /** Run again in this replay session (its pins answer both arms); absent: a new session. */
  sessionId?: string | null;
  onSettled?: () => void;
}

const IDLE: SessionReplayState = {
  phase: "idle",
  compare: false,
  rows: [],
  overrides: [],
  sessionId: null,
  error: null,
};
const QUEUED: ReplayArmTurn = {
  status: "queued",
  reply: null,
  calls: [],
  metrics: null,
  runId: null,
  traceId: null,
  error: null,
};
const EVENT_KINDS = [
  "text.delta",
  "tool.call",
  "tool.result",
  "log",
  "span.ref",
  "run.end",
] as const;

/**
 * Replay of a recorded session in its sandbox (RC-1110, spec §9): one run per
 * recorded user message, in order, in one playground session, so both arms
 * share the session's pins and the recorded fakes of the source session.
 * Compare runs each turn twice, baseline (code defaults) then candidate
 * (edits); each arm's conversation is its own replies so far plus the next
 * recorded message. Every run is stamped `ratel.replay.source_session_id`
 * and `ratel.replay.arm` by the runner.
 */
export function useSessionReplay(api: string, sandboxId: string) {
  const [state, setState] = useState<SessionReplayState>(IDLE);
  const stopped = useRef(false);

  const updateArm = useCallback((index: number, arm: ReplayArm, patch: Partial<ReplayArmTurn>) => {
    setState((current) => ({
      ...current,
      rows: current.rows.map((row, i) =>
        i === index ? { ...row, [arm]: { ...(row[arm] ?? QUEUED), ...patch } } : row,
      ),
    }));
  }, []);

  const start = useCallback(
    async (request: SessionReplayStart) => {
      stopped.current = false;
      setState((current) => ({
        phase: "running",
        compare: request.compare,
        rows: request.turns.map((turn) => ({
          turn,
          baseline: request.compare ? QUEUED : null,
          candidate: QUEUED,
        })),
        overrides: [...request.changed],
        // "Run again" keeps the replay session, so its pins answer both arms again.
        sessionId: request.sessionId ?? current.sessionId,
        error: null,
      }));
      const metrics: Promise<void>[] = [];
      await runSessionReplay(
        { ...request, sandboxId },
        {
          startRun: (body) => startRun(api, body),
          followRun: (runId) => followRun(api, runId),
          update: updateArm,
          onSession: (sessionId) => setState((current) => ({ ...current, sessionId })),
          onRunOk: (index, arm, runId) =>
            metrics.push(
              pollMetrics(api, runId).then((value) => updateArm(index, arm, { metrics: value })),
            ),
          stopped: () => stopped.current,
        },
      );
      setState((current) => ({ ...current, phase: stopped.current ? "stopped" : "done" }));
      request.onSettled?.();
      await Promise.all(metrics);
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

async function startRun(
  api: string,
  body: ReplayRunBody,
): Promise<{ runId: string; sessionId: string } | { error: string }> {
  try {
    const res = await fetch(`${api}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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

/** Folds the run's events with the playground's own reducer until the run's status ends the stream. */
function followRun(api: string, runId: string): Promise<RunViewState> {
  return new Promise((resolve) => {
    let view: RunViewState = {
      ...initialRunView,
      phase: "live",
      runId,
      status: "queued",
      startedAt: Date.now(),
    };
    const events = new EventSource(`${api}/runs/${encodeURIComponent(runId)}/events`);
    for (const kind of EVENT_KINDS) {
      events.addEventListener(kind, (event) => {
        const message = event as MessageEvent<string>;
        view = reduceRunView(view, {
          type: "event",
          seq: Number(message.lastEventId),
          kind,
          payload: parse(message.data),
          at: Date.now(),
        });
      });
    }
    events.addEventListener("run.status", (event) => {
      const payload = parse((event as MessageEvent<string>).data);
      events.close();
      resolve(
        reduceRunView(view, {
          type: "status",
          status: String(payload.status ?? "unknown"),
          error: payload.error ?? null,
          at: Date.now(),
        }),
      );
    });
    events.onerror = () => {
      // EventSource reconnects by itself; CLOSED means the server refused the stream.
      if (events.readyState !== EventSource.CLOSED) return;
      resolve(
        reduceRunView(view, {
          type: "status",
          status: "unknown",
          error: "Lost the run's live output.",
          at: Date.now(),
        }),
      );
    };
  });
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
