"use client";

import { cn } from "@ratel/design-system/cn";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SelectionRankingDiff } from "@/components/console/calibration/SelectionRankingDiff";
import type { RankingComparisonRowView } from "@/lib/synthesis/experiments/calibration-types";
import type { MetricDelta } from "@/lib/synthesis/experiments/types";
import { latencyDelta, outcomeTone } from "@/lib/synthesis/traces/calibration-view";
import { formatDuration, formatTimestamp } from "@/lib/synthesis/traces/format";

const TONE_DOT = {
  ok: "bg-green",
  warn: "bg-ctx-tools",
  error: "bg-coral",
  muted: "bg-warm-muted/50",
} as const;
export const COMPARISON_ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 lg:grid-cols-[8rem_minmax(13rem,1.2fr)_minmax(11rem,1fr)_minmax(11rem,1fr)_minmax(10rem,auto)_minmax(12rem,auto)_2rem]";

/**
 * One compact disagreement row with its full ranking diff inline on demand.
 *
 * Open state is owned by the browser above, not by the row, so only one row is
 * expanded at a time. A list where every row you have ever clicked is still
 * open stops being a list. The disclosure uses the house `.disclosure` class,
 * which height-interpolates `::details-content` instead of snapping.
 */
export function ComparisonRow({
  row,
  index,
  href,
  playgroundHref,
  animate,
  open,
  onToggle,
}: {
  row: RankingComparisonRowView;
  index: number;
  href: string | null;
  /** Null when the Playground is not enabled for this account. */
  playgroundHref?: string | null;
  animate: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const delta = latencyDelta(row.servedDurationMs, row.shadowDurationMs);
  const rowClasses = cn("disclosure group", animate && "card-enter");
  const style = animate ? { animationDelay: `${Math.min(index, 12) * 50}ms` } : undefined;

  return (
    <details
      className={rowClasses}
      style={style}
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary
        className={cn(
          COMPARISON_ROW_GRID,
          "cursor-pointer list-none py-3 transition-colors hover:bg-forest/25 group-open:bg-forest/20 [&::-webkit-details-marker]:hidden",
        )}
      >
        <div className="min-w-0 font-mono text-[11px] tabular-nums text-warm-muted">
          <MobileLabel>When</MobileLabel>
          {formatTimestamp(row.occurredAt, "compact")}
        </div>

        <div className="min-w-0">
          <MobileLabel>Query</MobileLabel>
          {playgroundHref && row.query ? (
            <SummaryLink
              href={playgroundHref}
              title={`Test “${row.query}” in the Playground`}
              className="line-clamp-2 text-left text-sm leading-snug text-cream decoration-indigo-300/50 underline-offset-4 hover:text-indigo-300 hover:underline"
            >
              {row.query}
            </SummaryLink>
          ) : (
            <p
              className={cn(
                "line-clamp-2 text-sm leading-snug",
                row.query === null ? "italic text-warm-muted/60" : "text-cream",
              )}
              title={row.query ?? "Query unavailable"}
            >
              {row.query ?? "Query unavailable"}
            </p>
          )}
        </div>

        <TopResult
          label="Served top-1"
          arm={row.servedArm}
          resultId={row.servedResultIds?.[0] ?? null}
          tone="served"
        />
        <TopResult
          label="Shadow top-1"
          arm={row.shadowArm}
          resultId={row.shadowResultIds?.[0] ?? null}
          tone="shadow"
        />

        <div className="min-w-0">
          <MobileLabel>Changes</MobileLabel>
          <DiffSummaryChips row={row} />
        </div>

        <div className="min-w-0">
          <MobileLabel>Latency</MobileLabel>
          <LatencyDelta
            delta={delta}
            servedMs={row.servedDurationMs}
            shadowMs={row.shadowDurationMs}
          />
        </div>

        <ChevronDown
          className="size-4 justify-self-end text-warm-muted transition-transform duration-200 group-open:rotate-180 group-open:text-indigo-300"
          strokeWidth={1.75}
          aria-hidden
        />
      </summary>

      <div
        data-comparison-detail
        className="border-t border-forest-300/60 bg-base-deep/25 px-4 py-4 sm:px-5"
      >
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="eyebrow">Ranking detail</div>
            <h3 className="mt-1 break-words text-sm font-medium text-cream">
              {row.query ?? "Query unavailable"}
            </h3>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <OutcomeBadge arm={row.servedArm} outcome={row.servedOutcome} />
            <OutcomeBadge arm={row.shadowArm} outcome={row.shadowOutcome} />
            <span className="rounded-md border border-forest-300 bg-forest/35 px-2 py-1 font-mono text-[10px] text-cream-dim">
              k={row.agreementK ?? "—"}
            </span>
          </div>
        </div>

        <SelectionRankingDiff
          servedArm={row.servedArm}
          shadowArm={row.shadowArm}
          servedResultIds={row.servedResultIds}
          shadowResultIds={row.shadowResultIds}
          servedResultScores={row.servedResultScores}
          shadowResultScores={row.shadowResultScores}
        />

        {(href || playgroundHref) && (
          <div className="mt-3 flex flex-wrap justify-end gap-4">
            {playgroundHref && (
              <Link
                href={playgroundHref}
                title="Test this query against the live catalog and try different descriptions"
                className="font-mono text-xs text-warm-muted transition-colors hover:text-indigo-300"
              >
                test in playground →
              </Link>
            )}
            {href && (
              <Link
                href={href}
                className="font-mono text-xs text-warm-muted transition-colors hover:text-indigo-300"
              >
                inspect →
              </Link>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

/**
 * A link that lives inside a `<summary>`.
 *
 * Clicking anywhere in a summary toggles its `<details>`, which is the element's
 * default action, and it fires whether or not the click landed on a nested
 * link, so a plain `<Link>` here would both navigate and expand the row.
 * Cancelling the default kills the toggle AND the navigation, so the navigation
 * is done by hand. Modified clicks are left alone: those open a new tab
 * natively, and expanding the row behind it is harmless.
 */
function SummaryLink({
  href,
  title,
  className,
  children,
}: {
  href: string;
  title: string;
  className: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <Link
      href={href}
      title={title}
      className={className}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        ) {
          return;
        }
        event.preventDefault();
        router.push(href);
      }}
    >
      {children}
    </Link>
  );
}

function MobileLabel({ children }: { children: string }) {
  return (
    <span className="mb-1 block font-mono text-[9px] uppercase tracking-[0.1em] text-warm-muted lg:hidden">
      {children}
    </span>
  );
}

function TopResult({
  label,
  arm,
  resultId,
  tone,
}: {
  label: string;
  arm: string | null;
  resultId: string | null;
  tone: "served" | "shadow";
}) {
  return (
    <div className="min-w-0">
      <MobileLabel>{label}</MobileLabel>
      <div
        className={cn(
          "mb-1 truncate font-mono text-[9px] uppercase tracking-[0.08em]",
          tone === "served" ? "text-coral" : "text-indigo-300",
        )}
        title={arm ?? undefined}
      >
        {arm ?? tone}
      </div>
      <code
        className={cn(
          "block truncate rounded-md bg-base-deep/45 px-1.5 py-1 font-mono text-xs",
          resultId === null ? "italic text-warm-muted/50" : "text-cream-dim",
        )}
        title={resultId ?? "Top result unavailable"}
      >
        {resultId ?? "not exported"}
      </code>
    </div>
  );
}

/**
 * The ranking change as signed counts: `+1` gained, `−2` lost, `↕3` reordered.
 *
 * These were bordered, tinted pills reading "1 added" / "2 dropped", which is a
 * lot of furniture for three small numbers in a dense row. Sign and colour
 * already carry the direction, so the words and the boxes were both redundant;
 * the full phrasing stays in the title for anyone who needs it.
 */
function DiffSummaryChips({ row }: { row: RankingComparisonRowView }) {
  if (!row.diffSummary) {
    return <span className="font-mono text-[10px] text-warm-muted/60">rankings not exported</span>;
  }
  const { moved, dropped, added } = row.diffSummary;
  if (moved + dropped + added === 0) {
    return <span className="font-mono text-[10px] text-warm-muted">identical lists</span>;
  }
  return (
    <div
      className="flex flex-wrap items-baseline gap-2 font-mono text-xs tabular-nums"
      title={[
        moved > 0 && `${moved} reordered`,
        dropped > 0 && `${dropped} dropped by the shadow arm`,
        added > 0 && `${added} added by the shadow arm`,
      ]
        .filter(Boolean)
        .join(", ")}
    >
      {added > 0 && <span className="text-green">+{added}</span>}
      {dropped > 0 && <span className="text-coral">−{dropped}</span>}
      {moved > 0 && <span className="text-indigo-300">↕{moved}</span>}
    </div>
  );
}

/**
 * How much slower or faster the shadow arm was: the difference alone.
 *
 * This was "812ms → 36ms" plus a tinted delta chip: three numbers and a box to
 * answer one question. The pair is what the reader has to subtract themselves,
 * so the subtraction is done here and the raw timings move to the title.
 * Coral for slower, green for faster, sign and colour and nothing else.
 */
function LatencyDelta({
  delta,
  servedMs,
  shadowMs,
}: {
  delta: MetricDelta | null;
  servedMs: number | null;
  shadowMs: number | null;
}) {
  if (!delta) {
    return <span className="font-mono text-xs text-warm-muted/60">—</span>;
  }
  if (delta.absolute === 0) {
    return <span className="font-mono text-xs tabular-nums text-warm-muted">no change</span>;
  }
  const slower = delta.absolute > 0;
  return (
    <span
      className={cn("font-mono text-xs tabular-nums", slower ? "text-coral" : "text-green")}
      title={`shadow ${formatMs(shadowMs)} vs served ${formatMs(servedMs)}`}
    >
      {slower ? "+" : "−"}
      {formatDuration(Math.abs(delta.absolute))}
      <span className="sr-only">{slower ? " slower" : " faster"}</span>
    </span>
  );
}

function OutcomeBadge({ arm, outcome }: { arm: string | null; outcome: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-forest-300 bg-forest/35 px-2 py-1 font-mono text-[10px] text-warm-muted">
      <span className={cn("size-1.5 rounded-full", TONE_DOT[outcomeTone(outcome)])} aria-hidden />
      {arm ?? "arm"} · {outcome ?? "—"}
    </span>
  );
}

function formatMs(value: number | null): string {
  return value === null ? "—" : formatDuration(value);
}
