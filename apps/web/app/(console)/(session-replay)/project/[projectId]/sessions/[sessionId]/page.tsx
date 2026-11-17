import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout } from "@ratel/design-system/states";
import { ChartGantt, List, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadTraceViewProps } from "@/app/(console)/project/[projectId]/traces/[traceId]/trace-v2";
import { SessionChatView } from "@/components/console/session-chat/SessionChatView";
import { SessionTraceView } from "@/components/console/session-chat/SessionTraceView";
import {
  SessionTimeline,
  type WhatIfSetup,
} from "@/components/console/session-replay/SessionTimeline";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { firstParam } from "@/lib/synthesis/traces/v2/filters";
import { loadFixes } from "@/lib/views/fixes/load";
import { loadSessionChat } from "@/lib/views/session-chat/load";
import {
  type SessionPageView,
  sessionPageView,
  sessionTraceHref,
  traceViewTurn,
} from "@/lib/views/session-chat/peek";
import { loadTurnTraceIds } from "@/lib/views/session-chat/turn-traces";
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
 *
 * The page opens as a chat with its work lines and a side panel (RC-282);
 * "Step by step" (`?view=steps`) shows the view above, unchanged; "Trace"
 * (`?view=trace&turn=<n>`, RC-314) shows a turn's full trace waterfall.
 */
export default async function SessionReplayPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
  searchParams: Promise<{
    view?: string | string[];
    turn?: string | string[];
    trace?: string | string[];
    tab?: string | string[];
    span?: string | string[];
  }>;
}) {
  const { projectId, sessionId } = await params;
  if (!sessionReplayEnabled() || !isDbConfigured()) notFound();
  const { project, organization } = await requireProjectScope(projectId);
  const projectHref = `/project/${encodeURIComponent(project.id)}`;
  const sessionHref = `${projectHref}/sessions/${encodeURIComponent(sessionId)}`;
  const query = await searchParams;
  const pageView = sessionPageView(query.view);
  if (pageView === "trace") {
    const loaded = await withStatementTimeout(
      async (db) => {
        const chat = await loadSessionChat(
          project.id,
          sessionId,
          { readContent: await contentOptIn(project.id, db) },
          db,
        );
        if (!chat) return null;
        return {
          chat,
          traces: await loadTurnTraceIds(
            project.id,
            chat.turns.map((turn) => turn.turnId),
            db,
          ),
        };
      },
      { operation: "session_trace_page" },
    );
    if (!loaded) notFound();
    const turns = loaded.chat.turns.map((turn) => ({
      turnIndex: turn.turnIndex,
      ask: turn.ask,
      traceIds: loaded.traces.get(turn.turnId) ?? [],
    }));
    const turnIndex = traceViewTurn(
      query.turn,
      turns.map((turn) => turn.turnIndex),
    );
    const runs = turns.find((turn) => turn.turnIndex === turnIndex)?.traceIds ?? [];
    const asked = firstParam(query.trace);
    const traceId = asked && runs.includes(asked) ? asked : (runs[0] ?? null);
    // The run reads with its own statement timeouts, outside the page's read.
    const trace = traceId
      ? await loadTraceViewProps(project.id, traceId, {
          listHref: `${projectHref}/traces`,
          compareHref: `${projectHref}/traces?compare=${encodeURIComponent(traceId)}`,
          tab: firstParam(query.tab),
          spanId: firstParam(query.span) ?? null,
        })
      : null;
    return (
      <Page>
        <PageHeader
          title={<span className="font-mono">{sessionId}</span>}
          crumbs={[{ label: "Traces", href: `${projectHref}/traces` }]}
          actions={
            <ViewLinks
              current="trace"
              sessionHref={sessionHref}
              traceHref={sessionTraceHref(project.id, sessionId, turnIndex ?? 1)}
            />
          }
        />
        <PageBody wide>
          <SessionTraceView
            projectId={project.id}
            sessionId={sessionId}
            turns={turns}
            turnIndex={turnIndex}
            traceId={traceId}
            trace={trace}
          />
        </PageBody>
      </Page>
    );
  }
  if (pageView === "chat") {
    const chat = await withStatementTimeout(
      async (db) =>
        loadSessionChat(
          project.id,
          sessionId,
          { readContent: await contentOptIn(project.id, db) },
          db,
        ),
      { operation: "session_chat_page" },
    );
    if (!chat) notFound();
    const toCheck = chat.problems.length;
    return (
      <Page>
        <PageHeader
          title={<span className="font-mono">{sessionId}</span>}
          crumbs={[{ label: "Traces", href: `${projectHref}/traces` }]}
          actions={
            <>
              <span className="text-ui text-fg-muted tabular-nums">
                {toCheck > 0 ? `${toCheck} to check` : "Nothing to check"}
              </span>
              <ViewLinks
                current="chat"
                sessionHref={sessionHref}
                traceHref={sessionTraceHref(
                  project.id,
                  sessionId,
                  chat.turns.at(-1)?.turnIndex ?? 1,
                )}
              />
            </>
          }
        />
        <PageBody wide>
          <SessionChatView
            projectId={project.id}
            chat={chat}
            settingsHref={`${projectHref}/settings`}
          />
        </PageBody>
      </Page>
    );
  }

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
        actions={
          <ViewLinks
            current="steps"
            sessionHref={sessionHref}
            traceHref={`${sessionHref}?view=trace`}
          />
        }
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

/** The page's three views; the current one is not a link. */
function ViewLinks({
  current,
  sessionHref,
  traceHref,
}: {
  current: SessionPageView;
  sessionHref: string;
  traceHref: string;
}) {
  const views = [
    { view: "chat", label: "Chat", href: sessionHref, icon: MessagesSquare },
    { view: "steps", label: "Step by step", href: `${sessionHref}?view=steps`, icon: List },
    { view: "trace", label: "Trace", href: traceHref, icon: ChartGantt },
  ] as const;
  return (
    <>
      {views
        .filter((item) => item.view !== current)
        .map((item) => (
          <Link
            key={item.view}
            href={item.href}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
            data-session-view={item.view}
          >
            <item.icon aria-hidden />
            {item.label}
          </Link>
        ))}
    </>
  );
}
