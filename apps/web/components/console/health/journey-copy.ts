import { TINT_MEANING } from "@/components/console/health/flow-copy";
import type {
  JourneyChain,
  JourneyPrerequisite,
} from "@/lib/readings/trace-signals/flow-journey-insights";
import type { FlowJourneyFlag } from "@/lib/readings/trace-signals/view";
import {
  countText,
  JOURNEY_EXPAND_STEP,
  type JourneyFocus,
  type JourneyLayout,
  type JourneyNode,
  ordinal,
} from "@/lib/views/health/flow-journey-layout";

/**
 * Words for the journey map: node aria-labels and the readout under the
 * drawing that says, in short plain sentences, what the lit part shows. Kept
 * apart from the drawing so the copy reads in one place and tests can pin it.
 */

function turns(n: number): string {
  return `${countText(n)} ${n === 1 ? "turn" : "turns"}`;
}

const FLAG_WORD: Record<FlowJourneyFlag, string> = {
  errors: "Calls often fail",
  slow: "Calls are slow",
};

/** "update_task, 2nd call: 179 turns, 73 ended there". */
export function journeyNodeAriaLabel(node: JourneyNode): string {
  const ended = node.ended > 0 ? `, ${countText(node.ended)} ended there` : "";
  switch (node.kind) {
    case "other": {
      const offer = expandLabel(node);
      const tail = offer
        ? `. Press to ${offer === "show all" ? "show them all" : `${offer} more`}`
        : "";
      return `${node.label}, ${ordinal(node.call)} call: ${turns(node.turns)}${tail}`;
    }
    case "later":
      return `Later calls, ${node.label}: ${turns(node.turns)} went on. Press to open the next call`;
    case "search":
      return `Searched first: ${turns(node.turns)}${ended}`;
    case "none":
      return `No search first: ${turns(node.turns)}${ended}`;
    case "agent":
      return `Agent started: ${turns(node.turns)}${ended}`;
    case "more":
      return `More than ${node.column - 1} calls: ${turns(node.turns)}`;
    case "ended":
      return node.column === 1
        ? `Ended without a call: ${turns(node.turns)}`
        : `Ended after the ${ordinal(node.column - 1)} call: ${turns(node.turns)}`;
    default: {
      const flags = node.flags.map((flag) => `, ${FLAG_WORD[flag].toLowerCase()}`).join("");
      return `${node.label}, ${ordinal(node.call)} call: ${turns(node.turns)}${ended}${flags}`;
    }
  }
}

export interface JourneyReadout {
  title: string;
  /** "2nd call"; null where the title says it all. */
  place: string | null;
  lines: string[];
  /** What the tool's state colour means, when it has one. */
  meaning: string | null;
}

/** Where else the same tool was called, from the whole drawing. */
function elsewhere(node: JourneyNode, layout: JourneyLayout): string | null {
  if (node.kind !== "tool" && node.kind !== "skill") return null;
  const others = layout.nodes
    .filter((other) => other.id === node.id && other.key !== node.key)
    .sort((a, b) => a.call - b.call)
    .map((other) => `${ordinal(other.call)} call in ${countText(other.turns)}`);
  if (others.length === 0) return null;
  const more = others.length > 3 ? ` and ${others.length - 3} more` : "";
  return `Also the ${others.slice(0, 3).join(", ")}${more}`;
}

function startReadout(node: JourneyNode): JourneyReadout {
  if (node.kind === "search") {
    return {
      title: "Searched first",
      place: null,
      lines: [
        `${turns(node.turns)} searched before calling anything`,
        ...(node.ended > 0 ? [`${countText(node.ended)} then called nothing`] : []),
      ],
      meaning: null,
    };
  }
  if (node.kind === "agent") {
    return {
      title: "Agent started",
      place: null,
      lines: [`${turns(node.turns)} started with the agent's own first call`],
      meaning: null,
    };
  }
  return {
    title: "No search first",
    place: null,
    lines: [
      `${turns(node.turns)} called a tool straight away`,
      "Searches Ratel never received count here too",
    ],
    meaning: null,
  };
}

/** The sentences the readout shows for a node in focus. */
export function journeyReadout(
  node: JourneyNode,
  layout: JourneyLayout,
  focus: JourneyFocus,
): JourneyReadout {
  if (node.kind === "search" || node.kind === "none" || node.kind === "agent")
    return startReadout(node);
  if (node.kind === "later") {
    return {
      title: "Later calls",
      place: node.label,
      lines: [
        `${turns(node.turns)} made a ${ordinal(node.call)} call`,
        "Click, or scroll right, to open the next call",
      ],
      meaning: null,
    };
  }
  if (node.kind === "more") {
    return {
      title: "More calls",
      place: null,
      lines: [`${turns(node.turns)} made more than ${node.column - 1} calls`],
      meaning: null,
    };
  }
  if (node.kind === "ended") {
    const line =
      node.column === 1
        ? `${turns(node.turns)} searched and then called nothing`
        : `${turns(node.turns)} stopped after their ${ordinal(node.column - 1)} call`;
    return { title: "Ended", place: null, lines: [line], meaning: null };
  }
  const place = `${ordinal(node.call)} call`;
  const lines =
    node.kind === "other"
      ? [
          `${turns(node.turns)} called one of ${node.otherCount ? countText(node.otherCount) : "the"} less used tools`,
        ]
      : [`${turns(node.turns)} called it ${ordinal(node.call)}`];
  const repeat = node.call > 1 ? (focus.nodes.get(`c${node.call - 1}:${node.id}`) ?? 0) : 0;
  if (repeat > 0 && node.kind !== "other") lines.push(`${countText(repeat)} had just called it`);
  if (node.ended > 0) lines.push(`${countText(node.ended)} ended here`);
  const offer = node.kind === "other" ? expandLabel(node) : null;
  if (offer)
    lines.push(
      offer === "show all" ? "Click to show them all by name" : `Click to ${offer} more by name`,
    );
  const also = elsewhere(node, layout);
  if (also) lines.push(also);
  const meanings = [
    ...(node.tint === "none" || node.tint === "dead" ? [] : [TINT_MEANING[node.tint]]),
    ...node.flags.map((flag) => FLAG_WORD[flag]),
  ];
  return {
    title: node.label,
    place,
    lines,
    meaning: meanings.length > 0 ? meanings.join(" · ") : null,
  };
}

/**
 * What a "+N tools" chip offers to reveal: the next three named tools, fewer
 * when fewer remain ("show 2"), or "show all" when that empties the fold.
 * Null when nothing more can be named.
 */
export function expandLabel(node: Pick<JourneyNode, "expandable" | "otherCount">): string | null {
  const next = Math.min(JOURNEY_EXPAND_STEP, node.expandable);
  if (next <= 0) return null;
  return next === node.otherCount ? "show all" : `show ${next}`;
}

/** The readout at rest, before anything is in focus. */
export const JOURNEY_IDLE_HINT = "Point at any step to trace its turns. Click to keep it lit.";
/** The same on a phone, where the drawing scrolls sideways. */
export const JOURNEY_IDLE_HINT_TOUCH =
  "Swipe sideways to follow the turns. Tap a step to trace it.";

/** "Common chains" when no chain passes its thresholds. */
export const CHAINS_EMPTY = "No chain of two or more calls repeats often enough yet.";
/** "Needs first" when no tool clearly depends on another. */
export const NEEDS_FIRST_EMPTY = "No tool clearly needs another one first yet.";
/** What to do about a tool that needs another first. */
export const NEEDS_FIRST_ADVICE =
  "Say so in the tool's description, or let it accept what the first tool looks up.";

/** "find_task ran first in 78% of its 212 turns", the rest of a "Needs first" row after the tool's name. */
export function needsFirstText(
  row: Pick<JourneyPrerequisite, "firstLabel" | "confidence" | "turns">,
): string {
  return `${row.firstLabel} ran first in ${Math.round(row.confidence * 100)}% of its ${countText(row.turns)} turns`;
}

/** The prerequisites card. */
export const PREREQ_TITLE = "What each tool needs first";
export const PREREQ_INTRO =
  "Every turn, left to right: how it started, then each call in order. At first it keeps only the tools that almost always run before another, and the turns between them. Show all brings back the rest.";

/**
 * The intro when the run counted pairs across a session: says the window, in
 * minutes, and that a dashed link joins tools called in different turns.
 */
export function prerequisiteIntro(windowMinutes: number | null, crossTurn: boolean): string {
  if (windowMinutes === null) return PREREQ_INTRO;
  const cross = crossTurn ? " A dashed link joins two tools called in different turns." : "";
  return `Every turn, left to right: how it started, then each call in order. At first it keeps only the tools that almost always run within ${minutesText(windowMinutes)} before another in the same session, and the turns between them.${cross} Show all brings back the rest.`;
}

function minutesText(minutes: number): string {
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}
/** The intro when no tool needs another first: the map is shown whole. */
export const JOURNEY_INTRO = "Every turn, left to right: how it started, then each call in order.";
export const PREREQ_HINT = "Point at a tool to read what it needs first.";
/** The map's two states. */
export const PREREQ_FILTER_LABEL = "Prerequisites";
export const SHOW_ALL_LABEL = "Show all";

/** "assign_task: find_task ran first in 100% of its 98 turns", one relation as a sentence. */
export function prerequisiteSentence(
  row: Pick<
    JourneyPrerequisite,
    "toolLabel" | "firstLabel" | "confidence" | "turns" | "scope" | "windowMinutes"
  >,
): string {
  const percent = Math.round(row.confidence * 100);
  if (row.scope === "window" && row.windowMinutes) {
    // "create_tag ran in the 10 minutes before add_tag_to_task in 93% of its 42 uses"
    return `${row.firstLabel} ran in the ${minutesText(row.windowMinutes)} before ${row.toolLabel} in ${percent}% of its ${countText(row.turns)} uses`;
  }
  if (row.scope === "turn") {
    return `${row.toolLabel}: ${row.firstLabel} ran first in the same turn in ${percent}% of its ${countText(row.turns)} uses`;
  }
  return `${row.toolLabel}: ${needsFirstText(row)}`;
}

export interface PrerequisiteWhy {
  /** Of all turns, those that made one call or none. */
  singleCallShare: number;
  /** Of all turns, those whose boundaries were inferred from timing. */
  inferredShare: number;
  /** The strongest pair that fell short. */
  closest: Pick<JourneyPrerequisite, "toolLabel" | "firstLabel" | "confidence" | "turns"> | null;
}

/** A share at or over this is "most turns". */
const MOST = 0.5;

/** When no tool clearly needs another first, one line of why, when it is knowable. */
export function prerequisiteEmptyReason({
  singleCallShare,
  inferredShare,
  closest,
}: PrerequisiteWhy): string | null {
  const single = singleCallShare >= MOST;
  const inferred = inferredShare >= MOST;
  const share = `${Math.round(singleCallShare * 100)}%`;
  if (single && inferred) {
    return `Most turns (${share}) make one call or none, and turns here are split by timing, so there is little order to read.`;
  }
  if (single)
    return `Most turns (${share}) make one call or none, so there is little order to read.`;
  if (inferred)
    return "Turns here are split by timing, not marked by the agent, so the order of calls is less certain.";
  if (closest) {
    return `The closest: ${closest.toolLabel} came after ${closest.firstLabel} in ${Math.round(closest.confidence * 100)}% of its ${countText(closest.turns)} turns.`;
  }
  return null;
}

/** "84 turns · 7%", a chain's weight. */
export function chainWeightText(chain: Pick<JourneyChain, "turns" | "share">): string {
  const percent = chain.share * 100;
  return `${turns(chain.turns)} · ${percent < 1 ? "<1" : Math.round(percent)}%`;
}
