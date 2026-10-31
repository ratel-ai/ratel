import { Bot, Search, Zap } from "lucide-react";
import type { KeyboardEvent } from "react";
import { journeyNodeAriaLabel } from "@/components/console/health/journey-copy";
import {
  JOURNEY_MAP_TOP,
  JOURNEY_RAIL_WIDTH,
} from "@/components/console/health/use-journey-scroll";
import {
  countText,
  JOURNEY_FONT,
  type JourneyLayout,
  type JourneyNode,
} from "@/lib/views/health/flow-journey-layout";

export interface JourneyStartRailProps {
  layout: JourneyLayout;
  visible: boolean;
  /** Turns of the traced set through each start chip, or null at rest. */
  lit: ReadonlyMap<string, number> | null;
  activeKey: string | null;
  onEnter: (node: JourneyNode) => void;
  onLeave: () => void;
  onActivate: (node: JourneyNode, viaKeyboard: boolean) => void;
}

/**
 * The start column, pinned at the left while the map is scrolled: each start
 * chip shrinks to its icon and count at the same height, so the reader always
 * sees where turns began, and can still point at one to trace it. The steps
 * scroll underneath and fade out against it.
 */
export function JourneyStartRail({
  layout,
  visible,
  lit,
  activeKey,
  onEnter,
  onLeave,
  onActivate,
}: JourneyStartRailProps) {
  const starts = layout.nodes.filter((node) => node.column === 0);
  const onKeyDown = (node: JourneyNode) => (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(node, true);
    }
  };
  return (
    <div
      data-journey-rail={visible ? "shown" : "hidden"}
      aria-hidden={!visible}
      className="pointer-events-none absolute inset-y-0 left-0 z-10 transition-opacity duration-200 motion-reduce:transition-none"
      style={{
        width: JOURNEY_RAIL_WIDTH + 28,
        // Level with the map, which sits under the scroller's top padding.
        paddingTop: JOURNEY_MAP_TOP,
        opacity: visible ? 1 : 0,
        background:
          "linear-gradient(to right, var(--ds-app) 0, var(--ds-app) 72%, transparent 100%)",
      }}
    >
      <svg width={JOURNEY_RAIL_WIDTH} height={layout.height} className="block select-none">
        <text x={14} y={14} fontSize={12} fill="var(--ds-fg-subtle)">
          Start
        </text>
        {starts.map((node) => {
          const Icon = node.kind === "search" ? Search : node.kind === "agent" ? Bot : Zap;
          const value = lit ? (lit.get(node.key) ?? 0) : node.turns;
          const active = activeKey === node.key;
          return (
            <g
              key={node.key}
              role="button"
              tabIndex={visible ? 0 : -1}
              aria-label={journeyNodeAriaLabel(node)}
              data-journey-rail-node={node.key}
              className={`cursor-pointer outline-none ${visible ? "pointer-events-auto" : ""}`}
              style={{ opacity: lit && value === 0 && !active ? 0.35 : 1 }}
              onPointerEnter={() => onEnter(node)}
              onPointerLeave={onLeave}
              onFocus={() => onEnter(node)}
              onBlur={onLeave}
              onClick={(event) => {
                event.stopPropagation();
                onActivate(node, false);
              }}
              onKeyDown={onKeyDown(node)}
            >
              <rect
                x={10}
                y={node.y}
                width={JOURNEY_RAIL_WIDTH - 14}
                height={node.h}
                rx={9}
                fill="var(--ds-raised)"
                stroke={active ? "var(--ds-fg)" : "var(--ds-line)"}
                strokeOpacity={active ? 0.75 : 1}
              />
              <Icon
                x={19}
                y={node.y + 6}
                width={12}
                height={12}
                color="var(--ds-fg-subtle)"
                strokeWidth={2}
              />
              <text
                x={19}
                y={node.y + 30}
                fontSize={lit ? JOURNEY_FONT : 10.5}
                fontWeight={lit ? 600 : 400}
                fill={lit ? "var(--ds-fg)" : "var(--ds-fg-muted)"}
                className="font-mono"
              >
                {lit && value === 0 ? "" : countText(value)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
