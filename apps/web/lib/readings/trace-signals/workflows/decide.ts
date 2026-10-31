import { createHash } from "node:crypto";
import type {
  CorpusEntry,
  JudgeCase,
  JudgeFraming,
  JudgeVerdict,
} from "@/lib/readings/decisions/judge";
import { clusterQueries } from "@/lib/readings/text/cluster";
import {
  type WorkflowLabels,
  workflowDescription,
  workflowDisplayName,
} from "@/lib/readings/trace-signals/workflows/name";

/**
 * Decisions a function cannot make: which workflow a captured user
 * ask was for. Tool sets place most runs, but a run that failed at step one
 * has no tool set to place, and an ask no workflow serves has none at all. The
 * choice model reads the ask and picks a workflow, or "none of these".
 *
 * Pure: options, cases and the aggregate. The job does the I/O and the calls.
 */

export const NONE_OPTION_ID = "none";

/**
 * The second question, for asks no workflow fits: does any tool in the
 * catalog do what the user asked? Asked with the judge's tuned tool framing (the
 * benchmarked one) over the catalog plus a "none" option. "Read the pricing
 * FAQ" finds read_document; "export the board as PDF" finds nothing, even
 * though the agent ran get_board_summary without an error.
 */
export const NO_TOOL_OPTION: CorpusEntry = {
  entryId: NONE_OPTION_ID,
  name: "No tool does this",
  description: "None of the other tools does what the request asks.",
  searchable: "no tool does this",
  source: "description",
  matchesAgentDescription: false,
  tags: [],
};

export const WORKFLOW_FRAMING: JudgeFraming = {
  about:
    "A request an AI agent received, or a search it made for a tool. Requests are served by running one of the workflows below, each a group of tools called together.",
  question: "Which workflow serves this request? Pick none if no workflow does what it asks.",
};

/** Bump with the framing, so cached verdicts are asked again under the new wording. */
const FRAMING_VERSION = 2;

export interface DecisionWorkflow {
  id: string;
  typicalOrder: readonly string[];
  /** Tools every run of it calls; a run without all of them stopped before it formed. */
  coreTools: readonly string[];
}

/** One run an ask came from: did it call tools, which, and did any fail. */
export interface AskTurn {
  id: string;
  errors: number;
  invokes: number;
  tools: readonly string[];
}

/** One captured ask and the runs it came from. */
export interface AskGroup {
  ask: string;
  turns: readonly AskTurn[];
  /** Whether the ask is what the user said, or the agent's search standing in for it. Absent reads as a user's ask. */
  source?: "user" | "search";
}

/**
 * Real asks a project needs before the search stand-ins are dropped. Below it,
 * the agent's first search query stands in for what the user asked; at or
 * above it, only runs that carried the user's message are judged, so a project
 * that turns message capture on is read from the fixed runs alone.
 */
export const MIN_USER_ASKS = 30;

/** The asks to judge: the users' own once there are enough of them, else everything captured. */
export function preferUserAsks<T extends { source: "user" | "search" }>(
  asks: readonly T[],
  min: number = MIN_USER_ASKS,
): T[] {
  const users = asks.filter((ask) => ask.source === "user");
  return users.length >= min ? users : [...asks];
}

/** Asks placed in a workflow: all of them, and the runs that failed before it formed. */
export interface PlacedAsks {
  turns: number;
  /**
   * Runs asking for this workflow that never ran all its core tools AND were
   * not resolved (a call failed, or no tool was called). A run that served the
   * ask with fewer tools did not fail, so it is not counted.
   */
  outside: number;
  /** Of those, runs where a call failed (the rest called no tool). */
  outsideWithErrors: number;
}

export interface WorkflowInsights {
  version: 3;
  asksSeen: number;
  judged: number;
  unclear: number;
  placed: Record<string, PlacedAsks>;
  /** Asks no workflow serves that no tool does either, or whose runs failed or called no tool: likely a missing tool. */
  unserved: {
    label: string;
    turns: number;
    samples: string[];
    turnIds: string[];
    /** no_tool: no tool in the catalog does it; unresolved: its runs failed or called no tool. */
    reason?: "no_tool" | "unresolved";
  }[];
  /** How many asks were the users' own and how many were search stand-ins. Absent on insights stored before it. */
  sources?: { user: number; search: number };
}

const MAX_UNSERVED_GROUPS = 8;
const MAX_SAMPLES = 3;
const MAX_SAMPLE_CHARS = 160;
const MAX_TURN_IDS = 5;

export function normalizeAsk(ask: string): string {
  return ask.replace(/\s+/g, " ").trim().toLowerCase();
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** The options the judge chooses between: each workflow by name and steps, and "none". */
export function decisionOptions(
  workflows: readonly DecisionWorkflow[],
  labels?: WorkflowLabels,
): CorpusEntry[] {
  const entries = workflows.map((w) => {
    const steps = `Runs ${w.typicalOrder.join(", then ")}.`;
    const description = workflowDescription(w, labels);
    return {
      entryId: w.id,
      name: workflowDisplayName(w, undefined, labels),
      description: description ? `${description} ${steps}` : steps,
      searchable: steps,
      source: "description",
      matchesAgentDescription: false,
      tags: [],
    };
  });
  return [
    ...entries,
    {
      entryId: NONE_OPTION_ID,
      name: "None of these",
      description:
        "None of the workflows above: the request asks for something the agent has no workflow for.",
      searchable: "none of the workflows",
      source: "description",
      matchesAgentDescription: false,
      tags: [],
    },
  ];
}

/** Changes whenever the option set does, so cached verdicts never outlive it. */
export function optionsHash(options: readonly CorpusEntry[]): string {
  return hashText(
    JSON.stringify([FRAMING_VERSION, options.map((o) => [o.entryId, o.name, o.description])]),
  );
}

export function decisionCases(
  groups: readonly AskGroup[],
  shortlist: readonly string[] = [],
): JudgeCase[] {
  return groups.map((g) => ({
    id: hashText(normalizeAsk(g.ask)),
    query: g.ask,
    shortlist: [...shortlist],
    assumed: "",
    stratum: "control",
  }));
}

export const askHash = (group: Pick<AskGroup, "ask">): string => hashText(normalizeAsk(group.ask));

const clip = (text: string) =>
  text.length > MAX_SAMPLE_CHARS ? `${text.slice(0, MAX_SAMPLE_CHARS - 1)}…` : text;

/**
 * The runs of an ask no workflow fits that count as unserved: all of them when
 * no tool in the catalog does it; none when a tool does (the agent could have
 * served it); otherwise only the runs the agent did not resolve.
 */
function unservedTurns(group: AskGroup, toolVerdict: string | undefined): readonly AskTurn[] {
  if (toolVerdict === NONE_OPTION_ID) return group.turns;
  if (toolVerdict) return [];
  return group.turns.filter(isUnresolved);
}

type UnservedGroup = AskGroup & { reason: "no_tool" | "unresolved" };

/** A run the agent did not resolve: it never called a tool, or a call failed. */
export function isUnresolved(turn: AskTurn): boolean {
  return turn.invokes === 0 || turn.errors > 0;
}

function unservedGroups(groups: readonly UnservedGroup[]): WorkflowInsights["unserved"] {
  const assignments = clusterQueries(
    groups.map((g, i) => ({ key: String(i), query: g.ask })),
    [],
  );
  const clusters = new Map<string, { label: string; members: UnservedGroup[] }>();
  assignments.forEach((a, i) => {
    if (a.kind !== "new") return;
    const cluster = clusters.get(a.clusterKey) ?? { label: a.label, members: [] };
    clusters.set(a.clusterKey, { label: a.label, members: [...cluster.members, groups[i]] });
  });
  return [...clusters.values()]
    .map((c) => ({
      label: c.label,
      turns: c.members.reduce((sum, m) => sum + m.turns.length, 0),
      samples: c.members.slice(0, MAX_SAMPLES).map((m) => clip(m.ask)),
      turnIds: c.members.flatMap((m) => m.turns.map((t) => t.id)).slice(0, MAX_TURN_IDS),
      reason: c.members.some((m) => m.reason === "no_tool")
        ? ("no_tool" as const)
        : ("unresolved" as const),
    }))
    .sort((a, b) => b.turns - a.turns || a.label.localeCompare(b.label))
    .slice(0, MAX_UNSERVED_GROUPS);
}

function placedFor(
  prior: PlacedAsks | undefined,
  group: AskGroup,
  core: readonly string[],
): PlacedAsks {
  const outside = group.turns.filter(
    (t) => isUnresolved(t) && !core.every((tool) => t.tools.includes(tool)),
  );
  return {
    turns: (prior?.turns ?? 0) + group.turns.length,
    outside: (prior?.outside ?? 0) + outside.length,
    outsideWithErrors: (prior?.outsideWithErrors ?? 0) + outside.filter((t) => t.errors > 0).length,
  };
}

/** Verdicts by ask hash, folded into what the page shows. Asks no workflow
 * serves count only for runs the agent did not resolve; a request one tool
 * answered fine is not a missing workflow. */
export function aggregateDecisions(
  groups: readonly AskGroup[],
  verdicts: ReadonlyMap<string, Pick<JudgeVerdict, "entryId">>,
  workflows: readonly DecisionWorkflow[],
  /** The tool check for asks no workflow fits; absent, only unresolved runs count. */
  toolVerdicts: ReadonlyMap<string, Pick<JudgeVerdict, "entryId">> = new Map(),
): WorkflowInsights {
  const cores = new Map(workflows.map((w) => [w.id, w.coreTools]));
  const placed: WorkflowInsights["placed"] = {};
  const unserved: UnservedGroup[] = [];
  let judged = 0;
  let unclear = 0;
  for (const group of groups) {
    const verdict = verdicts.get(hashText(normalizeAsk(group.ask)));
    if (!verdict) continue;
    judged += 1;
    const core = cores.get(verdict.entryId);
    if (verdict.entryId === NONE_OPTION_ID) {
      const toolVerdict = toolVerdicts.get(askHash(group))?.entryId;
      const missing = unservedTurns(group, toolVerdict);
      const reason = toolVerdict === NONE_OPTION_ID ? "no_tool" : "unresolved";
      if (missing.length > 0) unserved.push({ ask: group.ask, turns: missing, reason });
    } else if (core) placed[verdict.entryId] = placedFor(placed[verdict.entryId], group, core);
    else unclear += 1;
  }
  const searches = groups.filter((g) => g.source === "search").length;
  return {
    version: 3,
    asksSeen: groups.length,
    judged,
    unclear,
    placed,
    unserved: unservedGroups(unserved),
    sources: { user: groups.length - searches, search: searches },
  };
}
