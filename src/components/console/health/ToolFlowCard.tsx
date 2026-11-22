import { ArrowDownRight, X } from "lucide-react";
import type { CSSProperties, KeyboardEvent, MouseEvent, Ref } from "react";
import type { FlowFocusCopy } from "@/components/console/health/flow-copy";
import type { FlowLayout, FlowLayoutNode } from "@/lib/views/health/flow-layout";

export interface ToolFlowCardProps {
  node: FlowLayoutNode;
  layout: FlowLayout;
  copy: FlowFocusCopy;
  /** Pinned: it takes the pointer, names its problem link, and closes on Esc. */
  pinned: boolean;
  /** The DOM id of the tool's first signal card, when it has one. */
  anchor: string | null;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onClose?: () => void;
  cardRef?: Ref<HTMLDivElement>;
}

/**
 * The card for a tool in focus: its name, counts and paths. Hovering shows it
 * as a light tooltip; a click pins it, with the "Open problem" link to the
 * signal card behind the tool's colour.
 *
 * It hangs under the row, inside the row's own column: everything a tool
 * lights is in another column, so the card only ever covers dimmed rows and
 * never a lit ribbon or its count. Near the bottom it sits above the row.
 */
export function ToolFlowCard({
  node,
  layout,
  copy,
  pinned,
  anchor,
  onOpen,
  onClose,
  cardRef,
}: ToolFlowCardProps) {
  const search = node.kind === "search";
  const left = search ? node.x + node.r + 10 : node.x - node.r - 4;
  const below = search || node.y / layout.height < 0.62;
  const edge = search
    ? node.y - node.h / 2 + 24
    : node.y + (below ? 1 : -1) * (Math.max(node.r, 10) + 6);
  const flip = left / layout.width > 0.72;
  const style: CSSProperties = {
    left: flip ? undefined : `${(left / layout.width) * 100}%`,
    right: flip ? `${(1 - (node.labelEnd + 6) / layout.width) * 100}%` : undefined,
    top: `${(edge / layout.height) * 100}%`,
    transform: below ? undefined : "translateY(-100%)",
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose?.();
    }
  };
  return (
    <div
      ref={cardRef}
      role={pinned ? "dialog" : "tooltip"}
      aria-label={pinned ? copy.title : undefined}
      data-flow-card={pinned ? "pinned" : "hover"}
      tabIndex={pinned ? -1 : undefined}
      onKeyDown={pinned ? onKeyDown : undefined}
      onPointerDown={(event) => event.stopPropagation()}
      className={`absolute z-10 w-max max-w-60 rounded-md border bg-forest-600 px-2.5 py-1.5 text-xs text-cream shadow-[0_12px_30px_-12px_rgba(0,0,0,0.8)] outline-none ${
        pinned ? "pointer-events-auto border-cream-dim/40" : "pointer-events-none border-forest-300"
      }`}
      style={style}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="break-all font-mono text-[11px] text-cream">{copy.title}</div>
        {pinned && (
          <button
            type="button"
            aria-label="Clear focus"
            onClick={onClose}
            className="-mr-1 rounded p-0.5 text-warm-muted hover:text-cream focus-visible:outline focus-visible:outline-coral"
          >
            <X aria-hidden className="size-3" />
          </button>
        )}
      </div>
      {copy.lines.map((line) => (
        <div key={line} className="text-cream-dim">
          {line}
        </div>
      ))}
      {copy.meaning && <div className="text-warm-muted">{copy.meaning}</div>}
      {pinned && anchor && (
        <a
          href={`#${anchor}`}
          onClick={onOpen}
          data-flow-open={anchor}
          className="mt-1 inline-flex items-center gap-1 text-coral hover:underline focus-visible:outline focus-visible:outline-coral"
        >
          Open problem
          <ArrowDownRight aria-hidden className="size-3" />
        </a>
      )}
      {!pinned && node.kind !== "more" && (
        <div className="mt-0.5 text-warm-muted">
          {anchor ? "Click to pin and open its problem" : "Click to pin"}
        </div>
      )}
    </div>
  );
}
