import { cn } from "@ratel/design-system/cn";
import Link from "next/link";
import type { ExperimentIssue, ExperimentIssueSeverity } from "@/lib/synthesis/experiments/types";
import {
  buildExperimentIssueCards,
  type ExperimentIssueCardContext,
} from "@/lib/synthesis/traces/experiment-issues";

const SEVERITY: Record<
  ExperimentIssueSeverity,
  {
    label: string;
    rail: string;
    badge: string;
    glyph: string;
  }
> = {
  error: {
    label: "Error",
    rail: "border-l-coral",
    badge: "border-coral/30 bg-coral/10 text-coral",
    glyph: "!",
  },
  warning: {
    label: "Watch",
    rail: "border-l-ctx-tools",
    badge: "border-ctx-tools/30 bg-ctx-tools/10 text-ctx-tools",
    glyph: "△",
  },
  info: {
    label: "Info",
    rail: "border-l-ctx-memory",
    badge: "border-ctx-memory/30 bg-ctx-memory/10 text-ctx-memory",
    glyph: "i",
  },
};

/**
 * Detector findings as a dense ledger rather than a card grid.
 *
 * A two-up grid of padded cards spent a screen on a handful of one-line facts,
 * and any odd number of findings left a visible hole in the layout. Rows sized
 * to their content read faster, never leave a gap, and keep the section short
 * enough that the comparison above it stays on screen.
 */
export function ExperimentIssuesPanel({
  issues,
  context,
}: {
  issues: readonly ExperimentIssue[];
  context: ExperimentIssueCardContext;
}) {
  const cards = buildExperimentIssueCards(issues, context);

  return (
    <section aria-labelledby="experiment-issues-title">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="eyebrow">Automatic checks</div>
          <h2
            id="experiment-issues-title"
            className="mt-1 font-display text-lg font-semibold tracking-tight text-cream"
          >
            Experiment issues
          </h2>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wide text-warm-muted">
          {cards.length} finding{cards.length === 1 ? "" : "s"}
        </span>
      </div>

      {cards.length === 0 ? (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-green/20 bg-green/[0.045] px-4 py-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-green/30 bg-green/10 font-mono text-xs text-green">
            ✓
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-cream">No threshold crossings</h3>
            <p className="mt-0.5 text-xs text-warm-muted">
              No detector fired for sample balance, errors, latency, or available capability
              evidence.
            </p>
          </div>
        </div>
      ) : (
        <ul className="card-enter mt-3 divide-y divide-forest-300/45 overflow-hidden rounded-xl border border-forest-300 bg-forest-600/35">
          {cards.map((card) => {
            const severity = SEVERITY[card.severity];
            return (
              <li
                key={`${card.kind}:${card.evidenceHref}:${card.detail}`}
                className={cn(
                  "flex min-w-0 items-start gap-3 border-l-2 px-3.5 py-2.5 transition-colors hover:bg-forest/25",
                  severity.rail,
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border font-mono text-[10px] font-semibold",
                    severity.badge,
                  )}
                  title={severity.label}
                  aria-hidden
                >
                  {severity.glyph}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <h3 className="text-xs font-medium text-cream">{card.title}</h3>
                    <span className="sr-only">{severity.label}. </span>
                    <p className="min-w-0 break-words text-[11px] leading-relaxed text-warm-muted [overflow-wrap:anywhere]">
                      {card.detail}
                    </p>
                  </div>
                </div>
                <Link
                  href={card.evidenceHref}
                  title={card.evidenceLabel}
                  className="mt-0.5 inline-flex min-h-5 shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-cream-dim transition-colors hover:text-coral"
                >
                  <span className="max-w-32 truncate sm:max-w-44">{card.evidenceLabel}</span>
                  <span aria-hidden>→</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
