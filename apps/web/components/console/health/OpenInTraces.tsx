import { cn } from "@ratel/design-system/cn";
import { SquareArrowOutUpRight } from "lucide-react";
import Link from "next/link";
import {
  type EvidenceTurn,
  exampleFocusEventId,
  turnTracesHref,
} from "@/lib/readings/trace-signals/view";

/** The small outlined button look shared by the workflow row's two actions. */
export const TRACES_BUTTON =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-forest-300 bg-base-deep/50 px-3 py-1.5 text-[13px] font-medium text-cream outline-none transition-colors hover:border-warm-muted/50 hover:bg-forest focus-visible:ring-2 focus-visible:ring-coral/60";

/**
 * "Open in Traces": an example turn's calls in Traces, one by one, with the
 * call the example is about ringed and scrolled to. A real link (same tab,
 * keyboard reachable), never a button. Every example has one, because every
 * example is a turn the ledger kept; the turn page resolves it for declared,
 * inferred and OTLP turns alike.
 */
export function OpenInTraces({
  projectId,
  turn,
  focusEventId,
  compact = false,
  label,
  variant = "link",
  className,
}: {
  projectId: string;
  turn: Pick<EvidenceTurn, "turnId" | "steps">;
  /** The call to ring, when the caller knows it without steps (a workflow's example run); else the flagged step's. */
  focusEventId?: string | null;
  /** On a phone-width row: "Traces" beside the icon, the rest for screen readers. */
  compact?: boolean;
  /** Link text in place of "Open in Traces", e.g. "Open a failed run". */
  label?: string;
  /** `button`: drawn as a small outlined button (a workflow's "Open a failed run"); still a link. */
  variant?: "link" | "button";
  className?: string;
}) {
  return (
    <Link
      href={turnTracesHref(
        projectId,
        turn.turnId,
        focusEventId !== undefined ? focusEventId : exampleFocusEventId(turn),
      )}
      data-open-in-traces={turn.turnId}
      className={cn(
        variant === "button"
          ? TRACES_BUTTON
          : "inline-flex items-center gap-1 whitespace-nowrap rounded text-[12px] text-warm-muted outline-none transition-colors hover:text-cream focus-visible:ring-2 focus-visible:ring-coral/60",
        className,
      )}
    >
      <SquareArrowOutUpRight className="size-3 shrink-0" aria-hidden />
      {label ? (
        label
      ) : compact ? (
        <>
          <span className="sm:hidden">
            <span className="sr-only">Open in </span>Traces
          </span>
          <span className="hidden sm:inline">Open in Traces</span>
        </>
      ) : (
        "Open in Traces"
      )}
    </Link>
  );
}
