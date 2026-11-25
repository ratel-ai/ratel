"use client";

import { cn } from "@ratel/design-system/cn";
import {
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  CircleX,
  Cpu,
  Flag,
  Layers,
  type LucideIcon,
  Play,
  Server,
  Target,
  Timer,
  UnfoldHorizontal,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import {
  familyColor,
  JourneyBase,
  JourneyDefs,
  JourneyLit,
} from "@/components/console/health/ToolJourneyParts";
import type { StepFlowNode, StepFlowQuery } from "@/lib/contracts/query";
import type { StepFlowResult } from "@/lib/synthesis/metrics/step-flow";
import type { StepFlowNodeCount } from "@/lib/synthesis/metrics/step-flow-columns";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import {
  cardLabel,
  EXPAND_STEP,
  laterLabel,
  type StepFlowCard,
  stepFlowModel,
} from "@/lib/views/dashboards/step-flow-model";
import { flowNodeLabel, flowNodeNoun } from "@/lib/views/dashboards/widget";
import { journeyFocus } from "@/lib/views/health/flow-journey-layout";
import { SampleNote } from "./SampleNote";
import { useSize } from "./use-size";

const NODE_ICON: Readonly<Record<StepFlowNode, LucideIcon>> = {
  tool: Wrench,
  skill: BookOpen,
  agent: Bot,
  mcp_server: Server,
  model: Cpu,
};

/**
 * What traces do step by step: a lane of cards per step, with the Health map's ribbons between
 * them. Hover or focus a card to trace its paths; it opens its traces. A bucket and Later unfold in
 * place: a person's view, which nothing stores.
 */
export function StepFlowChart({
  query,
  result,
  label,
  nodeHref,
  fill = false,
}: {
  query: StepFlowQuery;
  result: StepFlowResult;
  /** The flow, for its accessible name. */
  label: string;
  /** Null for a node whose traces no address can name. */
  nodeHref: (node: StepFlowNodeCount) => string | null;
  /** Take the height of the place it is in. */
  fill?: boolean;
}) {
  const [hostRef, { width }] = useSize<HTMLDivElement>();
  const [expanded, setExpanded] = useState<Record<number, number>>({});
  const [opened, setOpened] = useState(0);
  const [pointed, setPointed] = useState<string | null>(null);
  const model = useMemo(
    () => stepFlowModel(result, query, { width, expanded, opened }),
    [result, query, width, expanded, opened],
  );
  const { layout, lanes } = model;
  const focus = useMemo(
    () =>
      pointed !== null && layout.nodes.some(({ key }) => key === pointed)
        ? journeyFocus(layout, pointed)
        : null,
    [layout, pointed],
  );
  const columnOf = useMemo(
    () => new Map(layout.nodes.map(({ key, column }) => [key, column])),
    [layout],
  );
  const unfold = ({ step }: StepFlowCard) =>
    setExpanded((current) => ({ ...current, [step]: (current[step] ?? 0) + EXPAND_STEP }));
  const refold = (step: number) =>
    setExpanded(({ [step]: _, ...rest }: Record<number, number>) => rest);

  return (
    <div className={cn("flex min-w-0 flex-col", fill && "h-full")}>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-auto">
        {/* biome-ignore lint/a11y/useSemanticElements: a drawing is no fieldset. */}
        <div
          role="group"
          aria-label={`${label}: ${formatInteger(model.total)} trace${model.total === 1 ? "" : "s"}, step by step`}
          className="relative"
          style={{ width: layout.width, height: layout.height }}
          onPointerLeave={() => setPointed(null)}
        >
          {/* biome-ignore lint/a11y/noSvgWithoutTitle: hidden; the cards say it. */}
          <svg
            aria-hidden
            width={layout.width}
            height={layout.height}
            className="absolute inset-0 block"
          >
            <JourneyDefs />
            <g
              className="transition-opacity duration-160 motion-reduce:transition-none"
              style={{ opacity: focus ? 0.16 : 1 }}
            >
              <JourneyBase ribbons={layout.ribbons} columnOf={columnOf} />
            </g>
            {focus ? <JourneyLit ribbons={layout.ribbons} focus={focus} /> : null}
          </svg>
          {lanes.map((lane) => (
            // biome-ignore lint/a11y/useSemanticElements: a lane of a drawing is no fieldset.
            <div
              role="group"
              key={`${lane.role}:${lane.step}`}
              aria-label={`${lane.title}: ${formatInteger(lane.count)}`}
              data-step-lane={lane.role === "step" ? lane.step : lane.role}
            >
              <h4
                className="absolute top-0 flex items-center gap-1 text-xs text-fg-subtle"
                style={{ left: lane.x, width: lane.width }}
              >
                <span className="truncate">{lane.title}</span>
                <span className="text-fg-muted/70 tabular-nums">· {formatInteger(lane.count)}</span>
                {lane.role !== "later" && expanded[lane.step] ? (
                  <Less label="Fewer" onClick={() => refold(lane.step)} />
                ) : null}
                {lane.role === "later" && opened > 0 ? (
                  <Less label="Close" onClick={() => setOpened(0)} />
                ) : null}
              </h4>
              {lane.cards.map((card) => {
                const lit = focus ? (focus.nodes.get(card.key) ?? 0) : null;
                const href = nodeHref(card);
                const onward = card.kind === "later" && model.depth < model.reached;
                return (
                  <Card
                    key={card.key}
                    card={card}
                    query={query}
                    lit={lit}
                    href={href}
                    action={
                      card.kind === "rest"
                        ? {
                            label: `show ${Math.min(EXPAND_STEP, card.folded)}`,
                            icon: ChevronDown,
                            run: () => unfold(card),
                          }
                        : onward
                          ? {
                              label: "open",
                              icon: ChevronRight,
                              run: () => setOpened((current) => current + 1),
                            }
                          : null
                    }
                    onPoint={setPointed}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <SampleNote sample={result.sample} />
    </div>
  );
}

function Less({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-focus"
    >
      <ChevronsDownUp aria-hidden className="size-3" />
      {label}
    </button>
  );
}

interface CardAction {
  label: string;
  icon: LucideIcon;
  run: () => void;
}

/** A node: its name, its traces and its share; errors and slowness as small marks. */
function Card({
  card,
  query,
  lit,
  href,
  action,
  onPoint,
}: {
  card: StepFlowCard;
  query: StepFlowQuery;
  /** Of the traced paths, the traces here; null with nothing traced. */
  lit: number | null;
  href: string | null;
  action: CardAction | null;
  onPoint: (key: string | null) => void;
}) {
  const { kind, mark } = card;
  const Icon = iconOf(card, query);
  const name = cardName(card, query);
  const said = cardLabel(card, query);
  const props = {
    "data-step-node": card.key,
    "aria-label": action ? `${said}. Press to ${action.label}` : said,
    title: said,
    style: { left: card.x, top: card.y, width: card.w, height: card.h },
    className: cn(
      "absolute flex flex-col justify-center gap-0.5 rounded-lg border px-2.5 text-left text-xs outline-none transition-opacity duration-160 focus-visible:ring-1 focus-visible:ring-focus motion-reduce:transition-none",
      kind === "ended" ? "border-transparent bg-raised/60" : "border-line bg-raised",
      kind === "rest" && "border-dashed border-line-strong",
      kind === "later" && "border-line-strong",
      (href || action) && "cursor-pointer hover:border-fg-muted",
      lit === 0 && "opacity-35",
    ),
    onPointerEnter: () => onPoint(card.key),
    onFocus: () => onPoint(card.key),
    onBlur: () => onPoint(null),
  };
  const body: ReactNode = (
    <>
      {card.family >= 0 ? (
        <span
          aria-hidden
          className="absolute inset-y-2 left-1 w-0.5 rounded"
          style={{ background: familyColor(card.family) }}
        />
      ) : null}
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon aria-hidden className="size-3 shrink-0 text-fg-subtle" />
        <span
          className={cn(
            "truncate font-mono",
            kind === "ended" || kind === "rest" ? "text-fg-muted" : "text-fg",
          )}
        >
          {name}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-fg-muted tabular-nums">
        {formatInteger(lit ?? card.count)}
        {action ? (
          <span className="ml-auto inline-flex items-center gap-0.5">
            {action.label}
            <action.icon aria-hidden className="size-3" />
          </span>
        ) : (
          <span aria-hidden className="h-0.5 min-w-0 flex-1 overflow-hidden rounded bg-line">
            <span
              className="block h-full bg-fg-subtle"
              style={{ width: `${Math.max(1, card.share * 100)}%` }}
            />
          </span>
        )}
        {mark?.errors ? <CircleX aria-hidden className="size-3 shrink-0 text-danger" /> : null}
        {mark?.slow ? <Timer aria-hidden className="size-3 shrink-0 text-warning" /> : null}
      </span>
    </>
  );
  if (action)
    return (
      <button type="button" onClick={action.run} {...props}>
        {body}
      </button>
    );
  if (href)
    return (
      <Link href={href} {...props}>
        {body}
      </Link>
    );
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: focus traces its paths, as a pointer does.
    <div role="img" tabIndex={0} {...props}>
      {body}
    </div>
  );
}

function iconOf({ kind }: StepFlowCard, { node, start, mode }: StepFlowQuery): LucideIcon {
  switch (kind) {
    case "node":
      return NODE_ICON[node];
    case "rest":
      return Layers;
    case "later":
      return UnfoldHorizontal;
    case "ended":
      return Flag;
    case "start":
      return start === "agent"
        ? Bot
        : start === "intent"
          ? Target
          : mode === "before"
            ? NODE_ICON[node]
            : Play;
  }
}

function cardName(card: StepFlowCard, query: StepFlowQuery): string {
  switch (card.kind) {
    case "rest": {
      const noun = card.step > 0 ? query.node : query.start === "agent" ? ("agent" as const) : null;
      const words = noun === null ? ["intent", "intents"] : [flowNodeNoun(noun), plural(noun)];
      return `+${card.folded} ${card.folded === 1 ? words[0] : words[1]}`;
    }
    case "later":
      return laterLabel(card, query);
    case "ended":
      return query.mode === "before" ? "Nothing earlier" : "Ended";
    default:
      return card.name;
  }
}

function plural(node: StepFlowNode): string {
  return node === "mcp_server" ? flowNodeLabel(node) : flowNodeLabel(node).toLowerCase();
}
