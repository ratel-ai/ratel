"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Disclosure } from "@ratel/design-system/disclosure";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { TrialEvidence } from "@/lib/views/evals/domain/experiment";
import type { ScorerResult, TrialResult } from "@/lib/views/evals/domain/score";
import type { TrialView } from "@/lib/views/evals/page-model";

const RESULT: Record<TrialResult, { label: string; tone: Tone }> = {
  pass: { label: "Pass", tone: "success" },
  fail: { label: "Fail", tone: "danger" },
  invalid: { label: "Invalid", tone: "warning" },
};
const MODE = {
  real: { label: "Live", tone: "neutral" },
  fixture: { label: "Recorded", tone: "info" },
  fake: { label: "Simulated", tone: "accent" },
} as const;
const SCORER: Record<ScorerResult["status"], { label: string; tone: Tone }> = {
  pass: { label: "Pass", tone: "success" },
  fail: { label: "Fail", tone: "danger" },
  not_scored: { label: "Not scored", tone: "neutral" },
};

/** One trial: its result, its scorers with their reasons, and what the agent did. */
export function TrialPanel({
  projectId,
  trial,
  loadEvidence = false,
  showLogs = false,
}: {
  projectId: string;
  trial: TrialView;
  /** Reads the output and the tool calls with no click. */
  loadEvidence?: boolean;
  /** Shows the logs of the sandbox run, read when the reader opens them. */
  showLogs?: boolean;
}) {
  const result = trial.result ? RESULT[trial.result] : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-fg-subtle">
        <span className="text-ui text-fg">Trial {trial.index + 1}</span>
        <Badge tone={result?.tone ?? "info"}>{result?.label ?? "Open"}</Badge>
        {trial.durationMs !== null ? <span>{(trial.durationMs / 1000).toFixed(1)} s</span> : null}
        {trial.costUsd !== null ? <span>${trial.costUsd.toFixed(4)}</span> : null}
        {trial.traceId ? (
          <Link
            href={`/project/${projectId}/traces/${trial.traceId}`}
            className="ml-auto text-ui text-accent-fg underline-offset-2 hover:underline"
          >
            Open the trace
          </Link>
        ) : null}
      </div>
      {trial.reason ? <p className="text-ui text-fg-muted">{trial.reason}</p> : null}
      {trial.scorers.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {trial.scorers.map((scorer) => (
            <li key={scorer.scorerId} className="flex flex-wrap items-center gap-2 text-ui">
              <Badge tone={SCORER[scorer.status].tone}>{SCORER[scorer.status].label}</Badge>
              <span className="text-fg">{scorer.name}</span>
              <span className="text-xs text-fg-faint">{scorer.gating ? "gating" : "advisory"}</span>
              <span className="text-fg-muted">{scorer.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {/* The agent of an invalid trial answered when a scorer read it. */}
      {trial.result && (trial.result !== "invalid" || trial.scorers.length > 0) ? (
        <Evidence projectId={projectId} trialId={trial.id} load={loadEvidence} />
      ) : null}
      {showLogs && trial.sandboxRunId && trial.result ? (
        <RunLogs projectId={projectId} runId={trial.sandboxRunId} />
      ) : null}
    </div>
  );
}

/** The logs of the sandbox run of a trial: the end only, so they are read with the panel. */
function RunLogs({ projectId, runId }: { projectId: string; runId: string }) {
  const [logs, setLogs] = useState<string | "loading" | "failed">("loading");
  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${projectId}/sandboxes/runs/${runId}`)
      .then((response) =>
        response.ok ? (response.json() as Promise<{ logs: string | null }>) : null,
      )
      .catch(() => null)
      .then((run) => {
        if (live) setLogs(run ? (run.logs ?? "") : "failed");
      });
    return () => {
      live = false;
    };
  }, [projectId, runId]);
  const text =
    logs === "loading"
      ? "Loading…"
      : logs === "failed"
        ? "The logs did not load."
        : logs || "The run wrote no log.";
  return (
    <Disclosure title="Logs">
      <pre className="max-h-60 overflow-auto rounded-md border border-line bg-rail p-3 font-mono text-xs whitespace-pre-wrap text-fg-muted">
        {text}
      </pre>
    </Disclosure>
  );
}

/** The output and the tool calls, read when the reader asks: they can be large. */
function Evidence({
  projectId,
  trialId,
  load: loadFirst,
}: {
  projectId: string;
  trialId: string;
  load: boolean;
}) {
  const [evidence, setEvidence] = useState<TrialEvidence | "loading" | "failed" | null>(
    loadFirst ? "loading" : null,
  );

  const load = useCallback(async () => {
    setEvidence("loading");
    const answer = await fetch(`/api/projects/${projectId}/evals/experiments/trials/${trialId}`)
      .then((response) => (response.ok ? (response.json() as Promise<TrialEvidence>) : null))
      .catch(() => null);
    setEvidence(answer ?? "failed");
  }, [projectId, trialId]);

  useEffect(() => {
    if (loadFirst) void load();
  }, [loadFirst, load]);

  if (evidence === null || evidence === "loading" || evidence === "failed") {
    return (
      <div className="flex items-center gap-3">
        <Button size="sm" variant="ghost" onClick={load} disabled={evidence === "loading"}>
          {evidence === "loading" ? "Loading…" : "Show output and tool calls"}
        </Button>
        {evidence === "failed" ? (
          <span className="text-ui text-fg-muted">They did not load. Try again.</span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <pre className="max-h-80 overflow-auto rounded-md border border-line bg-rail p-3 font-mono text-xs whitespace-pre-wrap text-fg">
        {show(evidence.output)}
      </pre>
      {evidence.toolCalls.length === 0 ? (
        <p className="text-xs text-fg-subtle">The agent called no tool.</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {evidence.toolCalls.map((call, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the calls of a trial never change their order
            <li key={index} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <code className="font-mono text-xs text-fg">{call.name}</code>
                <Badge tone={MODE[call.source].tone}>{MODE[call.source].label}</Badge>
              </span>
              <code className="font-mono text-xs break-all text-fg-muted">
                {show(call.arguments)} → {call.error ?? show(call.result)}
              </code>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}
