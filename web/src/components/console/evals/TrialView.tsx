"use client";

import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { Tabs } from "@ratel/design-system/tabs";
import { Waypoints } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionTimeline } from "@/components/console/session-replay/SessionTimeline";
import { TraceView } from "@/components/console/traces/TraceView";
import { evalHref, evalsHref, experimentHref } from "@/lib/views/evals/paths";
import type { TrialPageModel, TrialSide } from "@/lib/views/evals/suite-page";
import type { TrialViews } from "@/lib/views/evals/trial-views";
import { TrialPanel } from "./TrialPanel";

/**
 * One trial (level 4), next to the trial of the same row and index in the baseline run: the
 * output, the tool calls, the scorer reasons and the logs, then a tab with the trace view and a
 * tab with the session replay of each.
 */
export function TrialView({
  model,
  views,
  baselineViews,
}: {
  model: TrialPageModel;
  views: TrialViews;
  baselineViews: TrialViews | null;
}) {
  const { projectId, candidate, baseline } = model;
  const crumbs = [
    { label: "Evals", href: evalsHref(projectId) },
    ...(model.evalId
      ? [{ label: "Eval", href: evalHref(projectId, model.evalId, candidate.runId) }]
      : []),
  ];
  return (
    <Page>
      <PageHeader
        title={`${model.caseName} · trial ${candidate.trial.index + 1}`}
        description="This run on the left, the pinned baseline on the right: the same case and the same trial number."
        crumbs={crumbs}
      />
      <PageBody wide>
        <Pair
          left={<Side projectId={projectId} side={candidate} title="This run" />}
          right={
            baseline ? (
              <Side projectId={projectId} side={baseline} title="Baseline" />
            ) : (
              <NoBaseline />
            )
          }
        />
        <Tabs
          items={[
            {
              value: "trace",
              label: "Trace",
              content: (
                <Pair
                  left={<TraceTab views={views} />}
                  right={baseline ? <TraceTab views={baselineViews} /> : <NoBaseline />}
                />
              ),
            },
            {
              value: "replay",
              label: "Session replay",
              content: (
                <Pair
                  left={<ReplayTab projectId={projectId} views={views} />}
                  right={
                    baseline ? (
                      <ReplayTab projectId={projectId} views={baselineViews} />
                    ) : (
                      <NoBaseline />
                    )
                  }
                />
              ),
            },
          ]}
        />
      </PageBody>
    </Page>
  );
}

function Pair({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <div className="min-w-0">{left}</div>
      <div className="min-w-0">{right}</div>
    </div>
  );
}

function Side({ projectId, side, title }: { projectId: string; side: TrialSide; title: string }) {
  return (
    <Section
      title={title}
      actions={
        <Link
          href={experimentHref(projectId, side.runId)}
          className="text-ui text-accent-fg underline-offset-2 hover:underline"
        >
          Open the run
        </Link>
      }
    >
      <TrialPanel projectId={projectId} trial={side.trial} loadEvidence showLogs />
    </Section>
  );
}

function TraceTab({ views }: { views: TrialViews | null }) {
  if (!views?.trace) {
    return (
      <EmptyState
        icon={Waypoints}
        title="No trace"
        description="This trial stored no trace, or its spans are gone."
      />
    );
  }
  return <TraceView {...views.trace} />;
}

function ReplayTab({ projectId, views }: { projectId: string; views: TrialViews | null }) {
  if (!views?.replay) {
    return (
      <EmptyState
        icon={Waypoints}
        title="No session replay"
        description="No session of this project has the trace of this trial."
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {views.sessionId ? (
        <Link
          href={`/project/${projectId}/sessions/${views.sessionId}`}
          className="text-ui text-accent-fg underline-offset-2 hover:underline"
        >
          Open the session
        </Link>
      ) : null}
      <SessionTimeline view={views.replay} />
    </div>
  );
}

function NoBaseline() {
  return (
    <EmptyState
      icon={Waypoints}
      title="No baseline trial"
      description="The pinned baseline has no trial of this case with this number, or no run is pinned."
    />
  );
}
