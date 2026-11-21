import { SessionView } from "@/components/console/tasks/SessionView";
import { TasksNoDatabase } from "@/components/console/tasks/TasksView";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { listSessionTurns } from "@/lib/readings/tool-explorer/ledger";
import { loadCatalogNames } from "@/lib/readings/trace-signals/signals/analysis-context";
import { agentHealthHref, taskHref, tasksHref } from "@/lib/views/tasks/paths";
import { parseMarkedTools } from "@/lib/views/tasks/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Session · Tasks" };

const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * One conversation turn by turn, opened from a task's example run, with the task's steps marked.
 * Owned (ADR-0030): the project comes from the console scope.
 */
export default async function TaskSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId, sessionId }, query] = await Promise.all([params, searchParams]);
  if (!isDbConfigured()) return <TasksNoDatabase />;
  const { project } = await requireProjectScope(projectId);
  const distinctId = `project:${project.id}`;
  const [turns, names] = await Promise.all([
    loadOrFallback({
      operation: "task_session_turns",
      distinctId,
      fallback: [] as Awaited<ReturnType<typeof listSessionTurns>>,
      load: () =>
        withStatementTimeout((db) => listSessionTurns(project.id, sessionId, db), {
          operation: "task_session_turns",
        }),
    }),
    loadOrFallback({
      operation: "task_session_names",
      distinctId,
      fallback: new Map<string, string>(),
      load: () =>
        withStatementTimeout((db) => loadCatalogNames(project.id, db), {
          operation: "task_session_names",
          timeoutMs: supplementaryReadTimeoutMs(),
        }),
    }),
  ]);
  const task = typeof query.task === "string" && TASK_ID.test(query.task) ? query.task : null;
  const crumbs = [
    { label: "Agent health", href: agentHealthHref(project.id) },
    { label: "Tasks", href: tasksHref(project.id) },
  ];
  return (
    <SessionView
      projectId={project.id}
      sessionId={sessionId}
      turns={turns}
      names={Object.fromEntries(names)}
      highlight={parseMarkedTools(query.tools)}
      crumbs={crumbs}
      backHref={task ? taskHref(project.id, task) : tasksHref(project.id)}
      backLabel={task ? "Back to the task" : "Back to Tasks"}
    />
  );
}
