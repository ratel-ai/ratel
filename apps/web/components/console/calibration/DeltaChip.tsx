import { cn } from "@ratel/design-system/cn";
import type { MetricDelta } from "@/lib/synthesis/experiments/types";

export type DeltaDisplay = "relative" | "percentage-points" | "absolute";

export function DeltaChip({
  delta,
  display = "relative",
  lowerIsBetter = true,
}: {
  delta: MetricDelta | null;
  display?: DeltaDisplay;
  lowerIsBetter?: boolean | null;
}) {
  const value = deltaValue(delta, display);
  if (value === null) {
    if (delta && display === "relative" && delta.absolute !== 0) {
      return (
        <span
          className="inline-flex rounded-md border border-indigo-300/25 bg-indigo-300/10 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300"
          title="Baseline was zero; relative change is undefined"
        >
          new
        </span>
      );
    }
    return (
      <span className="font-mono text-[10px] uppercase tracking-wide text-warm-muted/55">
        unknown
      </span>
    );
  }
  if (Math.abs(value) < Number.EPSILON) {
    return (
      <span className="inline-flex rounded-md bg-forest/55 px-1.5 py-0.5 font-mono text-[10px] text-warm-muted">
        → 0<span className="sr-only"> unchanged</span>
      </span>
    );
  }

  const improved = lowerIsBetter === null ? null : lowerIsBetter ? value < 0 : value > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5",
        "font-mono text-[10px] font-medium tabular-nums",
        improved === null
          ? "border-indigo-300/25 bg-indigo-300/10 text-indigo-300"
          : improved
            ? "border-green/25 bg-green/10 text-green"
            : "border-coral/25 bg-coral/10 text-coral",
      )}
      title={`${formatDelta(value, display)} versus baseline${
        improved === null ? "" : improved ? " (improved)" : " (regressed)"
      }`}
    >
      <span aria-hidden>{value > 0 ? "↑" : "↓"}</span>
      {formatDelta(value, display)}
      <span className="sr-only">
        {improved === null ? " changed" : improved ? " improved" : " regressed"}
      </span>
    </span>
  );
}

function deltaValue(delta: MetricDelta | null, display: DeltaDisplay): number | null {
  if (!delta) return null;
  if (display !== "relative") return delta.absolute;
  return delta.relative ?? (delta.absolute === 0 ? 0 : null);
}

function formatDelta(value: number, display: DeltaDisplay): string {
  const sign = value > 0 ? "+" : "−";
  const magnitude = Math.abs(value);
  if (display === "percentage-points") {
    return `${sign}${decimal(magnitude * 100)}pp`;
  }
  if (display === "relative") {
    return `${sign}${decimal(magnitude * 100)}%`;
  }
  return `${sign}${decimal(magnitude)}`;
}

function decimal(value: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: value < 1 ? 2 : 1,
  });
}
