import type { CraftKind } from "@/lib/views/fixes/crafter-types";

/**
 * The kinds of fix, in plain words, and how every engine's output maps onto
 * them: a drafted change of Tasks (`tool_craft_proposals`), a rewrite of
 * Quality's (`match_quality_proposals`), or an issue of Agent health that
 * names a concrete change (`trace_signals`). One kind per change a person
 * makes, whichever engine found it, so a reader filters by what to do and
 * never by who said it.
 *
 * The ids double as the `?kind=` value on Fixes. Pure, client-safe.
 */

export const FIX_KINDS = [
  "rewrite",
  "retire",
  "merge",
  "combine",
  "build",
  "skill",
  "fail-clearly",
  "schema",
  "fold",
  "parallel",
  "enrich",
  "preload",
  "split",
  "prerequisite",
  "tell-apart",
  "fewer-results",
] as const;

export type FixKind = (typeof FIX_KINDS)[number];

/** The kind as the table and the filter name it. */
export const FIX_KIND_LABELS: Record<FixKind, string> = {
  rewrite: "Rewrite a description",
  retire: "Retire a tool",
  merge: "Merge tools",
  combine: "Combine steps",
  build: "Build a tool",
  skill: "Add a skill",
  "fail-clearly": "Make a tool fail clearly",
  schema: "Tighten a schema",
  fold: "Fold a lookup in",
  parallel: "Run in parallel",
  enrich: "Return more in one call",
  preload: "Pre-load context",
  split: "Split a tool",
  prerequisite: "Run a prerequisite first",
  "tell-apart": "Tell two tools apart",
  "fewer-results": "Return fewer results",
};

export function isFixKind(value: unknown): value is FixKind {
  return typeof value === "string" && (FIX_KINDS as readonly string[]).includes(value);
}

/** `?kind=` read strictly: one of the kinds, or nothing. */
export function parseFixKind(raw: string | readonly string[] | undefined | null): FixKind | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return isFixKind(value) ? value : null;
}

/** Each kind of drafted change as the fix it is. */
export const CRAFT_FIX_KIND: Record<CraftKind, FixKind> = {
  merge_tools: "merge",
  fold_prerequisite: "fold",
  rewrite_tool: "rewrite",
  deprecate_tool: "retire",
  compose_chain: "combine",
  parallel_pair: "parallel",
  tighten_schema: "schema",
  enrich_response: "enrich",
  preload_context: "preload",
  split_by_use: "split",
  fill_gap: "build",
  require_prerequisite: "prerequisite",
};

/* - An issue's own fix ------------------------------------------------------- */

/**
 * The fix an issue names by its route (`SignalFixRoute`). Routes that are
 * Ratel's own work (ranking a tool higher, grouping asks) or that only ask a
 * person to look (`show_turns`, `none`) are not fixes.
 */
const ROUTE_FIX: Readonly<Record<string, FixKind>> = {
  rewrite_description: "rewrite",
  retire_tool: "retire",
  workflow_skill: "skill",
  disambiguate_pair: "tell-apart",
  lower_top_k: "fewer-results",
};

/**
 * Kinds whose route undersells the change their copy names, or that are
 * never a fix whatever their route says. `null` is a deliberate "not a fix".
 */
const KIND_FIX: Readonly<Record<string, FixKind | null>> = {
  identical_retry: "fail-clearly",
  unknown_tool: "build",
  workflow_fixed_chain: "combine",
  // Investigations, not changes: "look at these turns", "look for a missing tool".
  abandoned_search: null,
  error_loop: null,
  repeat_invoke: null,
  latency_outlier: null,
  wait_heavy: null,
  long_turn: null,
  blocked_action: null,
  token_heavy: null,
  system_turn_failing: null,
  agent_failing: null,
  workflow_failing: null,
  workflow_slow: null,
  fragmented_intents: null,
  unstable_intent: null,
  buried_tool: null,
};

/** Kinds this build knows; anything else is read from its route, then its fix sentence. */
const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "first_try_miss",
  "buried_tool",
  "magnet",
  "dead_tool",
  "sequence_chain",
  "sibling_confusion",
  "error_loop",
  "no_follow_through",
  "abandoned_search",
  "padding_share",
  "latency_outlier",
  "unstable_intent",
  "repeat_invoke",
  "fragmented_intents",
  "cooccurring_intents",
  "tool_switch",
  "empty_result",
  "unknown_tool",
  "unused_tool",
  "long_turn",
  "blocked_action",
  "identical_retry",
  "wait_heavy",
  "token_heavy",
  "system_turn_failing",
  "agent_failing",
  "workflow_failing",
  "workflow_slow",
  "workflow_fixed_chain",
]);

/** For a kind this build has no row for: the change its own fix sentence leads with. */
const FIX_SENTENCE: readonly (readonly [RegExp, FixKind])[] = [
  [/^make \S+ (fail|errors?|return)\b/i, "fail-clearly"],
  [/^make \S+'s errors\b/i, "fail-clearly"],
  [/^(rewrite|narrow|sharpen) .*description/i, "rewrite"],
  [/^(add|draft|write) a skill\b/i, "skill"],
  [/^(build|add) a tool\b/i, "build"],
  [/^retire\b/i, "retire"],
  [/^merge\b/i, "merge"],
  [/^combine\b/i, "combine"],
];

/** Whether this build has a row for the issue kind (else its fix is read from its route or sentence). */
export function knownIssueKind(kind: string): boolean {
  return KNOWN_KINDS.has(kind) || kind in KIND_FIX;
}

/** The fix a route names, or null for routes that are not a change a person makes. */
export function routeFixKind(route: string | null | undefined): FixKind | null {
  return route && route in ROUTE_FIX ? ROUTE_FIX[route]! : null;
}

export interface IssueFixInput {
  kind: string;
  /** The route the detector stored (`metrics.route`), or null. */
  route: string | null;
  /** The catalog entries the issue names. */
  toolIds: readonly string[];
  /** The issue's "What to do" sentence, for kinds this build does not know. */
  fix: string;
}

/**
 * The fix an issue names on its own, or null when it names none a person
 * can make. A rewrite needs a tool to rewrite; returning fewer results is a
 * project setting and needs none.
 */
export function issueFixKind(issue: IssueFixInput): FixKind | null {
  let kind: FixKind | null;
  if (issue.kind in KIND_FIX) kind = KIND_FIX[issue.kind] ?? null;
  else if (issue.route && issue.route in ROUTE_FIX) kind = ROUTE_FIX[issue.route]!;
  else if (KNOWN_KINDS.has(issue.kind)) kind = null;
  else kind = FIX_SENTENCE.find(([pattern]) => pattern.test(issue.fix.trim()))?.[1] ?? null;
  if (kind === null) return null;
  if (kind === "fewer-results") return kind;
  // A change to a tool needs the tool; only a few kinds stand on a task or a topic alone.
  if (issue.toolIds.length === 0 && kind !== "skill" && kind !== "build" && kind !== "combine")
    return null;
  return kind;
}

/* - Which drafted fix resolves which issue ---------------------------------- */

/**
 * The issue kinds each kind of drafted fix resolves when they are about the
 * same thing (`resolvesIssue`). A rewrite resolves the retrieval issues of its
 * tool; a merge, fold, combine or enrich the chain of its pair; a schema or
 * prerequisite fix the failures of its tool; a retirement the "nobody uses
 * it" issue that names its tool.
 */
const RESOLVES: Readonly<Partial<Record<FixKind, ReadonlySet<string>>>> = {
  rewrite: new Set([
    "first_try_miss",
    "buried_tool",
    "magnet",
    "no_follow_through",
    "empty_result",
    "sibling_confusion",
    "tool_switch",
    "self_correcting",
  ]),
  retire: new Set(["dead_tool", "unused_tool"]),
  merge: new Set(["sequence_chain", "sibling_confusion", "workflow_fixed_chain"]),
  combine: new Set(["workflow_fixed_chain", "sequence_chain"]),
  fold: new Set(["sequence_chain"]),
  enrich: new Set(["sequence_chain"]),
  schema: new Set(["error_loop", "identical_retry", "self_correcting"]),
  prerequisite: new Set(["error_loop", "identical_retry", "sequence_chain"]),
};

/** Kinds where one side of a pair is enough: rewriting either tool can tell them apart. */
const EITHER_SIDE: ReadonlySet<FixKind> = new Set(["rewrite"]);

export interface ResolverInput {
  kind: FixKind;
  toolIds: readonly string[];
  taskIds: readonly string[];
}

export interface ResolvableIssue {
  kind: string;
  subjectKind: string;
  toolIds: readonly string[];
  taskId: string | null;
}

/** Whether a drafted fix resolves an issue: a kind it resolves, about the same tools or task. */
export function resolvesIssue(fix: ResolverInput, issue: ResolvableIssue): boolean {
  if (!RESOLVES[fix.kind]?.has(issue.kind)) return false;
  const tools = new Set(fix.toolIds);
  if (issue.taskId !== null && fix.taskIds.includes(issue.taskId)) return true;
  if (issue.toolIds.length === 0) return false;
  // "Tools nobody uses" names many; retiring any one of them is part of the fix.
  if (issue.subjectKind === "project") return issue.toolIds.some((id) => tools.has(id));
  if (issue.toolIds.length === 1 || EITHER_SIDE.has(fix.kind))
    return issue.toolIds.some((id) => tools.has(id));
  return issue.toolIds.every((id) => tools.has(id));
}
