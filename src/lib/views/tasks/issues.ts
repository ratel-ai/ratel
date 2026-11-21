import { figureCaption, signalTitle } from "@/lib/readings/trace-signals/claims";
import type { SignalKind } from "@/lib/readings/trace-signals/view";
import type { WorkflowLabels } from "@/lib/readings/trace-signals/workflows/name";
import { issueFixKind } from "@/lib/views/fixes/kinds";
import { findFix } from "@/lib/views/fixes/select";
import type { Fix } from "@/lib/views/fixes/types";
import { claimModel, type SignalRecord } from "@/lib/views/health/signals/claims-model";
import { descriptionsHref, fixesHref } from "@/lib/views/tasks/paths";

/**
 * A task's issues as its page lists them: a kind mark, the title, the one
 * number that matters and what to do about it. A description fix says so and
 * goes to Quality › Descriptions; any other fix opens on Fixes; an issue with
 * no change to make has no button, its sentences wait in its panel. Names and
 * numbers only: no request text. Pure.
 */

/** The marks issues wear, one per family of kinds, so a reader learns a handful, not thirty. */
export const ISSUE_FAMILIES = [
  "failing",
  "slow",
  "retry",
  "correcting",
  "search",
  "chain",
  "confusion",
  "unused",
  "empty",
  "other",
] as const;
export type IssueFamily = (typeof ISSUE_FAMILIES)[number];

const FAMILY: Readonly<Record<SignalKind, IssueFamily>> = {
  first_try_miss: "search",
  buried_tool: "search",
  magnet: "search",
  no_follow_through: "search",
  abandoned_search: "search",
  padding_share: "search",
  unstable_intent: "confusion",
  sibling_confusion: "confusion",
  tool_switch: "confusion",
  sequence_chain: "chain",
  cooccurring_intents: "chain",
  workflow_fixed_chain: "chain",
  dead_tool: "unused",
  unused_tool: "unused",
  empty_result: "empty",
  error_loop: "retry",
  repeat_invoke: "retry",
  identical_retry: "retry",
  unknown_tool: "failing",
  blocked_action: "failing",
  system_turn_failing: "failing",
  agent_failing: "failing",
  workflow_failing: "failing",
  latency_outlier: "slow",
  long_turn: "slow",
  wait_heavy: "slow",
  token_heavy: "slow",
  workflow_slow: "slow",
  self_correcting: "correcting",
  fragmented_intents: "other",
};

export function issueFamily(kind: string): IssueFamily {
  return (FAMILY as Readonly<Record<string, IssueFamily>>)[kind] ?? "other";
}

/** The parts of a Fix (Fixes' one model) a task's page reads. */
export type TaskFixLike = Pick<
  Fix,
  "id" | "aliases" | "kind" | "kindLabel" | "title" | "source" | "subject" | "issues"
>;

export interface IssueAction {
  /** `description` goes to Quality › Descriptions; `fix` opens the fix on Fixes. */
  kind: "description" | "fix";
  label: string;
  href: string;
}

export interface IssueView {
  id: string;
  kind: string;
  family: IssueFamily;
  title: string;
  /** The one number that matters and what it counts: "28%", "retried as is". */
  figure: { display: string; caption: string };
  /** The sentence with its numbers, for the panel. */
  claim: string;
  /** What to do, for the panel. */
  fix: string;
  /** The tools it names, in claim order; none when it is about the task itself. */
  tools: { id: string; label: string }[];
  /** True when the issue is on the task itself rather than one of its tools. */
  onTask: boolean;
  action: IssueAction | null;
  /** The ids of the same kind's issues folded into this row (`foldIssues`), so a link to one still opens it. */
  aliases: string[];
}

export interface IssueContext {
  projectId: string;
  taskId: string;
  names: ReadonlyMap<string, string>;
  labels: WorkflowLabels;
  windowDays: number;
  /** Fixes' open fixes; null when Fixes could not be read (then the issue's own link to a drafted fix is used). */
  fixes: readonly TaskFixLike[] | null;
}

export const UPDATE_DESCRIPTION = "Update description";
export const OPEN_FIX = "Fix";

/**
 * What the row's button does. The fix that resolves the issue on Fixes
 * decides (`issue:<id>` is one of its aliases); without Fixes, the issue's
 * own kind of fix and its linked draft. A rewrite is a description update:
 * straight to Quality › Descriptions, on the drafted rewrite when Quality
 * wrote one, else on the tool.
 */
export function issueAction(
  source: { record: SignalRecord; proposalId: string | null },
  fixSentence: string,
  ctx: Pick<IssueContext, "projectId" | "taskId" | "fixes">,
): IssueAction | null {
  const { record } = source;
  const route = typeof record.metrics.route === "string" ? record.metrics.route : null;
  const kind = issueFixKind({
    kind: record.kind,
    route,
    toolIds: record.subjectIds,
    fix: fixSentence,
  });
  const resolving = ctx.fixes ? findFix(ctx.fixes, `issue:${record.id}`) : null;
  if ((resolving?.kind ?? kind) === "rewrite") {
    if (resolving?.source === "rewrite")
      return {
        kind: "description",
        label: UPDATE_DESCRIPTION,
        href: descriptionsHref(ctx.projectId, { peek: resolving.id }),
      };
    const tool = resolving?.subject.tools[0]?.id ?? record.subjectIds[0] ?? null;
    if (tool)
      return {
        kind: "description",
        label: UPDATE_DESCRIPTION,
        href: descriptionsHref(ctx.projectId, { tool }),
      };
  }
  if (resolving)
    return { kind: "fix", label: OPEN_FIX, href: fixesHref(ctx.projectId, { peek: resolving.id }) };
  // Fixes was read and nothing on it resolves this issue: no change to make yet.
  if (ctx.fixes) return null;
  if (source.proposalId)
    return {
      kind: "fix",
      label: OPEN_FIX,
      href: fixesHref(ctx.projectId, { peek: source.proposalId }),
    };
  return kind
    ? { kind: "fix", label: OPEN_FIX, href: fixesHref(ctx.projectId, { task: ctx.taskId }) }
    : null;
}

export function issueView(
  source: { record: SignalRecord; proposalId: string | null },
  ctx: IssueContext,
): IssueView {
  const { record } = source;
  const claim = claimModel(record, ctx.names, ctx.windowDays, ctx.labels);
  const onTask = record.subjectKind === "workflow";
  return {
    id: record.id,
    kind: record.kind,
    family: issueFamily(record.kind),
    title: signalTitle(record.kind),
    figure: { display: claim.figure.display, caption: figureCaption(record.kind, claim.figure) },
    claim: claim.claim,
    fix: claim.fix,
    tools: onTask ? [] : record.subjectIds.map((id) => ({ id, label: ctx.names.get(id) ?? id })),
    onTask,
    action: issueAction(source, claim.fix, ctx),
    aliases: [],
  };
}

/**
 * One row per kind of issue. When the task and some of its tools raise the
 * same kind (the agent corrects itself on the task and on two of its tools),
 * the first in order keeps the row, and the rest fold into it: their tools
 * are named on it, their ids kept so a link to one still opens it, and their
 * action used when the kept row has none. Pure; the order is kept.
 */
export function foldIssues(issues: readonly IssueView[]): IssueView[] {
  const byKind = new Map<string, IssueView>();
  for (const issue of issues) {
    const kept = byKind.get(issue.kind);
    if (!kept) {
      byKind.set(issue.kind, issue);
      continue;
    }
    const named = new Set(kept.tools.map((tool) => tool.id));
    byKind.set(issue.kind, {
      ...kept,
      tools: [...kept.tools, ...issue.tools.filter((tool) => !named.has(tool.id))],
      aliases: [...kept.aliases, issue.id, ...issue.aliases],
      action: kept.action ?? issue.action,
    });
  }
  return [...byKind.values()];
}
