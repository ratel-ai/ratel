import { formatDuration, formatRank } from "@/lib/readings/trace-signals/claims";
import type {
  EvidenceTurn,
  SignalKind,
  SignalView,
  TurnStoryStep,
} from "@/lib/readings/trace-signals/view";

/**
 * What an example turn means, per kind of problem, so a reader knows whose
 * fault it was before reading the steps.
 *
 * A magnet example is not an agent mistake: the agent picked the right tool,
 * and the problem is only that another tool took a slot in the list. Marking
 * that entry coral with "not picked" read as "the agent skipped the right
 * tool", so each kind here says three things: a verdict (whose fault), how
 * its flagged step is marked (a coral fault only for real agent-side
 * failures), and one plain sentence filled from the example itself.
 *
 * Pure: no React, no I/O.
 */

/** Whose fault the example shows, in a tiny chip on each example. */
export type ExampleVerdict =
  | "agent_right"
  | "agent_struggled"
  | "tool_problem"
  | "catalog_gap"
  | "unclear";

export const VERDICT_LABELS: Record<ExampleVerdict, string> = {
  agent_right: "Agent got it right",
  agent_struggled: "Agent struggled",
  tool_problem: "Tool problem",
  catalog_gap: "Catalog gap",
  unclear: "Unclear",
};

/** The verdict icon's tooltip line, when the kind has nothing more specific to say. */
export const VERDICT_NOTES: Record<ExampleVerdict, string> = {
  agent_right:
    "The agent picked the right tool. The problem is elsewhere, not in the agent's choice.",
  agent_struggled: "The agent needed extra work to reach the right tool.",
  tool_problem: "The tool itself failed or was slow. The agent's choice was fine.",
  catalog_gap: "Nothing in the catalog matched what the agent needed.",
  unclear: "Not a mistake, but worth checking.",
};

/** Tooltip lines tailored to a kind, keyed by the verdict they explain. */
const KIND_NOTES: { readonly [K in SignalKind]?: Partial<Record<ExampleVerdict, string>> } = {
  magnet: {
    agent_right:
      "The agent picked the right tool. The problem is the extra tool in the list, not the agent's choice.",
  },
  padding_share: {
    agent_right:
      "The agent picked from the top of the list. The problem is a list longer than it needs to be.",
  },
  first_try_miss: {
    agent_struggled:
      "The first search for this ask did not list the right tool, so the agent had to search again for the same thing.",
  },
  buried_tool: {
    agent_struggled: "The right tool was listed, but low, so the agent had to dig for it.",
  },
  sibling_confusion: {
    agent_struggled: "Two similar tools were listed, and the agent could not tell which one fits.",
  },
  no_follow_through: {
    agent_struggled:
      "The tool's answer did not settle the ask, so the agent searched again for the same thing.",
  },
  unstable_intent: {
    agent_struggled: "The same ask sends the agent to different tools on different turns.",
  },
  sequence_chain: {
    agent_right: "The agent ran the two tools in order without searching in between.",
    agent_struggled: "The agent needed another search to reach the second tool.",
  },
  error_loop: { tool_problem: "The tool itself failed. The agent's choice was fine." },
  latency_outlier: { tool_problem: "The tool itself was slow. The agent's choice was fine." },
  repeat_invoke: {
    unclear:
      "Calling a tool again can be a real follow-up or a wasted repeat. Worth checking which.",
  },
  cooccurring_intents: {
    agent_right: "Nothing went wrong. The two asks simply arrive in the same turn.",
  },
  tool_switch: {
    agent_struggled: "The first tool let the agent down, so it had to try another one.",
  },
  empty_result: { tool_problem: "The tool ran but returned nothing the agent could use." },
  unknown_tool: { catalog_gap: "The agent asked for a tool it does not have." },
  unused_tool: {
    unclear: "These tools were offered on every call here and the agent never needed them.",
  },
  long_turn: { agent_struggled: "The agent needed many model calls to finish this turn." },
  blocked_action: { catalog_gap: "The agent asked for something its access does not allow." },
  identical_retry: {
    agent_struggled: "The call had just failed, and the agent sent it again unchanged.",
  },
  wait_heavy: { tool_problem: "The turn sat waiting on this tool. The agent's choice was fine." },
  token_heavy: { agent_struggled: "This turn carried far more tokens than a typical one." },
  system_turn_failing: {
    agent_struggled: "A background task started this turn, and a call in it failed.",
  },
  agent_failing: { agent_struggled: "This agent's call failed, as its calls often do." },
  workflow_failing: {
    tool_problem: "This run stopped on a failed step, so the request was never finished.",
  },
  workflow_slow: { tool_problem: "This run took much longer than the agent's other tasks." },
  workflow_fixed_chain: {
    agent_right:
      "Nothing went wrong. The agent ran the same steps in the same order it always does.",
  },
  self_correcting: {
    agent_struggled:
      "The agent had to go back: it retried, switched tools, gave up, or the person asked again.",
  },
};

/** The verdict tooltip's one plain line: the kind's own when it has one, else the verdict's. */
export function exampleVerdictNote(kind: SignalKind, verdict: ExampleVerdict): string {
  return KIND_NOTES[kind]?.[verdict] ?? VERDICT_NOTES[verdict];
}

/**
 * How the flagged step is marked. `fault` is the coral ring: an agent-side
 * failure (an error, a retry, a wrong or late pick). `clutter` is an amber
 * "extra" marker on a listed entry the list did not need. `note` is a quiet
 * amber marker for something worth seeing that is nobody's mistake (a slow
 * call, a repeat). `neutral` is a muted marker.
 */
export type FlagTone = "fault" | "clutter" | "note" | "neutral";

export interface KindMeaning {
  verdict: ExampleVerdict;
  flagTone: FlagTone;
  /** Mark the pick after the flagged step with a subtle check: it was the right one. */
  checkNextPick: boolean;
}

export const EXAMPLE_KIND_MEANING: { readonly [K in SignalKind]: KindMeaning } = {
  magnet: { verdict: "agent_right", flagTone: "clutter", checkNextPick: true },
  padding_share: { verdict: "agent_right", flagTone: "clutter", checkNextPick: true },
  first_try_miss: { verdict: "agent_struggled", flagTone: "fault", checkNextPick: false },
  buried_tool: { verdict: "agent_struggled", flagTone: "fault", checkNextPick: false },
  sibling_confusion: { verdict: "agent_struggled", flagTone: "fault", checkNextPick: false },
  no_follow_through: { verdict: "agent_struggled", flagTone: "fault", checkNextPick: false },
  unstable_intent: { verdict: "agent_struggled", flagTone: "fault", checkNextPick: false },
  error_loop: { verdict: "tool_problem", flagTone: "fault", checkNextPick: false },
  latency_outlier: { verdict: "tool_problem", flagTone: "note", checkNextPick: false },
  repeat_invoke: { verdict: "unclear", flagTone: "note", checkNextPick: false },
  abandoned_search: { verdict: "catalog_gap", flagTone: "neutral", checkNextPick: false },
  sequence_chain: { verdict: "agent_right", flagTone: "neutral", checkNextPick: false },
  dead_tool: { verdict: "unclear", flagTone: "neutral", checkNextPick: false },
  fragmented_intents: { verdict: "unclear", flagTone: "neutral", checkNextPick: false },
  cooccurring_intents: { verdict: "agent_right", flagTone: "neutral", checkNextPick: false },
  tool_switch: { verdict: "agent_struggled", flagTone: "fault", checkNextPick: false },
  empty_result: { verdict: "tool_problem", flagTone: "note", checkNextPick: false },
  unknown_tool: { verdict: "catalog_gap", flagTone: "fault", checkNextPick: false },
  unused_tool: { verdict: "unclear", flagTone: "neutral", checkNextPick: false },
  long_turn: { verdict: "agent_struggled", flagTone: "note", checkNextPick: false },
  blocked_action: { verdict: "catalog_gap", flagTone: "fault", checkNextPick: false },
  identical_retry: { verdict: "agent_struggled", flagTone: "fault", checkNextPick: false },
  wait_heavy: { verdict: "tool_problem", flagTone: "note", checkNextPick: false },
  token_heavy: { verdict: "agent_struggled", flagTone: "note", checkNextPick: false },
  system_turn_failing: { verdict: "agent_struggled", flagTone: "fault", checkNextPick: false },
  agent_failing: { verdict: "agent_struggled", flagTone: "fault", checkNextPick: false },
  workflow_failing: { verdict: "tool_problem", flagTone: "fault", checkNextPick: false },
  workflow_slow: { verdict: "tool_problem", flagTone: "note", checkNextPick: false },
  workflow_fixed_chain: { verdict: "agent_right", flagTone: "neutral", checkNextPick: false },
  self_correcting: { verdict: "agent_struggled", flagTone: "fault", checkNextPick: false },
};

/**
 * A second search between the two tools of a chain is the agent working for
 * it; a straight run is the agent getting it right.
 */
export function exampleVerdict(
  kind: SignalKind,
  turn: Pick<EvidenceTurn, "steps">,
): ExampleVerdict {
  if (kind === "sequence_chain") {
    const flagged = turn.steps.find((step) => step.flag !== undefined);
    return flagged?.kind === "search" ? "agent_struggled" : "agent_right";
  }
  return EXAMPLE_KIND_MEANING[kind].verdict;
}

/** The subject's tool ids and display names, in claim order. */
export interface ExampleSubject {
  ids: readonly string[];
  names: readonly string[];
}

export function exampleSubject(signal: Pick<SignalView, "subject">): ExampleSubject {
  return {
    ids: signal.subject.chips.map((chip) => chip.id),
    names: signal.subject.chips.map((chip) => chip.label),
  };
}

type Invoke = Extract<TurnStoryStep, { kind: "invoke" }>;
type Search = Extract<TurnStoryStep, { kind: "search" }>;

const isInvoke = (step: TurnStoryStep): step is Invoke => step.kind === "invoke";

/** The step the example is about, and where it sits. */
function flaggedAt(steps: readonly TurnStoryStep[]): number {
  return steps.findIndex((step) => step.flag !== undefined);
}

/** The first pick after step `from`, if any: the tool the agent went with. */
export function nextPickIndex(steps: readonly TurnStoryStep[], from: number): number {
  if (from < 0) return -1;
  return steps.findIndex((step, i) => i > from && isInvoke(step) && step.pickedRank !== null);
}

/** A display name for a tool id: the subject's label when it is one, else the id. */
function nameOf(id: string, subject: ExampleSubject): string {
  const at = subject.ids.indexOf(id);
  return at >= 0 ? (subject.names[at] ?? id) : id;
}

/** A rank the flag label states ("at #7", "from #7"), since a search step does not carry it. */
function rankInLabel(label: string | undefined): number | null {
  const match = label ? /#(\d+)/.exec(label) : null;
  return match ? Number(match[1]) : null;
}

const times = (count: number): string =>
  count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;

/**
 * One plain sentence above an example: what this turn shows, with the names
 * and numbers of this turn where it has them, generic words where it does not.
 */
export function exampleWhy(
  kind: SignalKind,
  turn: Pick<EvidenceTurn, "steps">,
  subject: ExampleSubject,
): string {
  const steps = turn.steps;
  const at = flaggedAt(steps);
  const flagged = at >= 0 ? steps[at] : undefined;
  const [aId = "", bId = ""] = subject.ids;
  const a = subject.names[0] || aId || "This tool";
  const b = subject.names[1] || bId || "the other tool";
  const pickAt = nextPickIndex(steps, at);
  const pick = pickAt >= 0 ? (steps[pickAt] as Invoke) : undefined;
  const callsOfA = steps.filter((step) => isInvoke(step) && step.toolId === aId).length;

  switch (kind) {
    case "magnet":
      return pick
        ? `${a} took a slot it didn't need. The agent correctly picked ${nameOf(pick.toolId, subject)}.`
        : `${a} took a slot in this list without being needed.`;
    case "padding_share": {
      const listed = flagged?.kind === "search" ? (flagged as Search).listed : null;
      const best = pick?.pickedRank ?? rankInLabel(flagged?.flag?.label);
      return listed !== null && best !== null
        ? `The list showed ${listed} results, and the agent only needed ${formatRank(best)}.`
        : "The list was longer than the agent needed.";
    }
    case "buried_tool": {
      const rank =
        flagged && isInvoke(flagged) ? flagged.pickedRank : rankInLabel(flagged?.flag?.label);
      return rank !== null
        ? `${a} was listed at ${formatRank(rank)}, and the agent had to dig for it.`
        : `${a} was listed low, and the agent had to dig for it.`;
    }
    case "first_try_miss":
      // The flagged step is the search the agent had to repeat; the retry after it found the tool.
      return `The first search for this did not list ${a}, so the agent searched again for the same thing and found it there.`;
    case "sibling_confusion": {
      const chosen = flagged && isInvoke(flagged) ? nameOf(flagged.toolId, subject) : null;
      return chosen
        ? `${a} and ${b} were listed together, and the agent picked ${chosen} this time.`
        : `${a} and ${b} were listed together, and the agent could not tell them apart.`;
    }
    case "error_loop": {
      const retried = steps.some((step, i) => i > at && isInvoke(step) && step.toolId === aId);
      return retried ? `${a} failed, and the agent retried it.` : `${a} failed here.`;
    }
    case "latency_outlier":
      return flagged && isInvoke(flagged) && flagged.tookMs !== null
        ? `${a} took ${formatDuration(flagged.tookMs)} here.`
        : `${a} was slow here.`;
    case "no_follow_through":
      return `After ${a}, the agent searched again for the same thing.`;
    case "repeat_invoke":
      return callsOfA > 1
        ? `${a} ran ${times(callsOfA)} in this turn.`
        : `${a} ran more than once in this turn.`;
    case "abandoned_search":
      return "The agent searched but ran nothing.";
    case "sequence_chain":
      return flagged?.kind === "search"
        ? `The agent ran ${a}, then needed another search to reach ${b}.`
        : `The agent ran ${a}, then ${b}.`;
    case "unstable_intent": {
      const started = flagged && isInvoke(flagged) ? nameOf(flagged.toolId, subject) : null;
      return started
        ? `For this ask the agent started on ${started}; other times it went elsewhere.`
        : "The same ask went to a different tool this time.";
    }
    case "dead_tool":
      return "These tools never came up in a search.";
    case "fragmented_intents":
      return "This ask came up only once.";
    case "cooccurring_intents":
      return "Two asks arrived in this one turn.";
    case "tool_switch":
      return `${a} let the agent down here, so it switched to ${b}.`;
    case "empty_result":
      return `${a} came back with nothing here.`;
    case "unknown_tool":
      return `The agent called ${a} here, a tool it does not have.`;
    case "unused_tool":
      return "These tools were offered here and never called.";
    case "long_turn":
      return "This turn took many model calls to finish.";
    case "blocked_action":
      return `${a} refused the agent here: it is not allowed to do this.`;
    case "identical_retry":
      return `${a} failed here, and the agent sent the same call again.`;
    case "wait_heavy":
      return `This turn waited on ${a}.`;
    case "token_heavy":
      return "This turn used far more tokens than a typical one.";
    case "system_turn_failing":
      return "A background task started this turn, and it failed.";
    case "agent_failing":
      return `A call by this agent failed here${aId ? `, in ${a}` : ""}.`;
    case "workflow_failing":
      return flagged && isInvoke(flagged)
        ? `This run stopped when ${nameOf(flagged.toolId, subject)} failed.`
        : "This run stopped on a failed step.";
    case "workflow_slow":
      return "This run was one of the slowest of its kind.";
    case "workflow_fixed_chain":
      return "The agent ran these steps in the usual order.";
    case "self_correcting":
      return flagged?.flag
        ? `The agent corrected itself here: ${flagged.flag.label.toLowerCase()}.`
        : "The agent corrected itself in this turn.";
  }
}

/**
 * The flag label as the reader sees it. A clutter entry never reads "not
 * picked" on its own, which says the agent skipped the right tool: it reads
 * "not needed here".
 */
export function flagText(kind: SignalKind, label: string): string {
  if (EXAMPLE_KIND_MEANING[kind].flagTone !== "clutter") return label;
  return label
    .replace(/\s*listed at (#\d+),?\s*not picked$/i, " at $1 · not needed here")
    .replace(/,?\s*not picked$/i, " · not needed here");
}

/**
 * Whether an example's sentence already names its tool, so a label above it
 * would only repeat it. A few kinds ("The agent searched but ran nothing.")
 * name no tool, and keep the label in a list that mixes tools.
 */
export function whyNamesSubject(why: string, subject: ExampleSubject): boolean {
  const lead = subject.names[0] || subject.ids[0] || "";
  return lead !== "" && why.includes(lead);
}
