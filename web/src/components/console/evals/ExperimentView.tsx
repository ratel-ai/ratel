"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { TrialEvidence } from "@/lib/views/evals/domain/experiment";
import type { ScorerResult, TrialResult } from "@/lib/views/evals/domain/score";
import type { ExperimentPageModel, TrialView } from "@/lib/views/evals/page-model";
import { caseHref, evalsHref } from "@/lib/views/evals/paths";
import { CountBadges, StateBadge } from "./ExperimentList";

const REFRESH_MS = 3_000;
const RESULT: Record<TrialResult, { label: string; tone: Tone }> = {
  pass: { label: "Pass", tone: "success" },
  fail: { label: "Fail", tone: "danger" },
  invalid: { label: "Invalid", tone: "warning" },
};
const SCORER: Record<ScorerResult["status"], { label: string; tone: Tone }> = {
  pass: { label: "Pass", tone: "success" },
  fail: { label: "Fail", tone: "danger" },
  not_scored: { label: "Not scored", tone: "neutral" },
};

/** One experiment: what it ran on, the raw counts of each case, and its trials. */
export function ExperimentView({ model, now }: { model: ExperimentPageModel; now: string }) {
  const router = useRouter();
  const running = model.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, router]);

  return (
    <Page>
      <PageHeader
        title={`${model.sandboxName} · ${model.commit.slice(0, 12)}`}
        crumbs={[{ label: "Evals", href: evalsHref(model.projectId) }]}
      />
      <PageBody>
        <Section title="Experiment">
          <div className="flex flex-wrap items-center gap-3">
            <StateBadge state={model.state} />
            <CountBadges counts={model.counts} />
            {model.dirty ? <Badge tone="warning">Uncommitted changes</Badge> : null}
            <span className="text-xs text-fg-subtle" title={model.createdAt}>
              {formatRelativeTime(model.createdAt, now)}
            </span>
          </div>
          <dl className="grid max-w-3xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui">
            <dt className="text-fg-subtle">Sandbox version</dt>
            <dd className="font-mono text-xs">{model.sandboxVersionId}</dd>
            <dt className="text-fg-subtle">Commit</dt>
            <dd className="font-mono text-xs">{model.commit}</dd>
            <dt className="text-fg-subtle">Trials for each case</dt>
            <dd>{model.trialsPerCase}</dd>
            <dt className="text-fg-subtle">Params</dt>
            <dd className="font-mono text-xs">{JSON.stringify(model.params)}</dd>
          </dl>
        </Section>
        <Section title="Cases">
          <ul className="flex flex-col gap-4">
            {model.cases.map((row) => (
              <li key={row.versionId} className="rounded-lg border border-line bg-raised">
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Link
                    href={caseHref(model.projectId, row.caseId)}
                    className="min-w-0 truncate text-ui font-medium text-fg underline-offset-2 hover:underline"
                  >
                    {row.name}
                  </Link>
                  <span className="text-xs text-fg-subtle">v{row.number}</span>
                  <CountBadges counts={row.counts} />
                </div>
                <ol className="divide-y divide-line border-t border-line">
                  {row.trials.map((trial) => (
                    <li key={trial.id} className="px-4 py-3">
                      <TrialPanel projectId={model.projectId} trial={trial} />
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        </Section>
      </PageBody>
    </Page>
  );
}

function TrialPanel({ projectId, trial }: { projectId: string; trial: TrialView }) {
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
      {trial.result && trial.result !== "invalid" ? (
        <Evidence projectId={projectId} trialId={trial.id} />
      ) : null}
    </div>
  );
}

/** The output and the tool calls, read when the reader asks: they can be large. */
function Evidence({ projectId, trialId }: { projectId: string; trialId: string }) {
  const [evidence, setEvidence] = useState<TrialEvidence | "loading" | "failed" | null>(null);

  async function load() {
    setEvidence("loading");
    const response = await fetch(
      `/api/projects/${projectId}/evals/experiments/trials/${trialId}`,
    ).catch(() => null);
    setEvidence(response?.ok ? ((await response.json()) as TrialEvidence) : "failed");
  }

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
      <ol className="flex flex-col gap-1">
        {evidence.toolCalls.map((call, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the calls of a trial never change their order
          <li key={index} className="font-mono text-xs break-all text-fg-muted">
            {call.name}({show(call.arguments)}) → {call.error ?? show(call.result)} [{call.source}]
          </li>
        ))}
      </ol>
    </div>
  );
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}
