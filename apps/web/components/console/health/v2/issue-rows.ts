import type { TaskColorSlot } from "@ratel/design-system/task-colors";
import { TOP_PROBLEMS } from "@/components/console/health/card-model";
import {
  groupAnchors,
  groupByKind,
  groupFigure,
  groupKey,
  groupTitle,
  groupTone,
  type ProblemGroup,
  primaryOf,
  rowTools,
  toolCount,
} from "@/components/console/health/problem-groups";
import type { SignalKind, SignalView } from "@/lib/readings/trace-signals/view";
import { productWords } from "@/lib/views/fixes/copy";
import { fixHref } from "@/lib/views/fixes/href";
import type { FixKind } from "@/lib/views/fixes/kinds";
import { findFix } from "@/lib/views/fixes/select";
import type { FixSource } from "@/lib/views/fixes/types";
import { descriptionFixHref, isDescriptionFix } from "@/lib/views/health/summary/fix-links";
import type { ChainFolding } from "@/lib/views/health/workflows-view";
import { taskHref } from "@/lib/views/tasks/paths";

/**
 * The Summary's issues, one unified list whatever found them, one row per
 * kind of issue, worst first: today's grouping and severity order
 * (`problem-groups.ts`), told in the product's nouns, each with the task it
 * is about, the one number that matters and the way forward: a description
 * update on Quality › Descriptions, any other fix on Fixes, else its turns.
 * Pure, so every row is testable without a page.
 */

/** Rows shown before "Show all". */
export const ISSUES_SHOWN = TOP_PROBLEMS;

/** How loud a row is: fix it now, watch it, or still too early to call. */
export type IssueTone = "fix_now" | "watch" | "early";

export const ISSUE_TONE_LABEL: Readonly<Record<IssueTone, string>> = {
  fix_now: "Fix now",
  watch: "Watch",
  early: "Too early",
};

/** A task as the rows name it: its color is the one it wears on every page. */
export interface TaskLookup {
  id: string;
  name: string;
  color: TaskColorSlot | null;
  /** Its steps (the tools it runs in order). */
  tools: readonly string[];
  runs: number;
}

/** A fix as the rows link to it. */
export interface FixLookup {
  id: string;
  aliases: string[];
  title: string;
  status: "open" | "applied";
  /** What it changes: a `rewrite` is a description update, made on Quality › Descriptions. */
  kind?: FixKind;
  /** Quality's rewrites (`rewrite`) open there in their own panel. */
  source?: FixSource;
  /** The catalog tools it changes. */
  toolIds?: readonly string[];
}

export interface IssueTools {
  /** The first members' tools, each member's in claim order: two single tools, or one pair or chain. */
  shown: readonly (readonly string[])[];
  /** Members not shown. */
  more: number;
  /** "18 tools", when a member names more than a row can show. */
  count: string | null;
}

const NO_TOOLS: IssueTools = { shown: [], more: 0, count: null };

/**
 * A row's tools as chips: two members when each is one tool, else the worst
 * member's tools (a pair, a chain); the rest counted. A member about more
 * tools than a row can name is counted instead ("18 tools").
 */
export function issueTools(group: ProblemGroup): IssueTools {
  const named = group.members
    .map((member) =>
      member.subject.chips.map((chip) => chip.label).filter((label) => label.length > 0),
    )
    .filter((names) => names.length > 0);
  if (named.length === 0) return NO_TOOLS;
  const counted = rowTools(group).count;
  if (counted) return { shown: [], more: 0, count: counted };
  const perRow = named.every((names) => names.length === 1) ? 2 : 1;
  const shown = named.slice(0, perRow);
  return { shown, more: named.length - shown.length, count: null };
}

export interface IssueTaskRef {
  id: string;
  name: string;
  color: TaskColorSlot | null;
  href: string;
}

export interface IssueFixLink {
  id: string;
  title: string;
  /** Quality › Descriptions for a description update, else the fix on Fixes. */
  href: string;
  applied: boolean;
  /** A description update ("Update description"), made on Quality › Descriptions. */
  description: boolean;
  /** The member issues it resolves. */
  issueIds: readonly string[];
}

/**
 * What the row's button does: update a description on Quality, open the fix
 * on Fixes, show the turns, or the detail when it has no turns.
 */
export type IssueAction =
  | { kind: "description"; href: string }
  | { kind: "fix"; href: string }
  | { kind: "turns" }
  | { kind: "details" };

export interface IssueRow {
  /** Stable per kind of issue (and per task for folded chains). */
  key: string;
  /** The panel's `?peek=` id: its worst member's. */
  peek: string;
  /** Worst first; the issues (`trace_signals.id`) the row stands for. */
  memberIds: readonly string[];
  /** `signal-<id>` per member, so links into the page land on the row. */
  anchors: readonly string[];
  kind: SignalKind;
  title: string;
  tone: IssueTone;
  /** The tools it names, member by member (a pair is two), how many members more, or a count when they are many. */
  tools: IssueTools;
  /** What it is about when that is no tool: "Whole project", "One repeated ask". */
  scope: string | null;
  task: IssueTaskRef | null;
  /** The one number that matters: the worst member's figure and what it counts. */
  figure: { display: string; caption: string };
  /** Each distinct fix of its members, worst member first. */
  fixes: readonly IssueFixLink[];
  action: IssueAction;
  /** Turns behind it, for "See turns". */
  turns: number;
  group: ProblemGroup;
}

export interface IssueRowsInput {
  projectId: string;
  /** Above their floor, already cut to the plan (and to what a gap leaves). */
  signals: readonly SignalView[];
  /** Seen but not yet sure; listed after the rest. */
  tooEarly: readonly SignalView[];
  folding?: ChainFolding;
  tasks: readonly TaskLookup[];
  /** Null when Fixes could not be read: no row then claims a fix. */
  fixes: readonly FixLookup[] | null;
}

export const ISSUE_PEEK_PREFIX = "issue:";

export function issuePeek(signalId: string): string {
  return `${ISSUE_PEEK_PREFIX}${signalId}`;
}

/** The issue a `?peek=` names, or null for another panel's. */
export function peekedIssue(peek: string | null): string | null {
  return peek?.startsWith(ISSUE_PEEK_PREFIX) ? peek.slice(ISSUE_PEEK_PREFIX.length) || null : null;
}

/** The row an issue id belongs to: any of its members. */
export function rowOfIssue(rows: readonly IssueRow[], signalId: string | null): IssueRow | null {
  if (!signalId) return null;
  return rows.find((row) => row.memberIds.includes(signalId)) ?? null;
}

const TONE: Readonly<Record<ReturnType<typeof groupTone>, IssueTone>> = {
  coral: "fix_now",
  amber: "watch",
  muted: "early",
};

/**
 * The task a row is about: the one its chains fold under, the one it is
 * raised on, else the busiest task whose steps include every tool its worst
 * member names.
 */
export function taskOfGroup(group: ProblemGroup, tasks: readonly TaskLookup[]): TaskLookup | null {
  const byId = (id: string) => tasks.find((task) => task.id === id) ?? null;
  if (group.workflow) return byId(group.workflow.id);
  const lead = primaryOf(group);
  if (lead.subject.kind === "workflow") return byId(lead.subject.key);
  const tools = lead.subject.chips.map((chip) => chip.id);
  if (tools.length === 0) return null;
  const running = tasks.filter((task) => tools.every((tool) => task.tools.includes(tool)));
  return [...running].sort((a, b) => b.runs - a.runs || (a.id < b.id ? -1 : 1))[0] ?? null;
}

/** The first catalog tool an issue names: the one a description update of its own is about. */
function firstTool(member: SignalView): string | null {
  return member.subject.chips.find((chip) => chip.entryKind === "tool")?.id ?? null;
}

function fixesOf(
  group: ProblemGroup,
  fixes: readonly FixLookup[] | null,
  projectId: string,
): IssueFixLink[] {
  if (!fixes) return [];
  const found = new Map<string, IssueFixLink & { issueIds: string[] }>();
  for (const member of group.members) {
    const fix = findFix(fixes, issuePeek(member.id));
    if (!fix) continue;
    const seen = found.get(fix.id);
    if (seen) {
      seen.issueIds.push(member.id);
      continue;
    }
    const description = isDescriptionFix(fix.kind)
      ? descriptionFixHref(projectId, fix, fixes, firstTool(member))
      : null;
    found.set(fix.id, {
      id: fix.id,
      title: fix.title,
      href: description ?? fixHref(projectId, { peek: fix.id }),
      applied: fix.status === "applied",
      description: description !== null,
      issueIds: [member.id],
    });
  }
  return [...found.values()];
}

function rowOf(group: ProblemGroup, input: IssueRowsInput, early: boolean): IssueRow {
  const lead = primaryOf(group);
  const task = taskOfGroup(group, input.tasks);
  const fixes = fixesOf(group, input.fixes, input.projectId);
  const turns = group.members.reduce((sum, member) => sum + member.evidence.totalTurns, 0);
  const open = fixes.find((fix) => !fix.applied) ?? fixes[0];
  const namesTools = group.members.some((member) => member.subject.chips.length > 0);
  return {
    key: `${early ? "early:" : ""}${groupKey(group)}`,
    peek: issuePeek(lead.id),
    memberIds: group.members.map((member) => member.id),
    anchors: groupAnchors(group),
    kind: group.kind,
    title: productWords(groupTitle(group)),
    tone: early ? "early" : TONE[groupTone(group)],
    tools: namesTools ? issueTools(group) : NO_TOOLS,
    scope: namesTools ? null : lead.subject.label || null,
    task: task
      ? {
          id: task.id,
          name: task.name,
          color: task.color,
          href: taskHref(input.projectId, task.id),
        }
      : null,
    figure: groupFigure(group),
    fixes,
    action: open
      ? { kind: open.description ? "description" : "fix", href: open.href }
      : turns > 0
        ? { kind: "turns" }
        : { kind: "details" },
    turns,
    group,
  };
}

/** What a row's members are: tools, or pairs of tools (chains, look-alikes). */
export function memberNoun(members: readonly Pick<SignalView, "subject">[], count: number): string {
  const pairs = members.length > 0 && members.every((member) => member.subject.chips.length === 2);
  return pairs ? (count === 1 ? "pair" : "pairs") : count === 1 ? "tool" : "tools";
}

/**
 * Issues without their example turns: the rows go to the browser, and a
 * turn's story can hold what a user typed, so examples are only ever read
 * when an issue is opened (`/api/projects/:id/health/examples`).
 */
export function withoutExampleTurns(signals: readonly SignalView[]): SignalView[] {
  return signals.map((signal) =>
    signal.evidence.turns.length === 0
      ? signal
      : { ...signal, evidence: { ...signal.evidence, turns: [] } },
  );
}

/** Every row: the issues worst first, then the ones too early to call. */
export function issueRows(input: IssueRowsInput): IssueRow[] {
  return [
    ...groupByKind(withoutExampleTurns(input.signals), input.folding).map((group) =>
      rowOf(group, input, false),
    ),
    ...groupByKind(withoutExampleTurns(input.tooEarly)).map((group) => rowOf(group, input, true)),
  ];
}

/** "9 issues across 17 tools, worst first." for the section's line, and how many more are too early to call. */
export function issuesLine(rows: readonly IssueRow[], signals: readonly SignalView[]): string {
  const counted = rows.filter((row) => row.tone !== "early").length;
  const early = rows.length - counted;
  const tools = toolCount(signals);
  const issues = `${counted.toLocaleString("en-US")} ${counted === 1 ? "issue" : "issues"}`;
  const across =
    tools > 0 ? ` across ${tools.toLocaleString("en-US")} ${tools === 1 ? "tool" : "tools"}` : "";
  const later =
    early > 0
      ? ` ${early.toLocaleString("en-US")} more ${early === 1 ? "is" : "are"} too early to call.`
      : "";
  return `${issues}${across}, worst first.${later}`;
}
