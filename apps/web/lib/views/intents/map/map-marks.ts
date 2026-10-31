/**
 * Every intent holds the tools its asks used. A tool several intents share is
 * drawn once inside each of them and marked as shared, rather than in a Venn
 * overlap, which crowds as soon as a fourth intent shares it: seeing a blob
 * and its tools matters most. Pointing at one of a tool's marks draws a line
 * to each of its others, so "which intents does it serve" still reads.
 *
 * The layout places every mark as a tool of its own blob (`computeMapLayout`
 * with nothing shared), so the blobs keep apart and each mark sits inside its
 * blob, along its lower edge. Pure: ids and counts only.
 */
import { computeMapLayout } from "@/lib/views/intents/map/map-layout";
import type { MapLayout } from "@/lib/views/intents/map/map-membership";
import type { IntentMapModel, MapCapability } from "@/lib/views/intents/map/map-model";

const SEPARATOR = "@";

/** One tool inside one intent. */
export interface ToolMark {
  /** `<capability>@<intent>`: ids only. */
  id: string;
  capability: string;
  ask: string;
  /** Calls from this intent's asks. */
  weight: number;
  /** Of this intent's calls, 0..1. */
  share: number;
  /** Another intent uses the tool too: it is drawn in each, marked as shared. */
  shared: boolean;
}

export interface MapMarks {
  marks: ToolMark[];
  byId: Map<string, ToolMark>;
  /** Each tool's marks, its busiest intent first. */
  byCapability: Map<string, ToolMark[]>;
  /** Each intent's marks, its busiest tool first. */
  byAsk: Map<string, ToolMark[]>;
}

export function markId(capability: string, ask: string): string {
  return `${capability}${SEPARATOR}${ask}`;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One mark per intent and tool its asks called, the intents in the model's order. */
export function toolMarks(model: Pick<IntentMapModel, "asks" | "links">): MapMarks {
  const asks = new Set(model.asks.map((ask) => ask.id));
  const users = new Map<string, Set<string>>();
  for (const link of model.links) {
    if (!(link.weight > 0) || !asks.has(link.ask)) continue;
    users.set(link.capability, (users.get(link.capability) ?? new Set()).add(link.ask));
  }
  const byAsk = new Map<string, ToolMark[]>();
  for (const ask of model.asks) {
    const own = model.links
      .filter((link) => link.ask === ask.id && link.weight > 0)
      .sort((a, b) => b.weight - a.weight || byId(a.capability, b.capability))
      .map((link) => ({
        id: markId(link.capability, ask.id),
        capability: link.capability,
        ask: ask.id,
        weight: link.weight,
        share: link.share,
        shared: (users.get(link.capability)?.size ?? 0) > 1,
      }));
    byAsk.set(ask.id, own);
  }
  const marks = [...byAsk.values()].flat();
  const byCapability = new Map<string, ToolMark[]>();
  for (const mark of marks)
    byCapability.set(mark.capability, [...(byCapability.get(mark.capability) ?? []), mark]);
  for (const list of byCapability.values())
    list.sort((a, b) => b.weight - a.weight || byId(a.ask, b.ask));
  return { marks, byId: new Map(marks.map((mark) => [mark.id, mark])), byCapability, byAsk };
}

/** The model the layout places: every mark a tool of its own, in its one intent, sized by its calls there. */
export function markModel(model: IntentMapModel, marks: MapMarks): IntentMapModel {
  const capabilities = new Map(model.capabilities.map((capability) => [capability.id, capability]));
  return {
    asks: model.asks,
    capabilities: marks.marks
      .flatMap((mark): MapCapability[] => {
        const capability = capabilities.get(mark.capability);
        return capability ? [{ ...capability, id: mark.id, calls: mark.weight, asks: 1 }] : [];
      })
      .sort((a, b) => b.calls - a.calls || byId(a.id, b.id)),
    links: marks.marks.map((mark) => ({
      ask: mark.ask,
      capability: mark.id,
      weight: mark.weight,
      share: mark.share,
    })),
    hidden: model.hidden,
  };
}

/** The intent map's drawing: blobs apart, each holding its own marks. */
export function computeMarkedLayout(
  model: IntentMapModel,
  view: { width: number; height: number },
): { layout: MapLayout; marks: MapMarks } {
  const marks = toolMarks(model);
  return { layout: computeMapLayout(markModel(model, marks), view), marks };
}

/** The order the keyboard walks: each intent, then the tools inside it. */
export function markOrder(model: Pick<IntentMapModel, "asks">, marks: MapMarks): string[] {
  return model.asks.flatMap((ask) => [
    ask.id,
    ...(marks.byAsk.get(ask.id) ?? []).map((mark) => mark.id),
  ]);
}
