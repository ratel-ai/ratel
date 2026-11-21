import { Badge } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import type { ReactNode } from "react";
import { Sparkline } from "@/components/console/health/primitives/Sparkline";
import type { RangePreset } from "@/lib/synthesis/dashboard";
import { formatPercent } from "@/lib/synthesis/traces/v2/format";
import type { McpStatus } from "@/lib/views/project-entities/mcp-model";

/**
 * The small marks the Agents and MCP servers pages share (the approved RP-25 design): a trend
 * line, a share bar, an error-rate bar, the error pill and the MCP status chip.
 */

/** The window and environment filters both pages keep in the URL. */
export type EntityFilterState = {
  environments: readonly string[];
  environment: string | null;
  range: { preset: RangePreset | "custom"; from: string; to: string };
};

const STATUS_TONE = { failing: "danger", degraded: "warning", healthy: "success" } as const;

/** Runs or calls per day, as a quiet line. */
export function Trend({
  values,
  tone = "neutral",
  width = 64,
}: {
  values: readonly number[];
  tone?: "neutral" | "danger" | "accent";
  width?: number;
}) {
  const color =
    tone === "danger"
      ? "var(--color-danger)"
      : tone === "accent"
        ? "var(--color-info)"
        : "var(--color-fg-subtle)";
  return <Sparkline data={[...values]} color={color} width={width} height={20} />;
}

/** A share of a whole as a short bar. */
export function ShareMeter({
  share,
  tone = "accent",
  className,
}: {
  share: number;
  tone?: "accent" | "danger" | "warning" | "neutral";
  className?: string;
}) {
  const fill =
    tone === "danger"
      ? "bg-danger"
      : tone === "warning"
        ? "bg-warning"
        : tone === "neutral"
          ? "bg-fg-faint"
          : "bg-info";
  const width = share > 0 ? Math.max(4, Math.min(100, share * 100)) : 0;
  return (
    <span
      aria-hidden
      className={cn("inline-block h-1.5 w-12 overflow-hidden rounded-full bg-line", className)}
    >
      <span className={cn("block h-full rounded-full", fill)} style={{ width: `${width}%` }} />
    </span>
  );
}

/** An error rate with its bar, red at failing, amber at degraded. */
export function ErrorRate({ rate, status }: { rate: number; status: McpStatus }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="tabular-nums">{formatPercent(rate)}</span>
      <ShareMeter
        share={rate}
        tone={status === "failing" ? "danger" : status === "degraded" ? "warning" : "neutral"}
      />
    </span>
  );
}

/** The MCP server's status as a chip: the word, never the color alone. */
export function StatusChip({ status }: { status: McpStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{status}</Badge>;
}

/** The agent's error rate: a red pill past the threshold, a quiet dot and the rate below it. */
export function ErrorPill({ rate, failed, pill }: { rate: number; failed: number; pill: boolean }) {
  if (pill) {
    return (
      <Badge tone="danger">
        {formatPercent(rate)} · {failed} failed
      </Badge>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums text-fg">
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", rate > 0 ? "bg-warning" : "bg-success")}
      />
      {formatPercent(rate)}
    </span>
  );
}

/** A KPI's number or line in the danger or warning color (StatRow draws them in the base color). */
export function Toned({
  tone,
  mono = false,
  children,
}: {
  tone?: "danger" | "warning";
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        mono && "font-mono",
        tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : undefined,
      )}
    >
      {children}
    </span>
  );
}
