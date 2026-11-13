import { signalAnchorId } from "@/components/console/health/anchors";
import type { OpenSource } from "@/components/console/health/card-model";
import {
  countNoun,
  SIGNAL_GROUP_LABELS,
  SIGNAL_KIND_GROUP,
  type SignalGroupKey,
  type SignalTone,
  SUBJECT_NAME_LIMIT,
  signalTone,
  sortSignals,
  splitFix,
} from "@/components/console/health/card-model";
import { clampFigures, figureCaption, signalTitle } from "@/lib/readings/trace-signals/claims";
import type { EvidenceTurn, SignalKind, SignalView } from "@/lib/readings/trace-signals/view";
import type { ChainFolding } from "@/lib/views/health/workflows-view";

/**
 * The problem list shows one row per kind of problem, not one per signal:
 * "Wrong tool keeps showing up" once, with the tools it affects, instead of
 * once per tool. Pure: the rows, their figure, their "What to do" line and the
 * tool filter inside them are all decided here.
 */

/** One kind of problem and every signal of that kind, worst first. */
export interface ProblemGroup {
  kind: SignalKind;
  /** Worst first; never empty. */
  members: readonly SignalView[];
  /**
   * Set on chains folded under the workflow they lie inside ("3 chains
   * inside Close out a release"): every member is a `sequence_chain` whose
   * two tools are in that workflow's core.
   */
  workflow?: { id: string; name: string };
}

/** A stable key per row: its kind, or its kind and workflow for folded chains. */
export function groupKey(group: Pick<ProblemGroup, "kind" | "workflow">): string {
  return group.workflow ? `${group.kind}:${group.workflow.id}` : group.kind;
}

/** The row's title: the kind's, or "3 chains inside Close out a release". */
export function groupTitle(group: ProblemGroup): string {
  if (!group.workflow) return signalTitle(group.kind);
  return `${group.members.length} chains inside ${group.workflow.name}`;
}

/** The member the group leads with: its worst. */
export function primaryOf(group: ProblemGroup): SignalView {
  return group.members[0]!;
}

/** Every member's `#signal-<id>` anchor; the first is the row's own id. */
export function groupAnchors(group: ProblemGroup): readonly string[] {
  return group.members.map((member) => signalAnchorId(member.id));
}

/**
 * Signals merged by kind, each group worst first inside and the groups ordered
 * by their worst member, so the top of the list is still the most urgent.
 */
export function groupByKind(
  signals: readonly SignalView[],
  folding?: ChainFolding,
): readonly ProblemGroup[] {
  const sorted = sortSignals(signals);
  const kinds = [...new Set(sorted.map((signal) => signal.kind))];
  const groups = kinds.map((kind) => ({
    kind,
    members: sorted.filter((signal) => signal.kind === kind),
  }));
  return folding ? foldChains(groups, folding, sorted) : groups;
}

/** Fewest chains inside one workflow before they fold into a row of their own. */
export const FOLD_MIN_CHAINS = 2;

/**
 * Chains whose pair lies inside one workflow move to a row of their own per
 * workflow (when at least {@link FOLD_MIN_CHAINS} do), so a demo with a dozen
 * chains inside four workflows reads as four rows, not one long list of
 * pairs. Nothing is dropped: every signal is in exactly one row, and rows
 * stay ordered by their worst member.
 */
export function foldChains(
  groups: readonly ProblemGroup[],
  folding: ChainFolding,
  sorted: readonly SignalView[],
): readonly ProblemGroup[] {
  const out = groups.flatMap((group): ProblemGroup[] => {
    if (group.kind !== "sequence_chain") return [group];
    const byWorkflow = new Map<string, SignalView[]>();
    for (const member of group.members) {
      const owner = folding.owners[member.id];
      if (owner) byWorkflow.set(owner, [...(byWorkflow.get(owner) ?? []), member]);
    }
    const folded = [...byWorkflow].filter(([, members]) => members.length >= FOLD_MIN_CHAINS);
    const taken = new Set(folded.flatMap(([, members]) => members.map((member) => member.id)));
    const rest = group.members.filter((member) => !taken.has(member.id));
    return [
      ...(rest.length > 0 ? [{ kind: group.kind, members: rest }] : []),
      ...folded.map(([id, members]) => ({
        kind: group.kind,
        members,
        workflow: { id, name: folding.names[id] ?? id },
      })),
    ];
  });
  const rank = new Map(sorted.map((signal, index) => [signal.id, index]));
  return [...out].sort(
    (a, b) => (rank.get(primaryOf(a).id) ?? 0) - (rank.get(primaryOf(b).id) ?? 0),
  );
}

/** The groups under their plain area headings, areas ordered by their worst group. */
export function groupProblemsByArea(
  groups: readonly ProblemGroup[],
): readonly { key: SignalGroupKey; label: string; groups: readonly ProblemGroup[] }[] {
  const areas = [...new Set(groups.map((group) => SIGNAL_KIND_GROUP[group.kind]))];
  return areas.map((key) => ({
    key,
    label: SIGNAL_GROUP_LABELS[key],
    groups: groups.filter((group) => SIGNAL_KIND_GROUP[group.kind] === key),
  }));
}

/** The group's colour: its worst member's. */
export function groupTone(group: ProblemGroup, tooEarly = false): SignalTone {
  return signalTone(primaryOf(group).severity, tooEarly);
}

/**
 * A member's name on a chip: its tool, or its pair of tools, or the kind's own
 * label. A member about many tools names the first and counts the rest
 * ("search_tasks + 4 more"), so a chip, a tooltip or a list line stays short.
 */
export function memberLabel(signal: Pick<SignalView, "subject">): string {
  const names = signal.subject.chips.map((chip) => chip.label).filter((name) => name.length > 0);
  if (names.length === 0) return signal.subject.label;
  if (names.length > SUBJECT_NAME_LIMIT) return `${names[0]} + ${names.length - 1} more`;
  return names.join(" + ");
}

/** Whether any member is about more tools than a row can name. */
const hasWideMember = (group: ProblemGroup): boolean =>
  group.members.some(
    (member) =>
      member.subject.chips.filter((chip) => chip.label.length > 0).length > SUBJECT_NAME_LIMIT,
  );

/** Distinct tools named across signals, for "N problems across M tools". */
export function toolCount(signals: readonly Pick<SignalView, "subject">[]): number {
  return new Set(signals.flatMap((signal) => signal.subject.chips.map((chip) => chip.id))).size;
}

/** Tools the collapsed row names before it folds the rest into "+N more". */
export const ROW_TOOL_LIMIT = 3;

/** Once a row would fold, it names only this many, so "a, b and 22 more" stays on one line. */
export const ROW_FOLDED_LIMIT = 2;

/** A pair of tools is twice as long to read, so a row names one pair before folding. */
export const ROW_PAIR_LIMIT = 1;

const isPairGroup = (group: ProblemGroup): boolean =>
  group.members.every((member) => member.subject.chips.length === 2);

/**
 * The collapsed row's tool names. Three tools are named in full; more than
 * that names the two worst and counts the rest ("create_document,
 * search_tasks and 22 more"), one pair for pair kinds, so the line never
 * wraps however many tools share the problem.
 */
export function rowTools(
  group: ProblemGroup,
  limit = isPairGroup(group)
    ? ROW_PAIR_LIMIT
    : group.members.length <= ROW_TOOL_LIMIT
      ? ROW_TOOL_LIMIT
      : ROW_FOLDED_LIMIT,
): { names: readonly string[]; more: number; count: string | null } {
  // Members that are each about many tools would read "a + 4 more, b + 4
  // more and 3 more": the row says how many tools there are instead.
  if (hasWideMember(group)) {
    const chips = group.members.flatMap((member) => member.subject.chips);
    return { names: [], more: 0, count: countNoun(toolCount(group.members), chips) };
  }
  const labels = group.members.map(memberLabel);
  return { names: labels.slice(0, limit), more: Math.max(0, labels.length - limit), count: null };
}

/* - The tool filter ---------------------------------------------------------- */

/** Chips shown inline beside "All" before the rest move behind "+N more". */
export const FILTER_CHIP_LIMIT = 5;

/** Pairs are twice as wide, so fewer fit on the one line. */
export const FILTER_PAIR_CHIP_LIMIT = 3;

/** Above this many tools, the "+N more" list gets a filter box. */
export const FILTER_SEARCH_THRESHOLD = 12;

/**
 * How the tool filter lays out a group: the tools with the most impact as
 * chips on one line, the rest in a "+N more" list. A chosen tool that sits in
 * the list is shown as one more active chip, so the reader always sees what
 * the view is filtered to.
 */
export function filterLayout(
  group: ProblemGroup,
  selectedId: string | null,
  limit = isPairGroup(group) ? FILTER_PAIR_CHIP_LIMIT : FILTER_CHIP_LIMIT,
): { inline: readonly SignalView[]; activeExtra: SignalView | null; rest: readonly SignalView[] } {
  // Most impact first, the order the reader wants to pick from; ties keep the
  // group's own worst-first order.
  const byImpact = [...group.members].sort((a, b) => b.impact - a.impact);
  const inline = byImpact.slice(0, limit);
  const rest = byImpact.slice(limit);
  const activeExtra = selectedId ? (rest.find((member) => member.id === selectedId) ?? null) : null;
  return { inline, activeExtra, rest };
}

/**
 * Whether chips should carry their figures. When most tools share the same
 * figure (a wall of "100%"), the numbers are noise on the chips and live in
 * the "+N more" list, the Numbers tab and each chip's tooltip instead.
 */
export function chipFiguresUseful(group: ProblemGroup): boolean {
  const counts = new Map<string, number>();
  for (const member of group.members) {
    const display = clampFigures(member.figure.display);
    counts.set(display, (counts.get(display) ?? 0) + 1);
  }
  const mostShared = Math.max(0, ...counts.values());
  return mostShared * 2 <= group.members.length;
}

/** Kinds whose figure is better when higher (the share of turns that went to the same tool). */
const HIGHER_IS_BETTER: ReadonlySet<SignalKind> = new Set<SignalKind>(["unstable_intent"]);

/**
 * The member whose figure is worst: the biggest share, time, count or rank
 * (the smallest for a kind where higher is better). This can differ from the
 * row's lead, which is ordered by severity, a confidence bound: a tool with
 * a bigger figure on fewer turns can rank below one with a smaller figure on
 * many. The headline must never read "worst" next to a chip with a worse
 * number.
 */
export function worstFigureMember(group: ProblemGroup): SignalView {
  const inverse = HIGHER_IS_BETTER.has(group.kind);
  return group.members.reduce((worst, member) =>
    inverse
      ? member.figure.value < worst.figure.value
        ? member
        : worst
      : member.figure.value > worst.figure.value
        ? member
        : worst,
  );
}

/**
 * The row's big figure. A group shows its worst member's figure, in the same
 * unit every other row uses, so the figure column still reads "how bad" down
 * the list; the caption says it is the worst of several. The tool names next
 * to the title already say how many tools are affected.
 */
export function groupFigure(group: ProblemGroup): { display: string; caption: string } {
  const worst = worstFigureMember(group);
  const caption = figureCaption(group.kind, worst.figure);
  const count = group.members.length;
  return {
    display: clampFigures(worst.figure.display),
    caption: count > 1 ? `${caption} · worst of ${count}` : caption,
  };
}

/** "A and B", or "these 3 tools" (pairs: "these 3 pairs") once a list would be long. */
function namesPhrase(group: ProblemGroup): string {
  const labels = group.members.map(memberLabel);
  const pairs = group.members.every((member) => member.subject.chips.length === 2);
  if (labels.length === 2 && !pairs) return `${labels[0]} and ${labels[1]}`;
  return `these ${labels.length} ${pairs ? "pairs" : "tools"}`;
}

/**
 * The "What to do" line for several tools at once, per kind. A kind whose fix
 * does not depend on the tool keeps its first member's words.
 */
const GROUP_FIX: { readonly [K in SignalKind]?: (names: string, group: ProblemGroup) => string } = {
  magnet: (names) => `Narrow the descriptions of ${names} to what they really do.`,
  first_try_miss: (names) =>
    `Rewrite the descriptions of ${names} with the words people use when they need them.`,
  buried_tool: (names) => `Have Ratel rank ${names} higher for asks like these.`,
  sibling_confusion: (names) => `Rewrite the descriptions of ${names} to say when to use each one.`,
  error_loop: (names) => `Show these turns to whoever owns ${names}.`,
  no_follow_through: (names) =>
    `Rewrite the descriptions of ${names} to say exactly what they return.`,
  sequence_chain: (names) => `Write a skill that runs each of ${names} as one step.`,
  tool_switch: (names) => `Say in the descriptions of ${names} when to use the other tool instead.`,
  empty_result: (names) =>
    `Rewrite the descriptions of ${names} to say what input they need and when they find nothing.`,
  unknown_tool: (names) => `Add ${names}, or fix the prompt that makes the agent expect them.`,
  unused_tool: (names) => `Stop sending ${names} to the model, or retire them.`,
  blocked_action: (names) =>
    `Tell the agent what ${names} may do, or stop offering them where they will be refused.`,
  identical_retry: (names) =>
    `Make the errors of ${names} say what to change, so the agent fixes the call instead of repeating it.`,
  workflow_failing: () =>
    "Look at the failed runs of each task, starting with the step where most of them stop.",
  workflow_slow: () =>
    "Look at the slowest runs of each task, starting with the step that takes the most time.",
  workflow_fixed_chain: () =>
    "Turn each fixed sequence into one tool or a skill, so the agent does it in one step.",
  self_correcting: (names, group) => {
    const routes = new Set(group.members.map((member) => member.fixRoute));
    if (routes.size === 1 && routes.has("show_turns"))
      return `Make ${names} fail with a clear message, or retry inside them.`;
    if (routes.size === 1 && routes.has("rewrite_description"))
      return `Rewrite the searchable descriptions of ${names}.`;
    return "Open each one: its fix depends on what the agent corrected itself after.";
  },
};

/**
 * The row's "What to do" line: a chosen member's own first sentence, the
 * single member's when there is one, else the kind's line for several tools.
 */
export function groupFixLead(group: ProblemGroup, selectedId: string | null = null): string {
  const selected = selectedId
    ? group.members.find((member) => member.id === selectedId)
    : undefined;
  if (selected) return splitFix(clampFigures(selected.fix)).lead;
  if (group.workflow) {
    return `These steps already run together in ${group.workflow.name}. Build that as one tool or one skill for the task instead of a skill per pair.`;
  }
  if (group.members.length === 1) return splitFix(clampFigures(primaryOf(group).fix)).lead;
  const many = GROUP_FIX[group.kind];
  return many ? many(namesPhrase(group), group) : splitFix(clampFigures(primaryOf(group).fix)).lead;
}

/**
 * The tool chip a group opens on: the member the page was sent to (a
 * `#signal-<id>` hash or the flow map), or none ("All") when the reader
 * clicked the row, or the group has one member.
 */
export function preselectedMember(
  group: ProblemGroup,
  openAnchor: string | null,
  source: OpenSource,
): string | null {
  if (group.members.length < 2 || source === "click" || openAnchor === null) return null;
  return group.members.find((member) => signalAnchorId(member.id) === openAnchor)?.id ?? null;
}

/** One example turn and the signal it is evidence for. */
export interface GroupExample {
  signal: SignalView;
  turn: EvidenceTurn;
}

/**
 * The examples a group shows under a filter: one member's, or every member's
 * newest first, each still tied to its own signal so it can be labelled.
 */
export function groupExamples(
  group: ProblemGroup,
  selectedId: string | null,
  perSignal: number,
): readonly GroupExample[] {
  const members = selectedId
    ? group.members.filter((member) => member.id === selectedId)
    : group.members;
  const limit = Math.max(0, Math.floor(perSignal));
  const examples = members.flatMap((signal) =>
    signal.evidence.turns.slice(0, limit).map((turn) => ({ signal, turn })),
  );
  return selectedId
    ? examples
    : [...examples].sort((a, b) => b.turn.startedAt.localeCompare(a.turn.startedAt));
}
