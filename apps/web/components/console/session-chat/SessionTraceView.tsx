import { cn } from "@ratel/design-system/cn";
import { EmptyState } from "@ratel/design-system/states";
import Link from "next/link";
import { TraceView, type TraceViewProps } from "@/components/console/traces/TraceView";
import { sessionTraceHref } from "@/lib/views/session-chat/peek";

export interface TraceViewTurn {
  turnIndex: number;
  /** The person's message, when text is captured. */
  ask: string | null;
  /** The turn's runs, earliest first. */
  traceIds: readonly string[];
}

export interface SessionTraceViewProps {
  projectId: string;
  sessionId: string;
  turns: readonly TraceViewTurn[];
  /** The chosen turn; null when the session has none. */
  turnIndex: number | null;
  /** The shown run of the chosen turn. */
  traceId: string | null;
  /** The shown run's full trace; null when the turn has no run, or its spans are gone. */
  trace: TraceViewProps | null;
}

/**
 * The session replay's Trace view (`?view=trace&turn=<n>`, RC-314): the full
 * trace people know from Traces, for one turn at a time. A turn picker on
 * top; a turn with several runs lists them; a turn without one says so.
 */
export function SessionTraceView({
  projectId,
  sessionId,
  turns,
  turnIndex,
  traceId,
  trace,
}: SessionTraceViewProps) {
  const turn = turns.find((candidate) => candidate.turnIndex === turnIndex) ?? null;
  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Turns" className="flex flex-wrap items-center gap-1.5" data-turn-picker>
        <span className="mr-1 text-ui text-fg-muted">Turn</span>
        {turns.map((candidate) => (
          <Link
            key={candidate.turnIndex}
            href={sessionTraceHref(projectId, sessionId, candidate.turnIndex)}
            aria-current={candidate.turnIndex === turnIndex ? "page" : undefined}
            title={candidate.ask ?? undefined}
            data-turn={candidate.turnIndex}
            className={cn(
              "min-w-8 rounded-md border px-2 py-0.5 text-center text-ui tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus",
              candidate.turnIndex === turnIndex
                ? "border-line-active bg-raised font-medium text-fg"
                : "border-line text-fg-muted hover:bg-hover",
              candidate.traceIds.length === 0 && "border-dashed",
            )}
          >
            {candidate.turnIndex}
          </Link>
        ))}
      </nav>
      {turn && turn.traceIds.length > 1 ? (
        <nav
          aria-label={`Runs of turn ${turn.turnIndex}`}
          className="flex flex-wrap items-center gap-1.5"
          data-turn-runs
        >
          <span className="mr-1 text-ui text-fg-muted">
            {turn.traceIds.length} runs in this turn
          </span>
          {turn.traceIds.map((id, index) => (
            <Link
              key={id}
              href={sessionTraceHref(projectId, sessionId, turn.turnIndex, id)}
              aria-current={id === traceId ? "page" : undefined}
              className={cn(
                "rounded-md border px-2 py-0.5 font-mono text-ui outline-none focus-visible:ring-2 focus-visible:ring-focus",
                id === traceId
                  ? "border-line-active bg-raised text-fg"
                  : "border-line text-fg-muted hover:bg-hover",
              )}
            >
              Run {index + 1} · {id.slice(0, 8)}
            </Link>
          ))}
        </nav>
      ) : null}
      {turn === null ? (
        <EmptyState title="This session has no turns" description="There is no trace to show." />
      ) : trace ? (
        <TraceView {...trace} embedded />
      ) : (
        <div data-no-trace={turn.turnIndex}>
          <EmptyState
            title={`Turn ${turn.turnIndex} has no trace`}
            description={
              turn.traceIds.length === 0
                ? "This turn did not come with OpenTelemetry spans, so there is no waterfall to show. The chat and Step by step views still show its steps."
                : "This run's spans are no longer stored (raw telemetry expires after 30 days)."
            }
          />
        </div>
      )}
    </div>
  );
}
