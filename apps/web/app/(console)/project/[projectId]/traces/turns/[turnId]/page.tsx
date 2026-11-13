import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { RunToTest } from "@/components/console/tasks/RunToTest";
import { TurnDetailView } from "@/components/console/traces/TurnDetailView";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { traceTurns } from "@/lib/ledger/schema";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { evalGateEnabledFor } from "@/lib/views/eval-gate/gate";
import { sessionReplayLink } from "@/lib/views/session-replay-flag";
import { runIsInEvalSet } from "@/lib/views/task-evals/run-to-test";
import { loadTurnDetail } from "@/lib/views/traces/turn-detail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Turn" };

/**
 * One turn, call by call: where an Agent health example's "Open in Traces"
 * lands. `?focus=<event id>` rings the call the example is about; the link's
 * hash scrolls to it. Owned (ADR-0030): the project comes from the console
 * scope, Agent health is always on in this edition, so there is no gate, the
 * session replay link follows `FF_SESSION_REPLAY`, and "run to test" (a closed
 * turn's run into its task's eval set) follows `FF_EVAL_GATE`.
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

  const turn = await withStatementTimeout((db) => loadTurnDetail(project.id, turnId, db), {
    operation: "trace_turn_detail",
  });
  if (!turn) notFound();

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
  const focus = Array.isArray(search.focus) ? search.focus[0] : search.focus;
  return (
    <>
      {testAction ? <div className="mb-4 flex justify-end">{testAction}</div> : null}
      <TurnDetailView
        projectId={project.id}
        turn={turn}
        focusEventId={focus?.trim() || null}
        sessionHref={sessionReplayLink(project.id, turn.sessionId)}
      />
    </>
  );
}
