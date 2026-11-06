import { CircleX, Flag, type LucideIcon, Timer, Wrench } from "lucide-react";
import { FAMILY_COLORS } from "@/components/console/health/ToolJourneyParts";

/**
 * A tiny key under the journey. The map should read without it (icons and
 * colours carry their own meaning); this only confirms what a reader guessed.
 */

const STATES: readonly { Icon: LucideIcon; color: string; text: string }[] = [
  { Icon: Wrench, color: "var(--ds-danger)", text: "Listed often, rarely picked" },
  { Icon: Wrench, color: "var(--ds-warning)", text: "Picked from far down" },
  { Icon: Wrench, color: "var(--ds-success)", text: "Healthy" },
  { Icon: CircleX, color: "var(--ds-danger)", text: "Failing" },
  { Icon: Timer, color: "var(--ds-warning)", text: "Slow" },
];

function Families() {
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${FAMILY_COLORS.length * 6} 8`}
      className="h-2 shrink-0"
      style={{ width: FAMILY_COLORS.length * 6 }}
    >
      {FAMILY_COLORS.map((color, i) => (
        <rect
          key={color}
          x={i * 6}
          y={0}
          width={4}
          height={8}
          rx={1}
          fill={color}
          fillOpacity={0.85}
        />
      ))}
    </svg>
  );
}

export function ToolJourneyLegend() {
  return (
    <div
      data-journey-legend="true"
      className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-warm-muted"
    >
      <span className="inline-flex items-center gap-1.5">
        <Families />
        Colour follows the first tool
      </span>
      <span className="inline-flex items-center gap-1">
        <Flag aria-hidden className="size-2.5" />
        Ended
      </span>
      {STATES.map(({ Icon, color, text }) => (
        <span key={text} className="inline-flex items-center gap-1">
          <Icon aria-hidden className="size-2.5" style={{ color }} />
          {text}
        </span>
      ))}
    </div>
  );
}
