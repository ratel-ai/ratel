import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout } from "@ratel/design-system/states";
import { notFound } from "next/navigation";
import { SessionTimeline } from "@/components/console/session-replay/SessionTimeline";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadSessionLens } from "@/lib/views/session-replay/annotations-load";
import { loadSessionTimeline } from "@/lib/views/session-replay/load";
import { buildSessionView } from "@/lib/views/session-replay/view";
import { sessionReplayEnabled } from "@/lib/views/session-replay-flag";

export const dynamic = "force-dynamic";
export const metadata = { title: "Session replay" };

/**
 * One session step by step (RC-144): each turn, model call, search and tool
 * call in order, what the context held at each model call, and why each tool
 * choice was good or bad. Read-only and text-free: no message, argument or
 * query text is shown. Owned (ADR-0030): behind `FF_SESSION_REPLAY`, off by
 * default; without it the page does not exist.
 */
export default async function SessionReplayPage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = await params;
  if (!sessionReplayEnabled() || !isDbConfigured()) notFound();
  const { project } = await requireProjectScope(projectId);

  const view = await withStatementTimeout(
    async (db) => {
      const timeline = await loadSessionTimeline(project.id, sessionId, db);
      return timeline
        ? buildSessionView(timeline, await loadSessionLens(project.id, timeline, db))
        : null;
    },
    { operation: "session_replay_page" },
  );
  if (!view) notFound();

  const n = (value: number) => value.toLocaleString("en-US");
  return (
    <Page>
      <PageHeader
        title={<span className="font-mono">{sessionId}</span>}
        crumbs={[{ label: "Traces", href: `/project/${encodeURIComponent(project.id)}/traces` }]}
        description="Each step of this session, what the context held at each model call, and why each tool choice was good or bad."
      />
      <PageBody wide>
        <Callout tone={view.coverage.tone} title={view.coverage.text}>
          Message, argument and query text is not shown here. Expired steps lost their source events
          after 30 days.
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
        <SessionTimeline view={view} />
      </PageBody>
    </Page>
  );
}
