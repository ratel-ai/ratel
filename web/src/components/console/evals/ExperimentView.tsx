"use client";

import { Badge } from "@ratel/design-system/badge";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { ExperimentPageModel } from "@/lib/views/evals/page-model";
import { caseHref, evalsHref } from "@/lib/views/evals/paths";
import { BaselineActions, type BaselineState } from "./BaselineActions";
import { CountBadges, StateBadge } from "./ExperimentList";
import { TrialPanel } from "./TrialPanel";

const REFRESH_MS = 3_000;
/** One experiment: what it ran on, the raw counts of each case, and its trials. */
export function ExperimentView({
  model,
  baseline,
  canEdit,
  now,
}: {
  model: ExperimentPageModel;
  baseline: BaselineState;
  canEdit: boolean;
  now: string;
}) {
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
        actions={
          running ? null : (
            <BaselineActions
              projectId={model.projectId}
              experimentId={model.id}
              baseline={baseline}
              canEdit={canEdit}
            />
          )
        }
      />
      <PageBody>
        <Section title="Experiment">
          <div className="flex flex-wrap items-center gap-3">
            <StateBadge state={model.state} />
            {baseline === "this" ? <Badge tone="accent">Baseline</Badge> : null}
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
