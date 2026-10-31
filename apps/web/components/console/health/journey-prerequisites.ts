import { prerequisiteSentence } from "@/components/console/health/journey-copy";
import type { JourneyPrerequisite } from "@/lib/readings/trace-signals/flow-journey-insights";
import {
  acrossChipKey,
  acrossFocus,
  parseAcrossChip,
} from "@/lib/views/health/flow-journey-across";
import {
  type JourneyPrerequisiteFocus,
  journeyPrerequisiteFocus,
} from "@/lib/views/health/flow-journey-focus";
import {
  countText,
  JOURNEY_CHIP,
  JOURNEY_GRID,
  type JourneyFocus,
  type JourneyLayout,
  type JourneyNode,
  toolIdOf,
} from "@/lib/views/health/flow-journey-layout";

/**
 * The journey filtered to what each tool needs first: each pair's two ends
 * and the calls between them, which stay in their columns as quieter "via"
 * steps. `compactJourney` packs what stays; this says what it shows.
 */
export interface PrerequisiteView {
  /** What to light: the pointed tool's relations, or every relation at rest. */
  focus: JourneyFocus;
  /** Chips outside every relation's turns. */
  hidden: ReadonlySet<string>;
  /** Chips lit only as a step between a pair's two ends. */
  via: ReadonlySet<string>;
  /** Chip key to the line it shows instead of its count, on each needing end. */
  captions: ReadonlyMap<string, string>;
  /** What a chip of a pair that crosses turns says to a screen reader: its pairs, as sentences. */
  labels: ReadonlyMap<string, string>;
  /** What the readout says for the pointed chip, or null at rest. */
  sentences: readonly string[] | null;
  /** At rest, when "usually" pairs are shown too: the "almost always" turns alone, drawn over the lighter rest. */
  strong: JourneyFocus | null;
  /** Whether a kept chip is pointed at (or pinned). */
  pointed: boolean;
}

const CAPTION_CHAR = 10.5 * 0.6;
const FLAG_ROOM = 15;
/** Fewer characters than this of a tool's name read as noise. */
const MIN_NAME = 5;

function fit(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`;
}

/** "100% after find_task", or "95% after find_task +1" for a tool that needs two tools first. */
export function prerequisiteCaption(
  node: Pick<JourneyNode, "w" | "flags">,
  relations: readonly JourneyPrerequisite[],
): string {
  const [top, ...rest] = [...relations].sort(
    (a, b) => b.confidence - a.confidence || (a.first < b.first ? -1 : 1),
  );
  const more = rest.length > 0 ? ` +${rest.length}` : "";
  const chars = Math.floor(
    (node.w - JOURNEY_CHIP.textX - JOURNEY_CHIP.padR - node.flags.length * FLAG_ROOM) /
      CAPTION_CHAR,
  );
  const percent = `${Math.round(top.confidence * 100)}%`;
  const head = `${percent} after `;
  const room = chars - head.length - more.length;
  // Too narrow to name the tool: the share alone, the readout names it.
  if (room < MIN_NAME) return `${percent}${more}`;
  return `${head}${fit(top.firstLabel, room)}${more}`;
}

/** Relations touching a tool, the ones it needs first before the ones that need it. */
export function relationsOfTool(
  tool: string,
  relations: readonly JourneyPrerequisite[],
): JourneyPrerequisite[] {
  return [
    ...relations.filter((r) => r.tool === tool),
    ...relations.filter((r) => r.first === tool),
  ];
}

/**
 * What the packed map shows. `relations` are the pairs drawn along the
 * journey (`all` is their focus on `layout`); `across` are the pairs that
 * cross turns, drawn as direct links between their own chips.
 */
export function prerequisiteView(
  layout: JourneyLayout,
  relations: readonly JourneyPrerequisite[],
  all: JourneyPrerequisiteFocus,
  current: string | null,
  across: readonly JourneyPrerequisite[] = [],
): PrerequisiteView {
  const hidden = new Set(
    layout.nodes.filter((node) => !all.focus.nodes.has(node.key)).map((node) => node.key),
  );
  const via = new Set(
    [...all.focus.nodes.keys()].filter((key) => !all.needs.has(key) && !all.firsts.has(key)),
  );
  const captions = new Map<string, string>();
  for (const node of layout.nodes) {
    const needs = all.needs.get(node.key);
    if (needs && needs.length > 0) captions.set(node.key, prerequisiteCaption(node, needs));
  }
  const labels = new Map<string, string>();
  for (const relation of across) {
    captions.set(
      acrossChipKey(relation, "tool"),
      prerequisiteCaption({ w: JOURNEY_GRID.callWidth, flags: [] }, [relation]),
    );
    labels.set(acrossChipKey(relation, "first"), prerequisiteSentence(relation));
    labels.set(acrossChipKey(relation, "tool"), prerequisiteSentence(relation));
  }
  const base = { hidden, via, captions, labels };
  const pointed = current && !hidden.has(current) ? current : null;
  if (!pointed) {
    const strongOnly = relations.filter((r) => r.tier === "strong");
    const strong =
      strongOnly.length < relations.length
        ? journeyPrerequisiteFocus(layout, strongOnly).focus
        : null;
    return { ...base, focus: all.focus, sentences: null, strong, pointed: false };
  }
  const row = parseAcrossChip(pointed);
  if (row) {
    const mine = across.filter((r) => r.first === row.first && r.tool === row.tool);
    return {
      ...base,
      focus: acrossFocus(mine, pointed),
      sentences: mine.map(prerequisiteSentence),
      strong: null,
      pointed: true,
    };
  }
  const tool = toolIdOf(pointed);
  const touching = tool ? relationsOfTool(tool, relations) : [];
  if (touching.length === 0) {
    const node = layout.nodes.find((n) => n.key === pointed);
    const turns = all.focus.nodes.get(pointed) ?? 0;
    return {
      ...base,
      focus: { ...all.focus, node: pointed },
      sentences: [
        `${node?.label ?? pointed} ran in between, in ${countText(turns)} of these turns.`,
      ],
      strong: null,
      pointed: true,
    };
  }
  const own = journeyPrerequisiteFocus(layout, touching).focus;
  return {
    ...base,
    focus: { ...own, node: pointed },
    sentences: touching.map(prerequisiteSentence),
    strong: null,
    pointed: true,
  };
}
