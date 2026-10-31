import type { ReactNode } from "react";
import { TraceComparePropertiesTable } from "@/components/console/traces/compare/TraceComparePropertiesTable";
import type { TraceComparisonSummary } from "@/lib/synthesis/traces/comparison";
import { formatCount } from "@/lib/synthesis/traces/format";

export function TraceCompareView({
  left,
  right,
  leftTruncated,
  rightTruncated,
  spanLimit,
  spanComparison,
}: {
  left: TraceComparisonSummary;
  right: TraceComparisonSummary;
  leftTruncated: boolean;
  rightTruncated: boolean;
  spanLimit: number;
  spanComparison: ReactNode;
}) {
  const truncatedLabels = [leftTruncated ? "A" : null, rightTruncated ? "B" : null].filter(
    (label): label is string => label !== null,
  );

  return (
    <div className="flex flex-col gap-5">
      <header className="pixel-header card-enter">
        <div className="eyebrow">Trace comparison</div>
        <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-cream">
          Compare traces
        </h1>
        <div className="mt-3 grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <TraceIdentity trace={left} align="left" />
          <span
            className="mx-auto grid size-8 place-items-center rounded-full border border-indigo-300/25 bg-indigo-300/10 font-mono text-xs text-indigo-300"
            aria-hidden
          >
            ↔
          </span>
          <TraceIdentity trace={right} align="right" />
        </div>
        <p className="mt-3 max-w-3xl text-sm text-warm-muted">
          Compare trace-level telemetry across two selected runs.
        </p>
        {truncatedLabels.length > 0 && (
          <p className="mt-3 rounded-lg border border-coral/35 bg-coral/10 px-3 py-2 font-mono text-[11px] text-cream-dim">
            {truncatedLabels.length === 1 ? "Trace" : "Traces"} {truncatedLabels.join(" and ")}{" "}
            exceed
            {truncatedLabels.length === 1 ? "s" : ""} the {formatCount(spanLimit, "span")} load cap.
            Totals and statuses reflect loaded spans only.
          </p>
        )}
      </header>

      <TraceComparePropertiesTable left={left} right={right} />
      {spanComparison}
    </div>
  );
}

function TraceIdentity({
  trace,
  align,
}: {
  trace: TraceComparisonSummary;
  align: "left" | "right";
}) {
  return (
    <div className={align === "right" ? "sm:text-right" : undefined}>
      <span className="font-mono text-[10px] uppercase tracking-[0.09em] text-indigo-300">
        Trace {align === "left" ? "A" : "B"}
      </span>
      <h2 className="mt-1 truncate font-display text-xl font-semibold tracking-tight text-cream">
        {trace.rootName}
      </h2>
      <p className="mt-1 truncate font-mono text-[10px] text-warm-muted/65" title={trace.traceId}>
        {trace.traceId}
      </p>
    </div>
  );
}
