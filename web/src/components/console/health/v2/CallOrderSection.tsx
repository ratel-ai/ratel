import { Section } from "@ratel/design-system/section";
import { signalAnchorId } from "@/components/console/health/anchors";
import { prerequisiteEmptyReason } from "@/components/console/health/journey-copy";
import { CallOrder } from "@/components/console/health/v2/CallOrder";
import { beforeHint } from "@/components/console/health/v2/call-order-copy";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import {
  commonChains,
  readPrerequisites,
  readStoredPrerequisites,
} from "@/lib/readings/trace-signals/flow-journey-insights";
import type {
  FlowJourney,
  FlowModel,
  SourceMode,
  TurnSourceMix,
} from "@/lib/readings/trace-signals/view";
import { layoutJourney } from "@/lib/views/health/flow-journey-layout";
import { type ChainTaskInput, chainsAsTasks } from "@/lib/views/health/summary/task-chains";

/**
 * The order the agent calls its tools in, laid out on the server (a pure
 * function, as on the old page) and drawn by the journey canvas, with the
 * lane it was read from (OpenTelemetry tool spans or the Ratel SDK's events)
 * and the common chains that are tasks. A reading stored before calls were
 * read in order says the next reading draws it.
 */

export const CALL_ORDER_TITLE = "What your agent calls first";

/** Every chain the journey holds, before only the ones that are tasks are kept. */
const CHAINS_READ = 50;

export function CallOrderSection({
  projectId,
  flow,
  windowLabel,
  turnSourceMix,
  sourceMode,
  tasks,
}: {
  projectId: string;
  flow: FlowModel;
  windowLabel: string | null;
  turnSourceMix: TurnSourceMix;
  sourceMode: SourceMode;
  /** The tasks with their steps, for naming the chains that are tasks. */
  tasks: readonly ChainTaskInput[];
}) {
  const layout = layoutJourney(flow.journey, { showAll: true });
  const span = windowLabel ? ` · ${windowLabel}` : "";
  if (layout && flow.journey) {
    const fromPaths = readPrerequisites(flow.journey);
    const stored = readStoredPrerequisites(flow.journey);
    const reading = stored ? { ...fromPaths, ...stored } : fromPaths;
    const drawn = reading.relations.length > 0;
    const minutes =
      stored && flow.journey.prerequisites
        ? Math.round(flow.journey.prerequisites.windowMs / 60_000)
        : null;
    return (
      <CallOrder
        title={CALL_ORDER_TITLE}
        beforeHint={beforeHint(minutes)}
        crossTurn={drawn && reading.relations.some((row) => row.crossTurn)}
        meta={`${layout.turns.toLocaleString("en-US")} turns${span}`}
        lane={sourceMode}
        journey={flow.journey}
        layout={layout}
        chains={chainsAsTasks(commonChains(flow.journey, CHAINS_READ), tasks, projectId)}
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
      />
    );
  }
  // A reading stored before calls were read in order has only its old search-to-tool graph: the next reading draws this.
  if (flow.nodes.length === 0) return null;
  return (
    <Section title={<NounTitle noun="tool">{CALL_ORDER_TITLE}</NounTitle>}>
      <p className="text-ui text-fg-muted" data-tool-flow-map="pending">
        The order your agent calls its tools in appears with the next reading.
      </p>
    </Section>
  );
}

function inferredShare(mix: TurnSourceMix): number {
  const total = mix.declared + mix.inferred + mix.otlp;
  return total > 0 ? mix.inferred / total : 0;
}

/** Each tool on the map to the issues about it, so a click opens the issue's row. */
function journeyAnchors(journey: FlowJourney): Record<string, string[]> {
  const tools = journey.tools
    .filter((tool) => tool.signalIds.length > 0)
    .map((tool) => [tool.id, tool.signalIds.map(signalAnchorId)] as const);
  const search =
    journey.searchSignalIds.length > 0
      ? [["search", journey.searchSignalIds.map(signalAnchorId)] as const]
      : [];
  return Object.fromEntries([...tools, ...search]);
}
