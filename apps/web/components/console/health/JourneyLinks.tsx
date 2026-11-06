import type {
  JourneyCrossLink,
  JourneyDivider,
  JourneyFocus,
} from "@/lib/views/health/flow-journey-layout";

/**
 * Direct links between two tools called in different turns, in the packed
 * prerequisites view: dashed, so they never read as a turn's own ribbon, as
 * wide as the uses behind them, with an arrowhead at the tool that needed the
 * other. A "usually" pair is drawn lighter than an "almost always" one.
 */
export interface JourneyLinksProps {
  links: readonly JourneyCrossLink[];
  /** What is lit, or null at rest; a link is lit when the focus names it. */
  focus: JourneyFocus | null;
  /** `first>tool` keys of the "usually" pairs. */
  usual: ReadonlySet<string>;
  /** Fading out, on the way back to the whole map. */
  fading?: boolean;
}

/** A thin rule with a small title, between the packed journey and the rows of pairs under it. */
export function JourneyDividers({
  dividers,
  width,
  fading = false,
}: {
  dividers: readonly JourneyDivider[];
  width: number;
  fading?: boolean;
}) {
  return (
    <g
      aria-hidden
      data-journey-dividers="true"
      style={{ opacity: fading ? 0 : 1 }}
      className="flow-dim"
    >
      {dividers.map((divider) => (
        <g key={divider.y} data-journey-divider={divider.title}>
          <line
            x1={12}
            x2={width - 12}
            y1={divider.y}
            y2={divider.y}
            stroke="var(--ds-line)"
            strokeOpacity={0.7}
          />
          <text x={14} y={divider.y + 14} fontSize={12} fill="var(--ds-fg-subtle)">
            {divider.title}
          </text>
        </g>
      ))}
    </g>
  );
}

export function JourneyLinks({ links, focus, usual, fading = false }: JourneyLinksProps) {
  return (
    <g
      aria-hidden
      data-journey-links="true"
      style={{ opacity: fading ? 0 : 1 }}
      className="flow-dim"
    >
      {links.map((link) => {
        const lit = focus ? (focus.ribbons.get(link.key) ?? 0) > 0 : false;
        const light = usual.has(link.relationKey);
        const opacity = focus ? (lit ? 0.95 : 0.15) : light ? 0.5 : 0.8;
        const colour = lit ? "var(--ds-fg)" : "var(--ds-fg-muted)";
        return (
          <g
            key={link.key}
            data-journey-link={link.key}
            data-journey-link-tier={light ? "usual" : "strong"}
            data-journey-link-turns={link.crossTurn ? "across" : "same"}
          >
            <path
              d={link.path}
              fill="none"
              stroke={colour}
              strokeOpacity={opacity}
              strokeWidth={link.width}
              strokeDasharray={link.crossTurn ? "6 4" : undefined}
              strokeLinecap="butt"
            />
            <path d={link.head} fill={colour} fillOpacity={opacity} />
          </g>
        );
      })}
    </g>
  );
}
