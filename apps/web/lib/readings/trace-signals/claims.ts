import type { SelfCorrectionClaimFacts } from "@/lib/readings/trace-signals/claim-templates-self-corrections";
import {
  SELF_CORRECTION_CLAIM_TEMPLATES,
  SELF_CORRECTION_FIGURE_CAPTIONS,
  SELF_CORRECTION_KIND_LABELS,
  SELF_CORRECTION_KIND_TITLES,
} from "@/lib/readings/trace-signals/claim-templates-self-corrections";
import type { WorkflowClaimFacts } from "@/lib/readings/trace-signals/claim-templates-workflow";
import {
  WORKFLOW_CLAIM_TEMPLATES,
  WORKFLOW_FIGURE_CAPTIONS,
  WORKFLOW_KIND_LABELS,
  WORKFLOW_KIND_TITLES,
} from "@/lib/readings/trace-signals/claim-templates-workflow";
import type {
  ClaimSegment,
  SignalFigure,
  SignalKind,
  SubjectChip,
} from "@/lib/readings/trace-signals/view";

/**
 * The words on a signal card, in one place.
 *
 * Every signal kind gets a claim template (the sentence on the collapsed card)
 * and a "What to do" line (the fix, named in plain words). The engine fills the
 * templates with its counts when it writes a `SignalView`; the UI renders what
 * comes back and runs figures through {@link clampFigures} as a last guard.
 *
 * The rules the copy follows are the product's: a founder reads this, so no
 * engine names, no formulas, no model names, whole percents, one decimal at the
 * very most, and a subject is named once, as a chip the reader can click.
 *
 * Pure: no React, no I/O, no locale reads beyond `en-US` number grouping.
 */

/* - Figures ----------------------------------------------------------------- */

/** A share in [0, 1] as a whole percent. A real but tiny share reads "<1%", never "0%". */
export function formatSharePercent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  if (share >= 1) return "100%";
  const whole = Math.round(share * 100);
  if (whole === 0) return "<1%";
  // 99.6% is not everything; say so rather than print a 100 that is not true.
  if (whole === 100) return ">99%";
  return `${whole}%`;
}

/** A list position: `#7`. */
export function formatRank(rank: number): string {
  return `#${Math.max(1, Math.round(rank))}`;
}

/** A count with thousands grouping: `7,190`. */
export function formatCount(count: number): string {
  return Math.round(count).toLocaleString("en-US");
}

/**
 * A duration a person can read: `420 ms`, `1.4 s`, `12 s`, `3 min`. One decimal
 * only below ten seconds, where the tenth still means something.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 ms";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1_000;
  if (seconds < 10) {
    const tenth = Math.round(seconds * 10) / 10;
    return `${Number.isInteger(tenth) ? tenth.toFixed(0) : tenth.toFixed(1)} s`;
  }
  if (seconds < 90) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

/** The headline on the right of a card, from its value and unit. */
export function formatFigure(figure: Pick<SignalFigure, "value" | "unit">): string {
  switch (figure.unit) {
    case "share":
      return formatSharePercent(figure.value);
    case "rank":
      return formatRank(figure.value);
    case "ms":
      return formatDuration(figure.value);
    case "count":
      return formatCount(figure.value);
  }
}

const TWO_DECIMALS = /\d\.\d{2,}/;

/** True when the text prints a number with two or more decimals, which the page never does. */
export function hasTwoDecimals(text: string): boolean {
  return TWO_DECIMALS.test(text);
}

/**
 * The last guard before a figure reaches the page: a decimal percent becomes a
 * whole one (`41.23%` to `41%`), any other number with two or more decimals is
 * cut to one (`12.46 s` to `12.5 s`). Text with nothing to fix comes back as is.
 * Only for figures and claims; captured queries are the user's words and are
 * never rewritten.
 */
export function clampFigures(text: string): string {
  return text
    .replace(/(\d+\.\d+)(\s?%)/g, (_, number: string, percent: string) => {
      const value = Number(number);
      const whole = Math.round(value);
      if (whole === 0 && value > 0) return `<1${percent}`;
      if (whole === 100 && value < 100) return `>99${percent}`;
      return `${whole}${percent}`;
    })
    .replace(/\d+\.\d{2,}/g, (number) => (Math.round(Number(number) * 10) / 10).toFixed(1));
}

/* - Claims ------------------------------------------------------------------ */

/** A piece of a claim: plain text, or a catalog entry the UI draws as a chip. */
export type ClaimPart = string | { chip: SubjectChip };

/** A claim ready for `SignalView`: the sentence and the same sentence in pieces. */
export interface ClaimSentence {
  claim: string;
  claimSegments: readonly ClaimSegment[];
}

/** Joins parts into `claim` and `claimSegments` so the two can never disagree. */
export function claimFromParts(parts: readonly ClaimPart[]): ClaimSentence {
  const claimSegments: ClaimSegment[] = parts
    .filter((part) => typeof part !== "string" || part.length > 0)
    .map((part) =>
      typeof part === "string"
        ? { kind: "text", text: clampFigures(part) }
        : { kind: "subject", text: part.chip.label, chipId: part.chip.id },
    );
  return { claim: claimSegments.map((segment) => segment.text).join(""), claimSegments };
}

/**
 * What each kind's templates need. Shares are fractions in [0, 1], durations in
 * milliseconds; subjects are the chips the claim names, in claim order.
 */
export interface ClaimFactsByKind extends WorkflowClaimFacts, SelfCorrectionClaimFacts {
  first_try_miss: { tool: SubjectChip };
  buried_tool: { tool: SubjectChip; rank: number };
  magnet: { tool: SubjectChip; listedShare: number; pickedShare: number };
  dead_tool: { count: number };
  sequence_chain: { first: SubjectChip; then: SubjectChip; share: number };
  sibling_confusion: { a: SubjectChip; b: SubjectChip };
  error_loop: { tool: SubjectChip };
  no_follow_through: { tool: SubjectChip };
  /** `tool` set when the searches were led to one tool and lost there. */
  abandoned_search: { share: number; tool?: SubjectChip | null };
  padding_share: { listed: number; cutoffRank: number; belowShare: number };
  latency_outlier: { tool: SubjectChip; p95Ms: number; typicalMs: number };
  unstable_intent: { distinctTools: number };
  repeat_invoke: { tool: SubjectChip; calls: number };
  fragmented_intents: { standalone: number; total: number };
  /** Short labels of the two asks, already in the user's words. */
  cooccurring_intents: { first: string; second: string };
  tool_switch: { from: SubjectChip; to: SubjectChip; share: number };
  empty_result: { tool: SubjectChip; share: number };
  unknown_tool: { tool: SubjectChip };
  unused_tool: { tools: readonly SubjectChip[]; count: number };
  long_turn: { share: number; threshold: number; typical: number };
  /** `code` is the error code the refusals named most, when they named one. */
  blocked_action: { tool: SubjectChip; code: string | null };
  identical_retry: { tool: SubjectChip; share: number };
  wait_heavy: { tool: SubjectChip; share: number; medianMs: number };
  token_heavy: { turnShare: number; tokenShare: number };
  system_turn_failing: { share: number; personShare: number };
  /** `agent` is the agent's own name; `tools` the tools behind its failures. */
  agent_failing: {
    agent: string;
    share: number;
    othersShare: number;
    tools: readonly SubjectChip[];
  };
}

export interface ClaimTemplate<K extends SignalKind> {
  /** The sentence on the collapsed card. */
  claim: (facts: ClaimFactsByKind[K]) => readonly ClaimPart[];
  /** The "What to do" line. */
  fix: (facts: ClaimFactsByKind[K]) => string;
}

const chip = (value: SubjectChip): ClaimPart => ({ chip: value });

/** Plural helper for the few templates that count things. */
function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${Math.round(count) === 1 ? one : many}`;
}

export const CLAIM_TEMPLATES: { readonly [K in SignalKind]: ClaimTemplate<K> } = {
  first_try_miss: {
    claim: ({ tool }) => [
      "The agent had to search again for the same thing before it found ",
      chip(tool),
      ".",
    ],
    fix: ({ tool }) =>
      `Rewrite ${tool.label}'s description with the words people use when they ask for it.`,
  },
  buried_tool: {
    claim: ({ tool, rank }) => [
      chip(tool),
      ` is the right tool and sits at ${formatRank(rank)} when picked.`,
    ],
    fix: ({ tool }) =>
      `Move ${tool.label} up for the asks that end in it, then sharpen its description.`,
  },
  magnet: {
    claim: ({ tool, listedShare, pickedShare }) => [
      chip(tool),
      pickedShare > 0
        ? ` rides into ${formatSharePercent(listedShare)} of lists and is picked in ${formatSharePercent(pickedShare)}.`
        : ` rides into ${formatSharePercent(listedShare)} of lists and is never picked.`,
    ],
    fix: () => "Narrow its description so it stops matching reads.",
  },
  dead_tool: {
    claim: ({ count }) => [
      `${plural(count, "tool was", "tools were")} never listed and never run.`,
    ],
    fix: ({ count }) =>
      count === 1
        ? "Retire it, or fold it into a tool that does get used."
        : "Retire them, or fold each into a tool that does get used.",
  },
  sequence_chain: {
    claim: ({ first, then, share }) => [
      chip(first),
      " precedes ",
      chip(then),
      ` ${formatSharePercent(share)} of the time.`,
    ],
    fix: ({ first, then }) =>
      `Add one tool or skill that runs ${first.label} and ${then.label} together, so the agent stops searching between them.`,
  },
  sibling_confusion: {
    claim: ({ a, b }) => [chip(a), " and ", chip(b), " are shown together and picked at random."],
    fix: () => "Rewrite both descriptions to say what each one is for and when to pick it.",
  },
  error_loop: {
    claim: ({ tool }) => [chip(tool), " fails and is retried in the same turn."],
    fix: ({ tool }) =>
      `Show these turns to whoever owns ${tool.label}. Retrying the same call does not fix it.`,
  },
  no_follow_through: {
    claim: ({ tool }) => [
      "After running ",
      chip(tool),
      ", the agent searched again for the same thing.",
    ],
    fix: ({ tool }) =>
      `Rewrite ${tool.label}'s description to say exactly what it returns, so the agent stops expecting more.`,
  },
  abandoned_search: {
    claim: ({ share, tool }) =>
      tool
        ? [
            `${formatSharePercent(share)} of searches that listed `,
            chip(tool),
            " led to no tool call.",
          ]
        : [`${formatSharePercent(share)} of searches led to no tool call.`],
    fix: () =>
      "Look for a missing tool. These searches found nothing the agent was willing to run.",
  },
  padding_share: {
    claim: ({ listed, cutoffRank, belowShare }) => [
      `Lists are filled to ${formatCount(listed)}; picks below ${formatRank(cutoffRank)} are ${formatSharePercent(belowShare)}.`,
    ],
    fix: ({ listed, cutoffRank }) =>
      `Return ${formatCount(cutoffRank)} results per search instead of ${formatCount(listed)}. The agent rarely picks lower, and every extra result costs tokens.`,
  },
  latency_outlier: {
    claim: ({ tool, p95Ms, typicalMs }) => [
      chip(tool),
      ` takes ${formatDuration(p95Ms)} on its slow calls, against ${formatDuration(typicalMs)} for a typical tool.`,
    ],
    fix: ({ tool }) => `Nothing to change in the catalog. The time is spent inside ${tool.label}.`,
  },
  unstable_intent: {
    claim: ({ distinctTools }) => [
      `The same ask resolves to ${plural(distinctTools, "tool", "different tools")}.`,
    ],
    fix: () => "Pin the tool that worked for this ask, so it comes first next time.",
  },
  repeat_invoke: {
    claim: ({ tool, calls }) => [
      chip(tool),
      ` is called ${formatCount(calls)} or more times in one turn.`,
    ],
    fix: () =>
      "Look at these turns. Several calls in a row usually means the tool does too little per call.",
  },
  fragmented_intents: {
    claim: ({ standalone, total }) => [
      `${formatCount(standalone)} of ${formatCount(total)} asks stand alone.`,
    ],
    fix: () =>
      "Group repeated asks so the agent can learn from them. Most are one-off phrasings of the same few jobs.",
  },
  cooccurring_intents: {
    claim: ({ first, second }) => [`“${first}” and “${second}” arrive in the same turn.`],
    fix: () => "Add one tool or skill that handles both asks together.",
  },
  tool_switch: {
    claim: ({ from, to, share }) => [
      "The agent tries ",
      chip(from),
      ", gets nothing it can use, and switches to ",
      chip(to),
      ` in ${formatSharePercent(share)} of the turns that call it.`,
    ],
    fix: ({ from, to }) =>
      `Say in ${from.label}'s description when to use ${to.label} instead, so the agent goes there first.`,
  },
  empty_result: {
    claim: ({ tool, share }) => [
      chip(tool),
      ` returns nothing in ${formatSharePercent(share)} of its calls.`,
    ],
    fix: ({ tool }) =>
      `Rewrite ${tool.label}'s description to say what input it needs and when it finds nothing.`,
  },
  unknown_tool: {
    claim: ({ tool }) => ["The agent calls ", chip(tool), ", a tool it does not have."],
    fix: ({ tool }) => `Add ${tool.label}, or fix the prompt that makes the agent expect it.`,
  },
  unused_tool: {
    claim: ({ tools, count }) => [
      `${plural(count, "tool was", "tools were")} offered to the model on every call and never called: `,
      ...tools.flatMap((tool, i): ClaimPart[] => [...(i === 0 ? [] : [", "]), chip(tool)]),
      count > tools.length ? ` and ${count - tools.length} more.` : ".",
    ],
    fix: () => "Stop sending these tools to the model, or retire them. Every offer costs tokens.",
  },
  long_turn: {
    claim: ({ share, threshold, typical }) => [
      `${formatSharePercent(share)} of turns take ${formatCount(threshold)} or more model calls, against ${formatCount(typical)} in a typical turn.`,
    ],
    fix: () =>
      "Look at these turns. When the same tools come up again and again, one tool that does the whole job saves the round trips.",
  },
  blocked_action: {
    claim: ({ tool, code }) => [
      "The agent asks ",
      chip(tool),
      ` for things it is not allowed to do${code ? ` (${code})` : ""}.`,
    ],
    fix: ({ tool }) =>
      `Tell the agent what ${tool.label} may do, or stop offering it where it will be refused.`,
  },
  identical_retry: {
    claim: ({ tool, share }) => [
      "After ",
      chip(tool),
      ` fails, the agent sends the same call again in ${formatSharePercent(share)} of those turns.`,
    ],
    fix: ({ tool }) =>
      `Make ${tool.label}'s errors say what to change, so the agent fixes the call instead of repeating it.`,
  },
  wait_heavy: {
    claim: ({ tool, share, medianMs }) => [
      `Turns spend ${formatSharePercent(share)} of their time waiting on `,
      chip(tool),
      `, about ${formatDuration(medianMs)} a call.`,
    ],
    fix: ({ tool }) =>
      `Have ${tool.label} report back when it is done, instead of holding the turn open while it waits.`,
  },
  token_heavy: {
    claim: ({ turnShare, tokenShare }) => [
      `The heaviest ${formatSharePercent(turnShare)} of turns use ${formatSharePercent(tokenShare)} of all input tokens.`,
    ],
    fix: () =>
      "Look at these turns. Long histories and large tool results carried into every model call are the usual cause.",
  },
  system_turn_failing: {
    claim: ({ share, personShare }) => [
      `Turns started by a background task or subagent fail ${formatSharePercent(share)} of the time, against ${formatSharePercent(personShare)} for turns people start.`,
    ],
    fix: () =>
      "Look at what these background turns are asked to do. They often lack the context a person would give.",
  },
  agent_failing: {
    claim: ({ agent, share, othersShare, tools }) => [
      `The ${agent} agent's tool calls fail ${formatSharePercent(share)} of the time, against ${formatSharePercent(othersShare)} for the other agents`,
      ...(tools.length > 0
        ? [
            ", mostly in ",
            ...tools.flatMap((tool, i): ClaimPart[] => [
              ...(i === 0 ? [] : [i === tools.length - 1 ? " and " : ", "]),
              chip(tool),
            ]),
          ]
        : []),
      ".",
    ],
    fix: ({ agent }) =>
      `Look at what the ${agent} agent is given to work with: its instructions, tools and inputs.`,
  },
  ...WORKFLOW_CLAIM_TEMPLATES,
  ...SELF_CORRECTION_CLAIM_TEMPLATES,
};

/** The claim sentence for a kind, filled with its facts. */
export function claimFor<K extends SignalKind>(kind: K, facts: ClaimFactsByKind[K]): ClaimSentence {
  const template = CLAIM_TEMPLATES[kind] as ClaimTemplate<K>;
  return claimFromParts(template.claim(facts));
}

/** The "What to do" line for a kind, filled with its facts. */
export function fixFor<K extends SignalKind>(kind: K, facts: ClaimFactsByKind[K]): string {
  const template = CLAIM_TEMPLATES[kind] as ClaimTemplate<K>;
  return clampFigures(template.fix(facts));
}

/** A short plain name per kind, for the kind glyph's label. */
export const SIGNAL_KIND_LABELS: { readonly [K in SignalKind]: string } = {
  first_try_miss: "Missed on the first search",
  buried_tool: "Found low in the list",
  magnet: "Shows up, never picked",
  dead_tool: "Never used",
  sequence_chain: "Always run together",
  sibling_confusion: "Two tools mixed up",
  error_loop: "Fails and retries",
  no_follow_through: "Searched again right after",
  abandoned_search: "Searched, ran nothing",
  padding_share: "Lists longer than needed",
  latency_outlier: "Slow",
  unstable_intent: "Same ask, different tools",
  repeat_invoke: "Called over and over",
  fragmented_intents: "Asks that never repeat",
  cooccurring_intents: "Asks that travel together",
  tool_switch: "Switched to another tool",
  empty_result: "Comes back empty",
  unknown_tool: "Tool that does not exist",
  unused_tool: "Offered, never called",
  long_turn: "Many model calls",
  blocked_action: "Not allowed",
  identical_retry: "Same failed call again",
  wait_heavy: "Waits on a tool",
  token_heavy: "Token-heavy turns",
  system_turn_failing: "Background turns fail",
  agent_failing: "One agent fails more",
  ...WORKFLOW_KIND_LABELS,
  ...SELF_CORRECTION_KIND_LABELS,
};

/**
 * The headline a problem row leads with: three to six plain words that say
 * what kind of problem it is before the reader meets a tool name or a figure.
 */
export const SIGNAL_KIND_TITLES: { readonly [K in SignalKind]: string } = {
  first_try_miss: "Needs a second search",
  buried_tool: "Right tool sits too low",
  magnet: "Wrong tool keeps showing up",
  dead_tool: "Tools nobody uses",
  sequence_chain: "Two tools always run together",
  sibling_confusion: "Two tools get mixed up",
  error_loop: "Retries after errors",
  no_follow_through: "Searches again right after",
  abandoned_search: "Searches that run nothing",
  padding_share: "Lists are padded",
  latency_outlier: "Slow tool",
  unstable_intent: "Same ask, different tools",
  repeat_invoke: "Called over and over",
  fragmented_intents: "Asks that never repeat",
  cooccurring_intents: "Asks that come together",
  tool_switch: "Tries one tool, uses another",
  empty_result: "Tool often returns nothing",
  unknown_tool: "Calls a missing tool",
  unused_tool: "Offered every time, never called",
  long_turn: "Turns with many model calls",
  blocked_action: "Tries what it may not do",
  identical_retry: "Repeats a failed call unchanged",
  wait_heavy: "Turns spent waiting",
  token_heavy: "A few turns use most tokens",
  system_turn_failing: "Background turns fail more",
  agent_failing: "One subagent fails more often",
  ...WORKFLOW_KIND_TITLES,
  ...SELF_CORRECTION_KIND_TITLES,
};

/**
 * The tiny unit under a row's big figure, per kind, so "72%" reads as "72%
 * weak results" without a sentence. A figure's own `caption` wins, for the
 * kinds whose figure measures different things depending on what was captured.
 */
export const SIGNAL_FIGURE_CAPTIONS: { readonly [K in SignalKind]: string } = {
  first_try_miss: "searched twice",
  buried_tool: "usual spot",
  magnet: "of lists",
  dead_tool: "unused",
  sequence_chain: "of turns",
  sibling_confusion: "swaps",
  error_loop: "errors",
  no_follow_through: "searched again",
  abandoned_search: "ran nothing",
  padding_share: "picked low",
  latency_outlier: "slowest calls",
  unstable_intent: "same tool",
  repeat_invoke: "turns",
  fragmented_intents: "one-off asks",
  cooccurring_intents: "turns",
  tool_switch: "switched",
  empty_result: "empty",
  unknown_tool: "calls",
  unused_tool: "offers",
  long_turn: "of turns",
  blocked_action: "refused",
  identical_retry: "retried as is",
  wait_heavy: "of turn time",
  token_heavy: "of tokens",
  system_turn_failing: "failed",
  agent_failing: "failed",
  ...WORKFLOW_FIGURE_CAPTIONS,
  ...SELF_CORRECTION_FIGURE_CAPTIONS,
};

/** A problem row's headline, from its kind. */
export function signalTitle(kind: SignalKind): string {
  return SIGNAL_KIND_TITLES[kind];
}

/** The unit under a row's figure: the figure's own caption, else its kind's. */
export function figureCaption(kind: SignalKind, figure: Pick<SignalFigure, "caption">): string {
  return figure.caption ?? SIGNAL_FIGURE_CAPTIONS[kind];
}
