import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout } from "@ratel/design-system/states";
import { notFound } from "next/navigation";
import {
  SessionTimeline,
  type WhatIfSetup,
} from "@/components/console/session-replay/SessionTimeline";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadFixes } from "@/lib/views/fixes/load";
import { loadSessionLens } from "@/lib/views/session-replay/annotations-load";
import { loadSessionTimeline } from "@/lib/views/session-replay/load";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import { loadStepTexts, type StepText } from "@/lib/views/session-replay/settings";
import { buildSessionView } from "@/lib/views/session-replay/view";
import {
  forkTargets,
  listWhatIfRuns,
  loadWhatIfOptions,
  sessionTools,
  withSessionToolsFirst,
} from "@/lib/views/session-replay/what-if";
import { sessionReplayEnabled } from "@/lib/views/session-replay-flag";

export const dynamic = "force-dynamic";
export const metadata = { title: "Session replay" };

/**
 * One session step by step (RC-144): each turn, model call, search and tool
 * call in order, what the context held at each model call, and why each tool
 * choice was good or bad, with What-if forks of a model call. Message text shows
 * only for calls that kept it, and only when the project's content opt-in is
 * on; argument and query text never shows. Owned (ADR-0030): behind
 * `FF_SESSION_REPLAY`, off by default; without it the page does not exist.
 */
export default async function SessionReplayPage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = await params;
  if (!sessionReplayEnabled() || !isDbConfigured()) notFound();
  const { project, organization } = await requireProjectScope(projectId);

  const loaded = await withStatementTimeout(
    async (db) => {
      const timeline = await loadSessionTimeline(project.id, sessionId, db);
      if (!timeline) return null;
      const view = buildSessionView(timeline, await loadSessionLens(project.id, timeline, db));
      const readContent = await contentOptIn(project.id, db);
      const whatIf = {
        targets: forkTargets(timeline),
        tools: sessionTools(timeline),
        runs: await listWhatIfRuns(project.id, sessionId, db),
      };
      if (!readContent) return { view, readContent, texts: {}, whatIf };
      const calls = timeline.steps.flatMap((step) =>
        step.kind === "model_call" && step.coverage === "content"
          ? [{ index: step.index, eventId: step.eventId }]
          : [],
      );
      const byEvent = await loadStepTexts(
        project.id,
        calls.map((call) => call.eventId),
        db,
      );
      const texts: Record<number, StepText> = {};
      for (const call of calls) {
        const text = byEvent.get(call.eventId);
        if (text) texts[call.index] = text;
      }
      return { view, readContent, texts, whatIf };
    },
    { operation: "session_replay_page" },
  );
  if (!loaded) notFound();
  const { view, readContent, texts } = loaded;
  // Fixes read with their own statement timeouts, outside the page's read.
  const options = await loadWhatIfOptions(
    project.id,
    async (id) => (await loadFixes({ projectId: id, organization, topics: false })).open,
  );
  const whatIf: WhatIfSetup = {
    projectId: project.id,
    targets: loaded.whatIf.targets,
    runs: loaded.whatIf.runs,
    options: withSessionToolsFirst(options, loaded.whatIf.tools),
    readContent,
  };

  const n = (value: number) => value.toLocaleString("en-US");
  return (
    <Page>
      <PageHeader
        title={<span className="font-mono">{sessionId}</span>}
        crumbs={[{ label: "Traces", href: `/project/${encodeURIComponent(project.id)}/traces` }]}
        description="Each step of this session, what the context held at each model call, and why each tool choice was good or bad. Fork a model call with a change to see what the agent picks then."
      />
      <PageBody wide>
        <Callout tone={view.coverage.tone} title={view.coverage.text}>
          {readContent
            ? "Message text shows for the model calls that kept it. Argument and query text is not shown."
            : "Message, argument and query text is not shown here. A project admin can turn on content reading in Settings."}{" "}
          Expired steps lost their source events after 30 days.
        </Callout>
        <StatRow
          stats={[
            { label: "Turns", value: n(view.totals.turns) },
            { label: "Model calls", value: n(view.totals.modelCalls) },
            { label: "Tool calls", value: n(view.totals.toolCalls) },
            { label: "Input tokens", value: n(view.totals.inputTokens) },
            { label: "Cost", value: `$${view.totals.costUsd.toFixed(4)}` },
          ]}
        />
        <SessionTimeline view={view} texts={texts} whatIf={whatIf} />
      </PageBody>
    </Page>
  );
}
