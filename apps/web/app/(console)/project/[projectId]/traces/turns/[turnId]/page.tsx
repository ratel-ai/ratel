import { notFound } from "next/navigation";
import { TurnDetailView } from "@/components/console/traces/TurnDetailView";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadTurnDetail } from "@/lib/views/traces/turn-detail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Turn" };

/**
 * One turn, call by call: where an Agent health example's "Open in Traces"
 * lands. `?focus=<event id>` rings the call the example is about; the link's
 * hash scrolls to it. Owned (ADR-0030): the project comes from the console
 * scope, and Agent health is always on in this edition, so there is no gate.
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

  const { project } = await requireProjectScope(projectId);

  const turn = await withStatementTimeout((db) => loadTurnDetail(project.id, turnId, db), {
    operation: "trace_turn_detail",
  });
  if (!turn) notFound();

  const focus = Array.isArray(search.focus) ? search.focus[0] : search.focus;
  return <TurnDetailView projectId={project.id} turn={turn} focusEventId={focus?.trim() || null} />;
}
