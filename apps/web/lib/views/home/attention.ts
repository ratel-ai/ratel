import type { TaskColorSlot } from "@ratel/design-system/task-colors";
import type { ContextSource } from "@/lib/ingest/context";
import { fmtCount } from "@/lib/platform/format";
import {
  figureCaption,
  formatSharePercent,
  signalTitle,
} from "@/lib/readings/trace-signals/claims";
import type { SignalFixRoute, SignalKind, SignalSubject } from "@/lib/readings/trace-signals/view";
import type { Suggestion } from "@/lib/synthesis/dashboard";
import { productWords } from "@/lib/views/fixes/copy";
import type { TaskRef, UnansweredIntent } from "@/lib/views/home/glance";
import type { ContextSplit } from "@/lib/views/home/overview-model";

/**
 * "Needs attention" as plain data: one short list across the product, worst
 * first, each row a noun's mark, a few words, one number and where it leads
 * (DESIGN.md, The product's nouns). The sentences that explain a row live one
 * click away, on the page it opens. Pure.
 *
 * PRIVACY: intent and task names are text only; targets carry ids.
 */

export type AttentionTone = "danger" | "warning" | "info";

/** The tone in words, for screen readers: the colored mark alone carries no meaning. */
export const ATTENTION_TONE_LABEL: Record<AttentionTone, string> = {
  danger: "Urgent",
  warning: "Watch",
  info: "Note",
};

/** The noun a row is about, drawn as its mark: the product's nouns, plus runs and context. */
export type AttentionMark =
  | "run"
  | "issue"
  | "task"
  | "selfCorrection"
  | "intent"
  | "fix"
  | "context";

/** Where a row leads: another page, or a Panel on this one. */
export type AttentionTarget = { kind: "link"; href: string } | { kind: "peek"; peek: string };

/** What a row is about, drawn as pins next to its title. */
export type AttentionSubject =
  | { kind: "tools"; tools: readonly { name: string; skill: boolean }[]; more: number }
  | { kind: "task"; name: string; slot: TaskColorSlot | null }
  | { kind: "intent"; name: string };

export interface AttentionItem {
  key: string;
  tone: AttentionTone;
  mark: AttentionMark;
  /** A few words: "Failed runs", "Slow tool". */
  title: string;
  subject: AttentionSubject | null;
  /** The one number, and what it counts (said quietly next to it). */
  figure: { value: string; caption: string };
  target: AttentionTarget;
}

/** An Agent health issue, as much of it as a row needs. */
export interface AttentionIssue {
  id: string;
  kind: SignalKind;
  subject: Pick<SignalSubject, "kind" | "key" | "label" | "chips">;
  figure: { display: string; caption?: string };
  fixRoute: SignalFixRoute;
}

export interface AttentionInput {
  /** Failed runs in the window, and how many runs there were. */
  errors: { count: number; total: number; href: string };
  /** Agent health issues, worst first, already cut to the plan. */
  issues: readonly AttentionIssue[];
  /** Issues the plan hides. */
  lockedIssues: number;
  /** An issue's own place: its panel on Agent health. */
  issueHref: (issueId: string) => string;
  /** The fix that resolves an issue, when there is one. */
  fixHref?: (issueId: string) => string | null;
  healthHref: string | null;
  /** Tasks by id, for naming the task an issue is raised on. */
  tasks: Readonly<Record<string, TaskRef>>;
  /** Each task's own steps: a chain of two of them is the task, not an issue in it. */
  taskSteps: readonly (readonly string[])[];
  /** Intents most of whose asks went unanswered, most unanswered first. */
  unanswered: readonly UnansweredIntent[];
  /** Description updates ready to apply; null when Quality is off or not on the plan. */
  pendingRewrites: { count: number; href: string } | null;
  /** Context heuristics from the SDK's token split, and the split they read. */
  contextSuggestions: readonly Pick<Suggestion, "source" | "severity">[];
  contextSplit: ContextSplit | null;
  /** The Panel the context rows open. */
  contextPeek: string;
  limit?: number;
}

export interface Attention {
  items: AttentionItem[];
  /** Agent health issues past the cut, for a "N more in Agent health" link. */
  moreIssues: number;
}

/** Rows shown. */
export const ATTENTION_LIMIT = 5;
/** Below this many runs an error rate is noise, not news. */
const ERROR_MIN_RUNS = 20;
/** The failure share worth putting in front of anyone. */
const ERROR_RATE_FLOOR = 0.05;
/** Issues listed before every other kind of row has had its turn. */
const LEADING_ISSUES = 2;

/**
 * One short list across the product, worst first: failing runs, the worst
 * issues, an intent people get no answer for, description updates ready to
 * apply, context waste, then whatever room is left. Agent health leads but
 * never crowds out every other kind of row.
 */
export function buildAttention(input: AttentionInput): Attention {
  const limit = input.limit ?? ATTENTION_LIMIT;
  const errors = errorItem(input.errors);
  const groups = issueGroups(input.issues, input.taskSteps);
  const issueItems = groups.map((group) => issueItem(group, input));
  const intentItems = input.unanswered.map(unansweredItem);
  const rewriteItems =
    input.pendingRewrites && input.pendingRewrites.count > 0
      ? [rewriteItem(input.pendingRewrites)]
      : [];
  const contextItems = input.contextSuggestions.flatMap((suggestion) => {
    const item = contextItem(suggestion, input.contextSplit, input.contextPeek);
    return item ? [item] : [];
  });

  const ordered = [
    ...(errors ? [errors] : []),
    ...issueItems.slice(0, LEADING_ISSUES),
    ...intentItems.slice(0, 1),
    ...rewriteItems,
    ...contextItems.slice(0, 1),
    ...issueItems.slice(LEADING_ISSUES),
    ...intentItems.slice(1),
    ...contextItems.slice(1),
  ];
  const items = ordered.slice(0, limit);
  const shownIssues = items.filter((item) => item.key.startsWith(ISSUE_KEY)).length;
  const moreIssues = input.healthHref
    ? groups.length - shownIssues + Math.max(0, input.lockedIssues)
    : 0;
  return { items, moreIssues };
}

function errorItem({ count, total, href }: AttentionInput["errors"]): AttentionItem | null {
  if (total < ERROR_MIN_RUNS || count / total < ERROR_RATE_FLOOR) return null;
  return {
    key: "errors",
    tone: "danger",
    mark: "run",
    title: "Failed runs",
    subject: null,
    figure: {
      value: formatSharePercent(count / total),
      caption: `${fmtCount(count)} of ${fmtCount(total)}`,
    },
    target: { kind: "link", href },
  };
}

/* - Issues -------------------------------------------------------------------- */

const ISSUE_KEY = "issue:";

/** One kind of issue: its members, worst first. */
interface IssueGroup {
  kind: SignalKind;
  members: AttentionIssue[];
}

/**
 * Issues by kind, in the order of each kind's worst member. A chain the agent
 * already reaches directly ("nothing to change yet") is no issue, and a chain
 * of two of a task's own steps is that task, not an issue in it (as Tasks
 * reads them).
 */
export function issueGroups(
  issues: readonly AttentionIssue[],
  taskSteps: readonly (readonly string[])[],
): IssueGroup[] {
  const groups = new Map<SignalKind, IssueGroup>();
  for (const issue of issues) {
    if (issue.kind === "sequence_chain" && !chainToFix(issue, taskSteps)) continue;
    const group = groups.get(issue.kind) ?? { kind: issue.kind, members: [] };
    group.members.push(issue);
    groups.set(issue.kind, group);
  }
  return [...groups.values()];
}

function chainToFix(issue: AttentionIssue, taskSteps: readonly (readonly string[])[]): boolean {
  if (issue.fixRoute !== "workflow_skill") return false;
  const tools = issue.subject.chips.map((chip) => chip.id);
  return !taskSteps.some(
    (steps) => tools.length > 0 && tools.every((tool) => steps.includes(tool)),
  );
}

const TASK_KINDS: ReadonlySet<SignalKind> = new Set([
  "workflow_failing",
  "workflow_slow",
  "workflow_fixed_chain",
]);
const INTENT_KINDS: ReadonlySet<SignalKind> = new Set([
  "fragmented_intents",
  "cooccurring_intents",
  "unstable_intent",
]);

function markOf(kind: SignalKind): AttentionMark {
  if (kind === "self_correcting") return "selfCorrection";
  if (TASK_KINDS.has(kind)) return "task";
  if (INTENT_KINDS.has(kind)) return "intent";
  return "issue";
}

/** Pins a row shows: one tool, or the two of a pair or chain, before counting the rest. */
const ROW_TOOLS = 2;

type Chip = AttentionIssue["subject"]["chips"][number];
const toolOf = (chip: Chip) => ({ name: chip.label || chip.id, skill: chip.entryKind === "skill" });

/**
 * The pins a row names, on one line: the task an issue is raised on; else the
 * worst member's tool (its pair or chain, two tools at most), and the other
 * members counted.
 */
function subjectOf(group: IssueGroup, tasks: AttentionInput["tasks"]): AttentionSubject | null {
  const lead = group.members[0]!;
  if (lead.subject.kind === "workflow") {
    const task = tasks[lead.subject.key];
    const name = task?.name ?? lead.subject.label;
    return name ? { kind: "task", name, slot: task?.slot ?? null } : null;
  }
  const own = lead.subject.chips.filter((chip) => (chip.label || chip.id).length > 0);
  if (own.length === 0) return null;
  const tools = own.slice(0, ROW_TOOLS).map(toolOf);
  return { kind: "tools", tools, more: own.length - tools.length + group.members.length - 1 };
}

function issueItem(group: IssueGroup, input: AttentionInput): AttentionItem {
  const lead = group.members[0]!;
  return {
    key: `${ISSUE_KEY}${lead.id}`,
    tone: "warning",
    mark: markOf(group.kind),
    title: productWords(signalTitle(group.kind)),
    subject: subjectOf(group, input.tasks),
    figure: {
      value: lead.figure.display,
      caption: productWords(figureCaption(group.kind, lead.figure)),
    },
    target: { kind: "link", href: input.fixHref?.(lead.id) ?? input.issueHref(lead.id) },
  };
}

/* - Intents, fixes, context ---------------------------------------------------- */

function unansweredItem(intent: UnansweredIntent): AttentionItem {
  return {
    key: `intent:${intent.id}`,
    tone: "warning",
    mark: "intent",
    title: "Mostly unanswered",
    subject: { kind: "intent", name: intent.name },
    figure: { value: formatSharePercent(intent.answeredShare), caption: "answered" },
    target: { kind: "link", href: intent.href },
  };
}

function rewriteItem({ count, href }: { count: number; href: string }): AttentionItem {
  return {
    key: "rewrites",
    tone: "info",
    mark: "fix",
    title: count === 1 ? "Description update ready" : "Description updates ready",
    subject: null,
    figure: { value: fmtCount(count), caption: "to apply" },
    target: { kind: "link", href },
  };
}

/** Each context source's row: a few words, and the share it is about. */
const CONTEXT_ROWS: Partial<Record<ContextSource, { waste: string; share: string }>> = {
  tools: { waste: "Tools never called", share: "Tools fill the prompt" },
  history: { waste: "History re-read uncached", share: "History keeps growing" },
  skills: { waste: "Skills on every prompt", share: "Skills on every prompt" },
  memory: { waste: "Memory to review", share: "Memory to review" },
};

/**
 * A context suggestion as a row: its source in a few words and one share,
 * the measured waste when there is one ("62% of tools never called"), else
 * the source's share of the context. Null without a split to read it from.
 */
function contextItem(
  suggestion: Pick<Suggestion, "source" | "severity">,
  split: ContextSplit | null,
  peek: string,
): AttentionItem | null {
  const words = CONTEXT_ROWS[suggestion.source];
  const row = split?.rows.find((candidate) => candidate.source === suggestion.source);
  if (!words || !row) return null;
  const waste = row.waste;
  return {
    key: `context:${suggestion.source}`,
    tone: suggestion.severity === "high" ? "warning" : "info",
    mark: "context",
    title: waste ? words.waste : words.share,
    subject: null,
    figure: waste
      ? { value: formatSharePercent(waste.share), caption: `of ${row.label.toLowerCase()}` }
      : { value: formatSharePercent(row.share), caption: "of context" },
    target: { kind: "peek", peek },
  };
}
