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
import type { TrialSide } from "@/lib/views/evals/pages-load";
import { evalHref, evalsHref, runHref } from "@/lib/views/evals/paths";
import type { TrialViews } from "@/lib/views/evals/trial-views";
import { TrialPanel } from "./TrialPanel";

/**
 * One trial, next to the trial of the same row, variant and number in the pinned baseline run of
 * the eval: the output, the tool calls, the scorer reasons and the logs, then a tab with the trace
 * view and a tab with the session replay of each.
 */
export function TrialView({
  projectId,
  evalId,
  evalName,
  caseName,
  candidate,
  baseline,
  views,
  baselineViews,
}: {
  projectId: string;
  evalId: string;
  evalName: string;
  caseName: string;
  candidate: TrialSide;
  baseline: TrialSide | null;
  views: TrialViews;
  baselineViews: TrialViews | null;
}) {
  const crumbs = [
    { label: "Evals", href: evalsHref(projectId) },
    { label: evalName, href: evalHref(projectId, evalId) },
    { label: "Run", href: runHref(projectId, evalId, candidate.runId) },
  ];
  return (
    <Page>
      <PageHeader
        title={`${caseName} · trial ${candidate.trial.index + 1}`}
        description="This run on the left, the pinned baseline on the right: the same row, variant and trial number."
        crumbs={crumbs}
      />
      <PageBody wide>
        <Pair
          left={<Side projectId={projectId} evalId={evalId} side={candidate} title="This run" />}
          right={
            baseline ? (
              <Side projectId={projectId} evalId={evalId} side={baseline} title="Baseline" />
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

function Side({
  projectId,
  evalId,
  side,
  title,
}: {
  projectId: string;
  evalId: string;
  side: TrialSide;
  title: string;
}) {
  return (
    <Section
      title={title}
      actions={
        <Link
          href={runHref(projectId, evalId, side.runId)}
          className="text-ui text-accent-mark underline-offset-2 hover:underline"
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
          className="text-ui text-accent-mark underline-offset-2 hover:underline"
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
      description="The eval has no pinned baseline, or the baseline has no trial of this row with this number."
    />
  );
}
