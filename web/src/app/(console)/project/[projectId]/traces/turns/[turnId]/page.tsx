import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { RunToTest } from "@/components/console/tasks/RunToTest";
import { TurnDetailView } from "@/components/console/traces/TurnDetailView";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { traceTurns } from "@/lib/ledger/schema";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { evalGateEnabledFor } from "@/lib/views/eval-gate/gate";
import { runIsInEvalSet } from "@/lib/views/task-evals/run-to-test";
import { loadTurnView } from "@/lib/views/traces/turn-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Turn" };

/**
 * One turn, call by call: where an Agent health example's "Open in Traces"
 * lands. `?focus=<event id>` rings the call the example is about; the link's
 * hash scrolls to it. Owned (ADR-0004): the project comes from the console
 * scope, Agent health is always on in this edition, so there is no gate, and "run to test" (a closed
 * turn's run into its task's eval set) follows `evalGate`.
 */
export default async function TurnTracePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; turnId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId, turnId }, search] = await Promise.all([params, searchParams]);
  if (!isDbConfigured()) {
    return (
      <p className="rounded-lg border border-coral/40 bg-coral/10 p-3 font-mono text-xs text-cream-dim">
        No database connected yet. Traces become available once setup finishes.
      </p>
    );
  }

  const { project, organization } = await requireProjectScope(projectId);

  const focus = (Array.isArray(search.focus) ? search.focus[0] : search.focus)?.trim() || null;
  const view = await loadTurnView(project.id, turnId, organization, focus);
  if (!view) notFound();

  const testAction = (await evalGateEnabledFor(organization))
    ? await withStatementTimeout(
        async (db) => {
          const [record] = await db
            .select({ taskId: traceTurns.workflowId })
            .from(traceTurns)
            .where(
              and(
                eq(traceTurns.projectId, project.id),
                eq(traceTurns.id, turnId),
                eq(traceTurns.status, "closed"),
              ),
            )
            .limit(1);
          return record?.taskId ? (
            <RunToTest
              projectId={project.id}
              taskId={record.taskId}
              turnId={turnId}
              inEvalSet={await runIsInEvalSet(project.id, record.taskId, turnId, db)}
            />
          ) : null;
        },
        { operation: "trace_turn_test" },
      )
    : null;
  return (
    <>
      {testAction ? <div className="mb-4 flex justify-end">{testAction}</div> : null}
      <TurnDetailView
        projectId={project.id}
        turn={view.turn}
        focusEventId={focus}
        sessionHref={view.sessionHref}
        conversation={view.conversation}
        hallucinations={view.hallucinations}
      />
    </>
  );
}
