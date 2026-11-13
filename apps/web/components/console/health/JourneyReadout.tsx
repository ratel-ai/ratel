import { ArrowDownRight, X } from "lucide-react";
import type { MouseEvent } from "react";
import {
  JOURNEY_IDLE_HINT,
  JOURNEY_IDLE_HINT_TOUCH,
  journeyReadout,
} from "@/components/console/health/journey-copy";
import { STATE_COLOR } from "@/components/console/health/ToolJourneyParts";
import type {
  JourneyFocus,
  JourneyLayout,
  JourneyNode,
} from "@/lib/views/health/flow-journey-layout";

/** The readout's state words take the colour of the worst state the node shows. */
function meaningColor(node: JourneyNode): string {
  if (node.tint !== "none" && node.tint !== "dead") return STATE_COLOR[node.tint];
  return node.flags.includes("errors") ? STATE_COLOR.magnet : STATE_COLOR.buried;
}

export interface JourneyReadoutProps {
  layout: JourneyLayout;
  node: JourneyNode | null;
  focus: JourneyFocus | null;
  pinned: boolean;
  anchor: string | null;
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
  onClose: () => void;
}

/** The sentences for what is lit, in one fixed place under the drawing, so nothing floats over the map. */
export function JourneyReadout({
  layout,
  node,
  focus,
  pinned,
  anchor,
  onOpen,
  onClose,
}: JourneyReadoutProps) {
  if (!node || !focus) {
    return (
      <p
        data-journey-readout="idle"
        aria-live="polite"
        className="mt-2.5 min-h-10 text-xs leading-5 text-fg-subtle"
      >
        <span className="hidden sm:inline">{JOURNEY_IDLE_HINT}</span>
        <span className="sm:hidden">{JOURNEY_IDLE_HINT_TOUCH}</span>
      </p>
    );
  }
  const copy = journeyReadout(node, layout, focus);
  return (
    <div
      data-journey-readout={pinned ? "pinned" : "hover"}
      aria-live="polite"
      className="mt-2.5 flex min-h-10 items-start justify-between gap-3 text-xs leading-5"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="break-all font-mono text-xs text-fg">{copy.title}</span>
          {copy.place && <span className="text-xs text-fg-subtle">{copy.place}</span>}
          {copy.meaning && (
            <span style={{ color: meaningColor(node) }} className="text-xs">
              {copy.meaning}
            </span>
          )}
        </div>
        <div className="text-fg-muted">
          {copy.lines.map((line, i) => (
            <span key={line}>
              {i > 0 && <span className="px-1.5 text-fg-subtle">·</span>}
              {line}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {pinned && anchor && (
          <a
            href={`#${anchor}`}
            onClick={onOpen}
            data-flow-open={anchor}
            className="inline-flex items-center gap-1 text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg-muted focus-visible:outline focus-visible:outline-focus"
          >
            Open issue
            <ArrowDownRight aria-hidden className="size-3" />
          </a>
        )}
        {!pinned && <span className="hidden text-fg-subtle sm:inline">Click to keep it lit</span>}
        {pinned && (
          <button
            type="button"
            aria-label="Clear focus"
            onClick={onClose}
            className="rounded p-0.5 text-fg-subtle hover:text-fg focus-visible:outline focus-visible:outline-focus"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
