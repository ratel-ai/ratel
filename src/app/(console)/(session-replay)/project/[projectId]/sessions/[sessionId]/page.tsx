import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { ChartGantt, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadTraceViewProps } from "@/app/(console)/project/[projectId]/traces/[traceId]/trace-v2";
import { ReplayInSandbox } from "@/components/console/sandboxes/ReplayInSandbox";
import { SessionChatView } from "@/components/console/session-chat/SessionChatView";
import { SessionTraceView } from "@/components/console/session-chat/SessionTraceView";
import { StepsViewControl } from "@/components/console/tasks/StepsViewControl";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { parseStepsView } from "@/lib/readings/trace-signals/steps";
import { typedStepsEnabled } from "@/lib/readings/trace-signals/typed-steps";
import { firstParam } from "@/lib/synthesis/traces/v2/filters";
import { runsListPath, sessionPageTitle } from "@/lib/synthesis/traces/v2/run-noun";
import { loadFixes } from "@/lib/views/fixes/load";
import { loadSessionChat } from "@/lib/views/session-chat/load";
import type { SessionChat } from "@/lib/views/session-chat/model";
import {
  type SessionPageView,
  sessionPageView,
  sessionTraceHref,
  traceViewTurn,
} from "@/lib/views/session-chat/peek";
import { loadTurnTraceIds } from "@/lib/views/session-chat/turn-traces";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import {
  listWhatIfRuns,
  loadWhatIfOptions,
  withSessionToolsFirst,
} from "@/lib/views/session-replay/what-if";

export const dynamic = "force-dynamic";
export const metadata = { title: "Session replay" };

/**
 * One session step by step (RC-144): each turn, model call, search and tool
 * call in order, what the context held at each model call, and why each tool
 * choice was good or bad. Read-only. Message text shows only for calls that
 * kept it, and only when the project's content opt-in is on; argument and
 * query text never shows.
 *
 * The page opens as a chat with its work lines and a side panel (RC-282);
 * "Trace" (`?view=trace&turn=<n>`, RC-314) shows a turn's full trace
 * waterfall. There is one replay (RC-524): the chat, its context inspector
 * open at load with the verdicts and What if… of the old step-by-step view
 * (`?view=steps` opens the chat).
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
    steps?: string | string[];
  }>;
}) {
  const { projectId, sessionId } = await params;
  if (!isDbConfigured()) notFound();
  const { project, organization, user } = await requireProjectScope(projectId);
  // RC-413: titled by the first ask.
  const header = (asks: readonly (string | null)[]) => ({
    title: sessionPageTitle(sessionId, asks),
    description: `Session ${sessionId}`,
  });
  const projectHref = `/project/${encodeURIComponent(project.id)}`;
  const sessionHref = `${projectHref}/sessions/${encodeURIComponent(sessionId)}`;
  // RC-472: a session is opened from the Sessions tab, and goes back there.
  const crumbs = [{ label: "Sessions", href: `${projectHref}/traces` }];
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
          listHref: runsListPath(`${projectHref}/traces`),
          compareHref: `${runsListPath(`${projectHref}/traces`)}?compare=${encodeURIComponent(traceId)}`,
          tab: firstParam(query.tab),
          spanId: firstParam(query.span) ?? null,
        })
      : null;
    return (
      <Page>
        <PageHeader
          {...header(turns.map((turn) => turn.ask))}
          crumbs={crumbs}
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
  // cloud-typed-steps (FF_TYPED_STEPS): every step kind, the task bands and each turn's intent.
  const typedSteps = await typedStepsEnabled(project.id, organization.id);
  const loaded = await withStatementTimeout(
    async (db) => {
      const readContent = await contentOptIn(project.id, db);
      const chat = await loadSessionChat(project.id, sessionId, { readContent, typedSteps }, db);
      if (!chat) return null;
      return { chat, readContent, runs: await listWhatIfRuns(project.id, sessionId, db) };
    },
    { operation: "session_chat_page" },
  );
  if (!loaded) notFound();
  const { chat } = loaded;
  // Fixes read with their own statement timeouts, outside the page's read.
  const whatIf = {
    projectId: project.id,
    runs: loaded.runs,
    readContent: loaded.readContent,
    options: withSessionToolsFirst(
      await loadWhatIfOptions(
        project.id,
        async (id) => (await loadFixes({ projectId: id, organization, topics: false })).open,
      ),
      chatTools(chat),
    ),
  };
  const toCheck = chat.problems.length;
  // cloud-typed-steps (FF_TYPED_STEPS): the `?steps=` preset; off, the replay has no presets.
  const stepsView = typedSteps ? parseStepsView(firstParam(query.steps)) : undefined;
  return (
    <Page>
      <PageHeader
        {...header(chat.turns.map((turn) => turn.ask))}
        crumbs={crumbs}
        actions={
          <>
            <span className="text-ui text-fg-muted tabular-nums">
              {toCheck > 0 ? `${toCheck} to check` : "Nothing to check"}
            </span>
            {stepsView ? <StepsViewControl value={stepsView} /> : null}
            {/* RC-1110: with FF_SANDBOXES on, a link to the matching sandbox, or why replay is not possible. */}
            <ReplayInSandbox
              projectId={project.id}
              sessionId={sessionId}
              externalId={user.externalId}
            />
            <ViewLinks
              current="chat"
              sessionHref={sessionHref}
              traceHref={sessionTraceHref(project.id, sessionId, chat.turns.at(-1)?.turnIndex ?? 1)}
            />
          </>
        }
      />
      <PageBody wide>
        <SessionChatView
          projectId={project.id}
          chat={chat}
          settingsHref={`${projectHref}/settings`}
          synced
          whatIf={whatIf}
          stepsView={stepsView}
        />
      </PageBody>
    </Page>
  );
}

/** The page's views; the current one is not a link. There is no step list (RC-524). */
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
    { view: "chat", label: "Conversation", href: sessionHref, icon: MessagesSquare },
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

/** The tools the session searched for or called, in the order it first met them: What if… offers them first. */
function chatTools(chat: SessionChat): string[] {
  const out = new Set<string>();
  for (const segment of chat.segments) {
    if (segment.kind === "search") for (const hit of segment.hits) out.add(hit);
    if (segment.kind === "tool_call") out.add(segment.label);
  }
  return [...out];
}
