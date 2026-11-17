import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { EmptyState } from "@ratel/design-system/states";
import { ArrowUpRight } from "lucide-react";
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
  /**
   * `cloud-trace-views-v3` (RC-413): a session's unit is the turn, so the
   * runs inside one turn read as its traces, and Step by step as Replay.
   */
  viewsV3?: boolean;
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
  viewsV3 = false,
}: SessionTraceViewProps) {
  const turn = turns.find((candidate) => candidate.turnIndex === turnIndex) ?? null;
  const part = viewsV3
    ? { one: "Trace", lower: "trace", many: "traces", steps: "Replay" }
    : { one: "Run", lower: "run", many: "runs", steps: "Step by step" };
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
        {viewsV3 && traceId ? (
          // RC-472: the session links each turn to its own trace page, which links back here.
          <Link
            href={`/project/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}`}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "ml-auto")}
            data-open-turn={turnIndex ?? undefined}
          >
            Open turn {turnIndex}
            <ArrowUpRight aria-hidden />
          </Link>
        ) : null}
      </nav>
      {turn && turn.traceIds.length > 1 ? (
        <nav
          aria-label={`${viewsV3 ? "Traces" : "Runs"} of turn ${turn.turnIndex}`}
          className="flex flex-wrap items-center gap-1.5"
          data-turn-runs
        >
          <span className="mr-1 text-ui text-fg-muted">
            {turn.traceIds.length} {part.many} in this turn
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
              {part.one} {index + 1} · {id.slice(0, 8)}
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
                ? `This turn did not come with OpenTelemetry spans, so there is no waterfall to show. The chat and ${part.steps} views still show its steps.`
                : `This ${part.lower}'s spans are no longer stored (raw telemetry expires after 30 days).`
            }
          />
        </div>
      )}
    </div>
  );
}
