import { ArrowRight, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { signalAnchorId } from "@/components/console/health/anchors";
import { SeverityKey } from "@/components/console/health/kinds";
import { groupByKind, toolCount } from "@/components/console/health/problem-groups";
import { OpenSignalProvider } from "@/components/console/health/SignalCard";
import { SignalGroups, TooEarlyRows } from "@/components/console/health/SignalGroups";
import { DismissedLine } from "@/components/console/health/SlowByDesign";
import type { DismissedSignal } from "@/lib/readings/trace-signals/dismiss";
import type { SignalView } from "@/lib/readings/trace-signals/view";
import { sortSignals, TONE_LABELS, UPGRADE_HREF } from "@/lib/views/health/card-model";
import type { ChainFolding } from "@/lib/views/health/workflows-view";

export { signalAnchorId };

export interface SignalListProps {
  projectId: string;
  /** Signals above their floor, worst first, already cut to the plan. */
  signals: readonly SignalView[];
  /** Signals seen but not yet confident, folded under "Too early to call". */
  tooEarly: readonly SignalView[];
  /** Signals the plan hides; renders the "+N more signals on Plus" line when > 0. */
  lockedCount: number;
  /** Evidence turns each card may show; 0 turns the examples into an upsell. */
  evidenceTurnsPerSignal: number;
  /**
   * The span the signals were computed over, e.g. "last 22 days", when it
   * differs from the selected window (`runWindowLabel`); null hides it.
   */
  windowLabel?: string | null;
  /** Chains folded under the workflow they lie inside ("3 chains inside Close out a release"). */
  folding?: ChainFolding;
  /** The public copy: the plan's hidden count reads as a plain note, with no link to plans. */
  shared?: boolean;
  /** Slow-tool problems hidden as slow by design, listed with "Show again". */
  dismissed?: readonly DismissedSignal[];
}

/**
 * The problem list, built for scanning: a header with the count and what the
 * two dot colours mean, then the problems in plain areas ("Picking the wrong
 * tool", "Reliability", "Speed", "Catalog clean-up"), worst first. Only the
 * five worst show until the reader asks for the rest. After them the plan's
 * "+N more" line, then the ones still too early to call, folded away.
 */
export function SignalList({
  projectId,
  signals,
  tooEarly,
  lockedCount,
  evidenceTurnsPerSignal,
  windowLabel = null,
  folding,
  shared = false,
  dismissed = [],
}: SignalListProps) {
  const early = sortSignals(tooEarly);
  // One row per kind of problem; the header counts rows and the tools they
  // name. What the plan hides is counted in signals on its own line below.
  const total = groupByKind(signals, folding).length;
  const tools = toolCount(signals);

  return (
    <section
      aria-labelledby="signals-heading"
      data-signal-list="true"
      className="flex scroll-mt-24 flex-col gap-4 pb-10"
    >
      {/* One provider over the main rows and the too-early ones, so opening any
          problem closes whichever was open. */}
      <OpenSignalProvider>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 px-3 sm:px-4">
          <div>
            <h2 id="signals-heading" className="font-display text-lg font-semibold text-cream">
              Issues
              {windowLabel && (
                <span className="font-normal text-warm-muted" data-signal-window={windowLabel}>
                  {" "}
                  · {windowLabel}
                </span>
              )}
            </h2>
            {total > 0 && (
              <p className="mt-0.5 text-[13px] text-warm-muted" data-signal-total={total}>
                {total} {total === 1 ? "problem" : "problems"}
                {tools > 0 && ` across ${tools} ${tools === 1 ? "tool" : "tools"}`}, worst first
              </p>
            )}
          </div>
          {signals.length > 0 && (
            <p className="flex items-center gap-4 text-[12px] text-warm-muted" aria-hidden>
              <span className="inline-flex items-center gap-1.5">
                <SeverityKey tone="coral" />
                {TONE_LABELS.coral}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <SeverityKey tone="amber" />
                {TONE_LABELS.amber}
              </span>
            </p>
          )}
        </div>

        {signals.length === 0 && (
          <p className="px-3 text-sm text-warm-muted sm:px-4">
            Nothing has cleared its floor {windowLabel ? `in the ${windowLabel}` : "in this window"}
            .
          </p>
        )}

        {signals.length > 0 && (
          <SignalGroups
            projectId={projectId}
            signals={signals}
            evidenceTurnsPerSignal={evidenceTurnsPerSignal}
            folding={folding}
          />
        )}

        {lockedCount > 0 && <LockedLine count={lockedCount} shared={shared} />}

        {!shared && <DismissedLine projectId={projectId} dismissed={dismissed} />}

        {early.length > 0 && (
          <TooEarlyRows
            projectId={projectId}
            signals={early}
            evidenceTurnsPerSignal={evidenceTurnsPerSignal}
          />
        )}
      </OpenSignalProvider>
    </section>
  );
}

/**
 * What the plan hides, as one quiet line: a count and a link. Not the full
 * paywall; the free plan already sees the whole picture above.
 */
function LockedLine({ count, shared }: { count: number; shared: boolean }) {
  if (shared) {
    return (
      <p data-signals-locked={count} className="mx-3 px-4 text-sm text-warm-muted sm:mx-4">
        +{count} more {count === 1 ? "problem" : "problems"} not shown here.
      </p>
    );
  }
  return (
    <div
      data-signals-locked={count}
      className="mx-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-forest-600/40 px-4 py-3 sm:mx-4"
    >
      <p className="flex items-center gap-2 text-sm text-cream-dim">
        <LockKeyhole className="size-3.5 text-warm-muted" aria-hidden />
        <span>
          <span className="font-medium text-cream">+{count} more signals on Plus</span>
          <span className="text-warm-muted"> · every problem, with example turns</span>
        </span>
      </p>
      <Link
        href={UPGRADE_HREF}
        className="inline-flex items-center gap-1 rounded text-[13px] text-cream-dim outline-none transition-colors hover:text-cream focus-visible:ring-2 focus-visible:ring-coral/60"
      >
        See plans
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}
