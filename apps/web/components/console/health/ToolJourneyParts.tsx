import {
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  CircleX,
  Flag,
  Layers,
  type LucideIcon,
  Search,
  Timer,
  UnfoldHorizontal,
  Wrench,
  Zap,
} from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type MouseEvent, memo } from "react";
import { expandLabel, journeyNodeAriaLabel } from "@/components/console/health/journey-copy";
import type { FlowTint } from "@/lib/readings/trace-signals/view";
import {
  chipCard,
  countText,
  JOURNEY_CHIP,
  JOURNEY_ENDED_FAMILY,
  JOURNEY_FONT,
  type JourneyColumn,
  type JourneyFocus,
  type JourneyNode,
  type JourneyNodeKind,
  type JourneyRibbon,
  ribbonBand,
  toolIdOf,
} from "@/lib/views/health/flow-journey-layout";

/**
 * The journey map's marks: column titles, ribbons, and chips. A chip holds
 * everything a step says (icon, name, count, a share bar, problem icons), and
 * ribbons only run between chips, so no text ever sits on a ribbon. Stateless;
 * `ToolJourneyCanvas` decides what is lit.
 *
 * Colour has two jobs that never overlap. Ribbons take a family colour so a
 * path can be followed. State colours are only ever on an icon: red for
 * trouble, amber for worth a look, green for healthy, and grey for quiet or
 * ended.
 *
 * Three chips are not tools, and each has its own shape so it reads without a
 * legend, all quieter than a tool: "Ended" is a short grey tab with a solid
 * end cap (the path stops here), "More calls" points right with a dashed edge
 * (the path goes on), "+N tools" is a dashed stack of cards (a group), and
 * "Later" is a solid stack (later calls folded away, open them).
 */

/**
 * The eight family colours, in slot order: blue, olive, violet, cyan,
 * magenta, azure, crimson, orchid. Picked in OKLCH for the dark canvas (L
 * 0.52 to 0.66) and checked with the dataviz validator: lightness band, chroma
 * floor, colour-blind separation of neighbours (worst 11.6) and normal-vision
 * separation (worst 15.5) all pass, and every one clears 3:1 on the canvas.
 * Hues sit away from red, amber and green, which only ever mark state.
 */
export const FAMILY_COLORS: readonly string[] = [
  "#3a81d7",
  "#9d9631",
  "#794db6",
  "#00a7af",
  "#ab3f84",
  "#379ecc",
  "#af3d60",
  "#af70bd",
];
export const FAMILY_GREY = "var(--ds-fg-subtle)";

export function familyColor(family: number): string {
  return FAMILY_COLORS[family] ?? FAMILY_GREY;
}

/** State colours, for icons only. */
export const STATE_COLOR: Record<FlowTint, string> = {
  magnet: "var(--ds-danger)",
  buried: "var(--ds-warning)",
  healthy: "var(--ds-success)",
  dead: "var(--ds-fg-subtle)",
  none: "var(--ds-fg-subtle)",
};

export const ENDED_GRADIENT = "journey-ended-fade";

/**
 * Draw-in: ribbons fade in from the moment they mount, one gap a step after
 * the last. On page load that is while the card still waits for its rise-in,
 * so the card rises with its ribbons already drawn; reopening the Journey tab
 * starts the fade on the next frame and ends within {@link JOURNEY_DRAW_TOTAL_MS}.
 */
export const JOURNEY_DRAW_FADE_MS = 280;
const DRAW_START_MS = 0;
const DRAW_STEP_MS = 40;
/** The longest a first draw takes: three steps of stagger, then one fade. */
export const JOURNEY_DRAW_TOTAL_MS = DRAW_START_MS + 3 * DRAW_STEP_MS + JOURNEY_DRAW_FADE_MS;

export type JourneyMarkState = "rest" | "active" | "lit" | "dim";

type Delay = CSSProperties & { "--flow-delay"?: string };

function delay(ms: number): Delay {
  return { "--flow-delay": `${Math.round(ms)}ms` };
}

export function JourneyDefs() {
  return (
    <defs>
      {/* A turn that ends fades on its way into "Ended". */}
      <linearGradient id={ENDED_GRADIENT} x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stopColor="var(--ds-fg-subtle)" stopOpacity={0.3} />
        <stop offset="1" stopColor="var(--ds-fg-subtle)" stopOpacity={0.12} />
      </linearGradient>
    </defs>
  );
}

/** Column titles above the lanes, with how many turns made that call. */
export function JourneyHeaders({ columns }: { columns: readonly JourneyColumn[] }) {
  return (
    <g aria-hidden>
      {columns.map((column) => (
        <JourneyHeader key={column.index} column={column} />
      ))}
    </g>
  );
}

/** One column's title: "4th call · 435". Hidden while the pinned start rail covers its start. */
export function JourneyHeader({
  column,
  covered = false,
}: {
  column: JourneyColumn;
  covered?: boolean;
}) {
  return (
    <text
      aria-hidden
      data-journey-column={column.role}
      opacity={covered ? 0 : 1}
      className="flow-dim"
      x={column.x + 2}
      y={14}
      fontSize={12}
    >
      <tspan fill="var(--ds-fg-subtle)">{column.title}</tspan>
      {column.role !== "then" && column.role !== "across" && (
        <tspan fill="var(--ds-fg-muted)" fillOpacity={0.6}>{` · ${countText(column.turns)}`}</tspan>
      )}
    </text>
  );
}

function ribbonFill(family: number): string {
  return family === JOURNEY_ENDED_FAMILY ? `url(#${ENDED_GRADIENT})` : familyColor(family);
}

/** Rest opacity: a minor ribbon stays faint, so the busy paths read first. */
function restOpacity(ribbon: JourneyRibbon): number {
  // A fold ribbon ("+N tools") is real traffic but no one path to follow: quieter at rest.
  const quiet = ribbon.fold ? 0.5 : 1;
  if (ribbon.family === JOURNEY_ENDED_FAMILY) return (ribbon.minor ? 0.4 : 1) * quiet;
  const base = ribbon.family < 0 ? 0.22 : 0.55;
  return (ribbon.minor ? base * 0.35 : base) * quiet;
}

export interface JourneyBaseProps {
  ribbons: readonly JourneyRibbon[];
  /** `first>tool` pairs from "Needs first": their direct links are drawn stronger. */
  emphasis?: ReadonlySet<string>;
  /** Node key to its column, for the draw-in order. */
  columnOf: ReadonlyMap<string, number>;
}

/**
 * Every ribbon at rest. It never re-renders on focus: the canvas dims the
 * whole layer with one opacity and draws the lit parts over it, so a hover
 * touches a few dozen elements, not every ribbon.
 */
export const JourneyBase = memo(function JourneyBase({
  ribbons,
  columnOf,
  emphasis,
}: JourneyBaseProps) {
  const gaps = new Map<number, JourneyRibbon[]>();
  for (const ribbon of ribbons) {
    const gap = columnOf.get(ribbon.from) ?? 0;
    gaps.set(gap, [...(gaps.get(gap) ?? []), ribbon]);
  }
  return (
    <>
      {[...gaps]
        .sort((a, b) => a[0] - b[0])
        .map(([gap, list]) => (
          <g key={gap} data-journey-gap={gap} className="journey-reveal">
            {list.map((ribbon) => {
              const from = toolIdOf(ribbon.from);
              const to = toolIdOf(ribbon.to);
              const strong = !!from && !!to && !!emphasis?.has(`${from}>${to}`);
              return (
                <path
                  key={ribbon.key}
                  data-journey-ribbon={ribbon.key}
                  data-journey-family={ribbon.family}
                  data-journey-minor={ribbon.minor ? "true" : undefined}
                  data-journey-strong={strong ? "true" : undefined}
                  d={ribbon.path}
                  fill={ribbonFill(ribbon.family)}
                  fillOpacity={
                    strong ? Math.min(0.9, restOpacity(ribbon) + 0.3) : restOpacity(ribbon)
                  }
                  stroke={strong ? "var(--ds-fg-muted)" : undefined}
                  strokeOpacity={strong ? 0.35 : undefined}
                  strokeWidth={strong ? 0.75 : undefined}
                  className="flow-fade"
                  style={delay(
                    DRAW_START_MS + Math.min(3, columnOf.get(ribbon.from) ?? 0) * DRAW_STEP_MS,
                  )}
                />
              );
            })}
          </g>
        ))}
    </>
  );
});

/** The focused turns: each ribbon they took, drawn at their share from its top edge. */
export function JourneyLit({
  ribbons,
  focus,
}: {
  ribbons: readonly JourneyRibbon[];
  focus: JourneyFocus;
}) {
  return (
    <g aria-hidden data-journey-lit-layer="true">
      {ribbons.map((ribbon) => {
        const lit = focus.ribbons.get(ribbon.key) ?? 0;
        if (lit <= 0) return null;
        const ended = ribbon.family === JOURNEY_ENDED_FAMILY;
        return (
          <path
            key={ribbon.key}
            data-journey-lit={ribbon.key}
            d={ribbonBand(ribbon, lit / ribbon.turns, 1)}
            fill={ended ? "var(--ds-fg-muted)" : familyColor(ribbon.family)}
            fillOpacity={ended ? 0.35 : ribbon.family < 0 ? 0.6 : 0.9}
          />
        );
      })}
    </g>
  );
}

export interface JourneyNodeProps {
  node: JourneyNode;
  state: JourneyMarkState;
  /** Turns of the focused set through this chip, or null at rest. */
  lit: number | null;
  /** Filtered out: faded away in place, not focusable, never moved. */
  hidden?: boolean;
  /** A line to show instead of the count, e.g. "100% after find_task". */
  caption?: string | null;
  /** What the chip says to a screen reader instead of its step in the turn. */
  label?: string | null;
  opens: boolean;
  pinned: boolean;
  onEnter: (node: JourneyNode) => void;
  onLeave: () => void;
  onActivate: (node: JourneyNode, viaKeyboard: boolean) => void;
}

function handlers({ node, hidden, onEnter, onLeave, onActivate }: JourneyNodeProps) {
  if (hidden) return {};
  return {
    onPointerEnter: () => onEnter(node),
    onPointerLeave: onLeave,
    onFocus: () => onEnter(node),
    onBlur: onLeave,
    onClick: (event: MouseEvent<SVGGElement>) => {
      event.stopPropagation();
      onActivate(node, false);
    },
    onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate(node, true);
      }
    },
  };
}

const KIND_ICON: Record<JourneyNodeKind, LucideIcon> = {
  search: Search,
  none: Zap,
  agent: Bot,
  tool: Wrench,
  skill: BookOpen,
  other: Layers,
  more: ChevronsRight,
  later: UnfoldHorizontal,
  ended: Flag,
};

/** The icon's colour: a state colour when the tool has one to show, muted otherwise. */
function iconColor(node: JourneyNode): string {
  if ((node.kind === "tool" || node.kind === "skill") && node.tint !== "none")
    return STATE_COLOR[node.tint];
  return "var(--ds-fg-subtle)";
}

const ICON = 12;
const FLAG_ICON = 11;
const LINE_ONE = 15;
const LINE_TWO = 29;

/** A dashed stack of cards: the front card fills the chip's height, two edges peek out on the right. */
function StackSurface({
  node,
  state,
  strong,
}: {
  node: JourneyNode;
  state: JourneyMarkState;
  strong?: boolean;
}) {
  const card = chipCard(node);
  const lit = state === "active" || state === "lit";
  return (
    <>
      {[card.stack, card.stack / 2].map((d) => (
        <rect
          key={d}
          x={card.x + d}
          y={card.y + d / 2}
          width={card.w}
          height={card.h - d}
          rx={8}
          fill="var(--ds-raised)"
          stroke="var(--ds-line)"
          strokeOpacity={0.9}
        />
      ))}
      <rect
        x={card.x}
        y={card.y}
        width={card.w}
        height={card.h}
        rx={9}
        fill="var(--ds-raised)"
        stroke={state === "active" ? "var(--ds-fg)" : "var(--ds-fg-muted)"}
        strokeOpacity={state === "active" ? 0.75 : lit ? 0.55 : strong ? 0.45 : 0.3}
        strokeDasharray={strong ? undefined : "3 3"}
      />
    </>
  );
}

/** "More calls": a tab pointing right with a dashed edge, the path goes on. */
function MoreSurface({ node, state }: { node: JourneyNode; state: JourneyMarkState }) {
  const { x, y, w, h } = node;
  const tip = 11;
  const r = 9;
  const d = `M${x + r} ${y} H${x + w - tip} L${x + w} ${y + h / 2} L${x + w - tip} ${y + h} H${x + r} Q${x} ${y + h} ${x} ${y + h - r} V${y + r} Q${x} ${y} ${x + r} ${y} Z`;
  return (
    <path
      d={d}
      fill="var(--ds-raised)"
      stroke={state === "active" ? "var(--ds-fg)" : "var(--ds-fg-muted)"}
      strokeOpacity={state === "active" ? 0.75 : 0.35}
      strokeDasharray="4 3"
      strokeLinejoin="round"
    />
  );
}

/** "Ended": a short, borderless grey tab with a solid end cap, the path stops here. */
function EndedSurface({ node }: { node: JourneyNode }) {
  const card = chipCard(node);
  return (
    <>
      <rect
        x={card.x}
        y={card.y}
        width={card.w}
        height={card.h}
        rx={9}
        fill="var(--ds-line)"
        fillOpacity={0.35}
      />
      <rect
        x={card.x + card.w - 3}
        y={card.y + 8}
        width={3}
        height={card.h - 16}
        rx={1.5}
        fill="var(--ds-fg-subtle)"
        fillOpacity={0.7}
      />
    </>
  );
}

function ChipSurface({ node, state }: { node: JourneyNode; state: JourneyMarkState }) {
  if (node.kind === "other") return <StackSurface node={node} state={state} />;
  if (node.kind === "later") return <StackSurface node={node} state={state} strong />;
  if (node.kind === "more") return <MoreSurface node={node} state={state} />;
  if (node.kind === "ended") return <EndedSurface node={node} />;
  return (
    <>
      <rect
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={9}
        fill="var(--ds-raised)"
        stroke={state === "active" ? "var(--ds-fg)" : "var(--ds-line)"}
        strokeOpacity={state === "active" ? 0.75 : 1}
        strokeWidth={state === "active" ? 1.4 : 1}
      />
      {state !== "rest" && state !== "dim" && (
        <rect
          x={node.x}
          y={node.y}
          width={node.w}
          height={node.h}
          rx={9}
          fill="var(--ds-fg)"
          fillOpacity={0.05}
        />
      )}
      {node.family >= 0 && (
        <rect
          x={node.x + 3}
          y={node.y + 9}
          width={2.5}
          height={node.h - 18}
          rx={1.25}
          fill={familyColor(node.family)}
        />
      )}
    </>
  );
}

/** The share bar on the chip's second line, after the count. */
function ShareBar({ node, from, to }: { node: JourneyNode; from: number; to: number }) {
  const width = Math.max(0, to - from);
  if (width < 12) return null;
  const y = node.y + LINE_TWO - 3.5;
  return (
    <g aria-hidden>
      <rect x={from} y={y} width={width} height={2} rx={1} fill="var(--ds-line)" />
      <rect
        x={from}
        y={y}
        width={Math.max(1.5, width * Math.min(1, node.share))}
        height={2}
        rx={1}
        fill={node.kind === "ended" ? "var(--ds-fg-subtle)" : "var(--ds-fg-muted)"}
        fillOpacity={0.65}
      />
    </g>
  );
}

/** A small action on a chip's second line, right-aligned inside its padding: "show 3 ⌄" or "open ›". */
function ChipAction({ node, label, Icon }: { node: JourneyNode; label: string; Icon: LucideIcon }) {
  const right = chipCard(node).contentRight;
  return (
    <g aria-hidden data-journey-action={node.key}>
      <text
        x={right - 12}
        y={node.y + LINE_TWO}
        textAnchor="end"
        fill="var(--ds-fg-muted)"
        fillOpacity={0.85}
        fontSize={10}
        className="font-mono"
      >
        {label}
      </text>
      <Icon
        x={right - 10}
        y={node.y + LINE_TWO - 8.5}
        width={10}
        height={10}
        color="var(--ds-fg-muted)"
        strokeWidth={2.2}
      />
    </g>
  );
}

/** One chip: icon and name on the first line, count, share bar and problem icons on the second. */
export function JourneyNodeMark(props: JourneyNodeProps) {
  const { node, state, lit, opens, pinned, hidden = false, caption = null, label = null } = props;
  const focused = lit !== null;
  const value = focused ? (lit ?? 0) : node.turns;
  const Icon = KIND_ICON[node.kind];
  const quiet = node.kind === "other" || node.kind === "ended" || node.kind === "more";
  const nameColor =
    state === "active" || state === "lit"
      ? "var(--ds-fg)"
      : quiet
        ? "var(--ds-fg-subtle)"
        : "var(--ds-fg-muted)";
  const card = chipCard(node);
  const textX = node.x + JOURNEY_CHIP.textX;
  const count = caption ?? (focused && value === 0 ? "" : countText(value));
  const flagsLeft = card.contentRight - node.flags.length * (FLAG_ICON + 4) + 4;
  const barFrom = textX + (count.length + 1) * JOURNEY_FONT * 0.6;
  const expand = node.kind === "other" ? expandLabel(node) : null;
  const action =
    focused || caption
      ? null
      : expand
        ? { label: expand, Icon: ChevronDown }
        : node.kind === "later"
          ? { label: "open", Icon: ChevronRight }
          : null;
  return (
    <g
      role={hidden ? undefined : "button"}
      tabIndex={hidden ? -1 : 0}
      aria-hidden={hidden || undefined}
      aria-label={
        hidden
          ? undefined
          : label
            ? label
            : caption
              ? `${journeyNodeAriaLabel(node)}. ${caption}`
              : journeyNodeAriaLabel(node)
      }
      aria-pressed={hidden ? undefined : pinned}
      data-journey-node={node.key}
      data-journey-hidden={hidden ? "true" : undefined}
      data-journey-kind={node.kind}
      data-journey-tint={node.tint}
      data-journey-opens={opens ? "true" : "false"}
      data-journey-expandable={node.kind === "other" ? node.expandable : undefined}
      style={{
        opacity: hidden ? 0 : state === "dim" ? 0.35 : 1,
        pointerEvents: hidden ? "none" : undefined,
      }}
      className="flow-dim cursor-pointer outline-none"
      {...handlers(props)}
    >
      <ChipSurface node={node} state={state} />
      <Icon
        aria-hidden
        x={card.contentLeft}
        y={node.y + LINE_ONE - ICON / 2 - 3.5}
        width={ICON}
        height={ICON}
        color={iconColor(node)}
        strokeWidth={2}
      />
      <text
        aria-hidden
        x={textX}
        y={node.y + LINE_ONE}
        fill={nameColor}
        fontSize={JOURNEY_FONT}
        className="font-mono"
      >
        {node.text}
      </text>
      {count && (
        <text
          aria-hidden
          data-journey-count={focused ? node.key : undefined}
          x={textX}
          y={node.y + LINE_TWO}
          fill={focused || caption ? "var(--ds-fg)" : "var(--ds-fg-subtle)"}
          fontSize={focused && !caption ? JOURNEY_FONT : 10.5}
          fontWeight={focused && !caption ? 600 : 400}
          className="font-mono"
        >
          {count}
        </text>
      )}
      {!focused && !caption && !action && node.kind !== "other" && (
        <ShareBar node={node} from={barFrom} to={flagsLeft - 6} />
      )}
      {action && <ChipAction node={node} label={action.label} Icon={action.Icon} />}
      {node.flags.map((flag, i) => {
        const FlagIcon = flag === "errors" ? CircleX : Timer;
        return (
          <FlagIcon
            key={flag}
            aria-hidden
            data-journey-flag={flag}
            x={flagsLeft + i * (FLAG_ICON + 4)}
            y={node.y + LINE_TWO - FLAG_ICON / 2 - 3.5}
            width={FLAG_ICON}
            height={FLAG_ICON}
            color={flag === "errors" ? "var(--ds-danger)" : "var(--ds-warning)"}
            strokeWidth={2}
          />
        );
      })}
      <rect
        aria-hidden
        x={node.x - 2.5}
        y={node.y - 2.5}
        width={node.w + 5}
        height={node.h + 5}
        rx={11}
        fill="none"
        stroke="var(--ds-focus)"
        strokeWidth={1.5}
        className="opacity-0 [g:focus-visible>&]:opacity-100"
      />
    </g>
  );
}
