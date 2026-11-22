import { cn } from "@ratel/design-system/cn";
import type { ReactNode } from "react";
import { TraceStatusBadge } from "@/components/console/traces/compare/TraceStatusBadge";
import type { TraceComparisonSummary } from "@/lib/synthesis/traces/comparison";
import {
  formatCostUsd,
  formatCount,
  formatDuration,
  formatTimestamp,
  formatTokens,
  traceStatusCode,
} from "@/lib/synthesis/traces/format";

interface ComparisonProperty {
  label: string;
  left: ReactNode;
  right: ReactNode;
  changed: boolean;
  leftTone?: "error";
  rightTone?: "error";
}

export function TraceComparePropertiesTable({
  left,
  right,
}: {
  left: TraceComparisonSummary;
  right: TraceComparisonSummary;
}) {
  const rows = comparisonProperties(left, right);

  return (
    <section className="overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/35">
      <div className="flex flex-wrap items-center gap-2 border-b border-forest-300 bg-base-deep/30 px-4 py-2.5">
        <span className="h-px w-5 bg-indigo-300/80" aria-hidden />
        <h2 className="eyebrow">Trace properties</h2>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-warm-muted/65">
          changed values highlighted
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-xs">
          <caption className="sr-only">Side-by-side properties for two selected traces</caption>
          <thead>
            <tr className="border-b border-forest-300 text-left">
              <th className="w-40 px-4 py-3 font-mono text-[10px] font-normal uppercase tracking-wide text-warm-muted">
                Property
              </th>
              <TraceHeading label="Trace A" trace={left} />
              <TraceHeading label="Trace B" trace={right} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-forest-300/40 last:border-0">
                <th className="px-4 py-2.5 text-left font-mono text-[10px] font-normal uppercase tracking-wide text-warm-muted/75">
                  {row.label}
                </th>
                <PropertyValue changed={row.changed} tone={row.leftTone} value={row.left} />
                <PropertyValue changed={row.changed} tone={row.rightTone} value={row.right} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TraceHeading({ label, trace }: { label: string; trace: TraceComparisonSummary }) {
  return (
    <th className="min-w-64 border-l border-forest-300/55 px-4 py-3 font-normal">
      <span className="eyebrow">{label}</span>
      <span className="mt-1 block truncate font-display text-sm font-semibold text-cream">
        {trace.rootName}
      </span>
      <span className="mt-0.5 block font-mono text-[10px] text-warm-muted/65" title={trace.traceId}>
        {shortId(trace.traceId)}
      </span>
    </th>
  );
}

function PropertyValue({
  changed,
  tone,
  value,
}: {
  changed: boolean;
  tone?: ComparisonProperty["leftTone"];
  value: ReactNode;
}) {
  return (
    <td
      className={cn(
        "border-l border-forest-300/55 px-4 py-2.5 font-mono tabular-nums text-cream-dim",
        changed && "bg-indigo-300/[0.065] text-cream",
        tone === "error" && "text-coral",
      )}
    >
      <span className="flex items-center gap-2">
        {changed && <span className="size-1.5 shrink-0 rounded-full bg-indigo-300" aria-hidden />}
        <span className="min-w-0 break-words">{value}</span>
      </span>
    </td>
  );
}

function comparisonProperties(
  left: TraceComparisonSummary,
  right: TraceComparisonSummary,
): ComparisonProperty[] {
  return [
    property("Root span", left.rootName, right.rootName),
    property(
      "Started",
      formatTimestamp(left.startedAt),
      formatTimestamp(right.startedAt),
      left.startedAt.getTime(),
      right.startedAt.getTime(),
    ),
    property("Service", left.serviceName ?? "—", right.serviceName ?? "—"),
    property(
      "Duration",
      formatDuration(left.durationMs),
      formatDuration(right.durationMs),
      left.durationMs,
      right.durationMs,
    ),
    property(
      "Loaded spans",
      formatCount(left.spanCount, "span"),
      formatCount(right.spanCount, "span"),
      left.spanCount,
      right.spanCount,
    ),
    {
      label: "Status",
      left: <TraceStatusBadge statusCode={left.statusCode} errorCount={left.errorCount} />,
      right: <TraceStatusBadge statusCode={right.statusCode} errorCount={right.errorCount} />,
      changed:
        traceStatusCode(left.statusCode, left.errorCount) !==
        traceStatusCode(right.statusCode, right.errorCount),
    },
    property(
      "Input tokens",
      formatTokens(left.inputTokens),
      formatTokens(right.inputTokens),
      left.inputTokens,
      right.inputTokens,
    ),
    property(
      "Output tokens",
      formatTokens(left.outputTokens),
      formatTokens(right.outputTokens),
      left.outputTokens,
      right.outputTokens,
    ),
    property(
      "Total tokens",
      formatTokens(left.totalTokens),
      formatTokens(right.totalTokens),
      left.totalTokens,
      right.totalTokens,
    ),
    property(
      "Estimated cost",
      formatCostUsd(left.costUsd),
      formatCostUsd(right.costUsd),
      left.costUsd,
      right.costUsd,
    ),
    property("Experiment", experimentLabel(left), experimentLabel(right)),
  ];
}

function property(
  label: string,
  left: string,
  right: string,
  leftComparable: unknown = left,
  rightComparable: unknown = right,
): ComparisonProperty {
  return {
    label,
    left,
    right,
    changed: !Object.is(leftComparable, rightComparable),
  };
}

function experimentLabel(trace: TraceComparisonSummary): string {
  return [trace.experimentName, trace.experimentArm].filter(Boolean).join(" / ") || "—";
}

function shortId(id: string): string {
  return `${id.slice(0, 10)}…${id.slice(-6)}`;
}
