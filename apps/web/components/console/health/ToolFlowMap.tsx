import type { ReactNode } from "react";
import {
  JOURNEY_INTRO,
  PREREQ_INTRO,
  PREREQ_TITLE,
  prerequisiteEmptyReason,
  prerequisiteIntro,
} from "@/components/console/health/journey-copy";
import { signalAnchorId } from "@/components/console/health/SignalList";
import { ToolFlowCanvas } from "@/components/console/health/ToolFlowCanvas";
import { ToolFlowLegend } from "@/components/console/health/ToolFlowLegend";
import { ToolJourneyView } from "@/components/console/health/ToolJourneyView";
import {
  commonChains,
  readPrerequisites,
  readStoredPrerequisites,
} from "@/lib/readings/trace-signals/flow-journey-insights";
import type { FlowJourney, FlowModel, TurnSourceMix } from "@/lib/readings/trace-signals/view";
import { layoutJourney } from "@/lib/views/health/flow-journey-layout";
import { layoutFlow } from "@/lib/views/health/flow-layout";

export interface ToolFlowMapProps {
  flow: FlowModel;
  /** The span the map was computed over when it differs from the selected window, e.g. "last 22 days". */
  windowLabel?: string | null;
  /** How the window's turns were split, so an empty prerequisites view can say timing split them. */
  turnSourceMix?: TurnSourceMix | null;
  /** Whether "Show all" starts on, before the viewer's own choice is read. */
  showAll?: boolean;
}

/**
 * The tool flow card.
 *
 * With a journey (every run since it was added), it is "What each tool needs
 * first": one step-by-step map of every turn (`ToolJourneyCanvas`, laid out
 * once with every link), filtered by default to the tools one almost always
 * runs before another and the turns between them. "Show all" fades the rest
 * of the same map in, with the common chains (`ToolJourneyView`). A run
 * stored before journeys existed still has only the search-to-tool graph, and
 * draws the older map (`ToolFlowCanvas`, "How turns flow") until the next run
 * replaces it.
 *
 * Either layout is computed here, on the server, by a pure function, so the
 * drawing is fixed before it reaches the browser; only focus runs on the client.
 */
export function ToolFlowMap({
  flow,
  windowLabel = null,
  turnSourceMix = null,
  showAll = false,
}: ToolFlowMapProps) {
  const journey = layoutJourney(flow.journey, { showAll: true });
  if (journey && flow.journey) {
    // The run's own pairs (counted across a session) when it stored them; the paths' pairs for older runs.
    const fromPaths = readPrerequisites(flow.journey);
    const stored = readStoredPrerequisites(flow.journey);
    const reading = stored ? { ...fromPaths, ...stored } : fromPaths;
    const drawn = reading.relations.length > 0;
    return (
      <Frame
        title={PREREQ_TITLE}
        meta={`${journey.turns.toLocaleString("en-US")} turns`}
        windowLabel={windowLabel}
        intro={
          !drawn
            ? JOURNEY_INTRO
            : stored
              ? prerequisiteIntro(
                  flow.journey.prerequisites
                    ? Math.round(flow.journey.prerequisites.windowMs / 60_000)
                    : null,
                  reading.relations.some((row) => row.crossTurn),
                )
              : PREREQ_INTRO
        }
      >
        <ToolJourneyView
          journey={flow.journey}
          layout={journey}
          chains={commonChains(flow.journey)}
          reading={reading}
          emptyReason={
            drawn
              ? null
              : prerequisiteEmptyReason({
                  singleCallShare: reading.singleCallShare,
                  inferredShare: inferredShare(turnSourceMix),
                  closest: reading.closest,
                })
          }
          anchors={journeyAnchors(flow.journey)}
          showAll={showAll}
        />
      </Frame>
    );
  }
  return <LegacyFlowMap flow={flow} windowLabel={windowLabel} />;
}

function inferredShare(mix: TurnSourceMix | null): number {
  if (!mix) return 0;
  const total = mix.declared + mix.inferred + mix.otlp;
  return total > 0 ? mix.inferred / total : 0;
}

function journeyAnchors(journey: FlowJourney): Record<string, string[]> {
  const entries = journey.tools
    .filter((tool) => tool.signalIds.length > 0)
    .map((tool) => [tool.id, tool.signalIds.map(signalAnchorId)] as const);
  const search =
    journey.searchSignalIds.length > 0
      ? [["search", journey.searchSignalIds.map(signalAnchorId)] as const]
      : [];
  return Object.fromEntries([...entries, ...search]);
}

interface FrameProps {
  title: string;
  meta: string;
  windowLabel: string | null;
  intro: string;
  children: ReactNode;
}

function Frame({ title, meta, windowLabel, intro, children }: FrameProps) {
  return (
    <section
      aria-label="Tool flow"
      data-tool-flow-map="true"
      className="card-enter rounded-2xl border border-forest-300 bg-forest-600/40 p-4 sm:p-5"
      style={{ animationDelay: "600ms" }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-display text-lg font-semibold text-cream">{title}</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted">
          {meta}
          {windowLabel && <span data-flow-window={windowLabel}> · {windowLabel}</span>}
        </span>
      </div>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-warm-muted">{intro}</p>
      {children}
    </section>
  );
}

/** The search-to-tool map, for runs stored before journeys. */
function LegacyFlowMap({ flow, windowLabel }: { flow: FlowModel; windowLabel: string | null }) {
  const layout = layoutFlow(flow);
  // Both layouts are fixed here; "+N more" only swaps one for the other.
  const expanded = layout.foldable ? layoutFlow(flow, { expanded: true }) : null;
  const full = expanded ?? layout;
  const shown = new Set(
    full.nodes
      .filter((node) => node.kind === "tool" || node.kind === "skill")
      .map((node) => node.id),
  ).size;
  const paths = full.edges.length;
  const anchors = Object.fromEntries(
    full.nodes
      .filter((node) => node.signalIds.length > 0)
      .map((node) => [node.id, node.signalIds.map(signalAnchorId)]),
  );
  return (
    <Frame
      title="How turns flow"
      meta={`${shown} of ${flow.totalTools.toLocaleString("en-US")} tools · ${paths} ${paths === 1 ? "path" : "paths"}`}
      windowLabel={windowLabel}
      intro="From each search to the tool it led to, then what ran next. Wider ribbons carry more turns. Point at a tool to light its paths; click to pin it and open its problem."
    >
      {layout.nodes.length === 0 ? (
        <p className="mt-4 rounded-xl bg-base-deep/40 px-4 py-6 text-center text-sm text-warm-muted">
          No tool paths in this window yet.
        </p>
      ) : (
        <ToolFlowCanvas layout={layout} expandedLayout={expanded} anchors={anchors} />
      )}
      <ToolFlowLegend />
    </Frame>
  );
}
