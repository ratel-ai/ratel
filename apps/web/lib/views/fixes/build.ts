import { type TaskColorSlot, taskColors } from "@ratel/design-system/task-colors";
import { TOPIC_WINDOW_DAYS } from "@/lib/readings/topics/types";
import {
  EVIDENCE_LABEL,
  fixShortTitle,
  fixTitle,
  issuePrompt,
  listOf,
  plural,
  productWords,
  skillGapPrompt,
  strengthOf,
  type TitleContext,
} from "./copy";
import type { EffectChip, SuggestionRow } from "./crafter-types";
import { effectLine } from "./effect";
import { fixGroup } from "./groups";
import { catalogToolHref, descriptionHref, issueHref, taskHref, topicHref } from "./href";
import {
  CRAFT_FIX_KIND,
  FIX_KIND_LABELS,
  FIX_KINDS,
  type FixKind,
  issueFixKind,
  knownIssueKind,
  resolvesIssue,
  routeFixKind,
} from "./kinds";
import type { DraftFixInput } from "./seams";
import { compareFixes, fixStats } from "./select";
import {
  type IntentGapInput,
  type PublishedSkill,
  pickSkillGaps,
  SKILL_GAPS_SHOWN,
  type SkillGap,
} from "./skill-gaps";
import type {
  Fix,
  FixActions,
  FixDetail,
  FixEffect,
  FixEvidence,
  FixesModel,
  FixGain,
  FixIssueRef,
  FixSource,
  FixStatus,
  FixTaskRef,
  FixTopicRef,
} from "./types";

/**
 * Every source of fixes made into one list (`FixesModel`), with issues and fixes linked at
 * read time by what they are about.
 *
 * 1. Drafted fixes: Quality's rewrites (pending and applied) and the changes the tool crafter
 *    drafted (pending), each already told as a fix (`DraftFixInput`). A drafted rewrite of a
 *    tool Quality already rewrites is the same change: it becomes an alias of Quality's, which
 *    can be applied. A rewrite dismissed in Quality also hides the rewrites of that tool raised
 *    before it was dismissed.
 * 2. Issues: each one attaches to the drafted fixes that resolve it (the engine's own link
 *    first, `trace_signals.proposal_kind/_id`, else by subject, `resolvesIssue`). One that none
 *    resolves and that names a concrete change becomes a fix of its own, grouped with the other
 *    issues asking for the same change of the same thing.
 * 3. Each fix gets its subject (tools, the tasks that run them, the topics those serve), its
 *    why (the worst issue it resolves, else the source's own evidence), its effect, evidence,
 *    actions and rank.
 *
 * Pure: the loader reads, this decides. Nothing here knows a database.
 *
 * Owned (ADR-0030): upstream builds a draft's seed from the tool crafter's card here; in this
 * edition the crafter's filler tells the draft as a `DraftFixInput` before it arrives, so this
 * module never imports the crafter.
 */

/** A task (Agent health's mined set of tools), as read from the latest reading. */
export interface TaskInput {
  id: string;
  label: string;
  /** False when the label is only its tools in order: a title then names the tools instead. */
  named?: boolean;
  runs: number;
  /** Its core tools. */
  tools: readonly string[];
}

/** A topic (Intents) with the share of its turns that ran each tool and each task. */
export interface TopicInput {
  id: string;
  label: string;
  turns: number;
  toolShares: Readonly<Record<string, number>>;
  taskShares: Readonly<Record<string, number>>;
}

/** One of Quality's rewrites, shaped as Quality shows it. */
export interface RewriteInput {
  row: SuggestionRow;
  /** How the right answer of its missed searches was known: the agent ran it, or a judge read the ask. */
  howWeKnow: "seen" | "judged" | null;
}

/** One open issue of Agent health, told in its own words. */
export interface IssueInput {
  id: string;
  kind: string;
  /** The route the detector stored, or null. */
  route: string | null;
  subjectKind: string;
  subjectKey: string;
  /** The catalog tools it names, in claim order. */
  toolIds: string[];
  /** The task it is about (`subject_kind = workflow`). */
  taskId: string | null;
  /** The topic it is about, for kinds read per topic. */
  topicId: string | null;
  title: string;
  claim: string;
  cost: string;
  /** The raw counts behind its figure: "509 lists · 3 picks". */
  figureRaw: string;
  /** Its headline figure as Agent health shows it ("41%", "of lists"); null when it has none. */
  figure?: { display: string; caption: string } | null;
  /** Its "What to do" sentence. */
  fix: string;
  caveat: string | null;
  severity: number;
  impact: number;
  n: number;
  totalTurns: number;
  metrics: Readonly<Record<string, unknown>>;
  /** The engine's own link to a drafted fix, when it wrote one. */
  proposal: { kind: string; id: string } | null;
  firstSeenAt: string;
}

export interface FixesInput {
  projectId: string;
  names: ReadonlyMap<string, string>;
  /** Null when rewrites are off for the project (quality not landed, or not in the limits). */
  rewrites: readonly RewriteInput[] | null;
  /** Tools whose rewrite was dismissed, and when. */
  dismissedRewrites?: readonly { toolId: string; at: string }[];
  /** Pending drafted changes, each already told as a fix. */
  drafts: readonly DraftFixInput[];
  /** Open issues, already cut to what the limits show. */
  issues: readonly IssueInput[];
  tasks: readonly TaskInput[];
  topics: readonly TopicInput[];
  /** Each live intent's stored tool pattern with its name, for skill gaps; absent or null reads none. */
  intents?: readonly IntentGapInput[] | null;
  /** The published skills, for what already covers an intent. */
  skills?: readonly PublishedSkill[];
  /** Days the intents' numbers cover, for the words of a skill gap. */
  intentWindowDays?: number;
  overridesAdopted: boolean | null;
  failed?: readonly FixSource[];
}

/**
 * The values `trace_signals.proposal_kind` carries when the engine links an issue to the fix it
 * drafted for it (`proposal_id` is that row's id).
 */
export const PROPOSAL_KIND_SOURCE: Readonly<Record<string, Exclude<FixSource, "issue">>> = {
  tool_craft: "craft",
  match_quality: "rewrite",
};

const MAX_TASKS = 3;
const MAX_TOPICS = 3;

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set([...a, ...b]).size === a.length;
/**
 * Fixes that make an intent's steps one thing to call (a skill, a merged or combined tool, a
 * lookup folded into the next call, a response that returns what the next call fetched), so a
 * skill for the same steps would say it twice.
 */
const SAME_STEPS_KINDS: ReadonlySet<FixKind> = new Set([
  "skill",
  "merge",
  "combine",
  "fold",
  "enrich",
]);
/** A topic is about a tool (or task) when at least this share of its turns ran it. */
export const TOPIC_SHARE = 0.5;

/** Shown beside Apply when nothing has fetched the overrides recently (Quality's caveat). */
const NOT_REACHING_RUNTIME =
  "Nothing has fetched this project's overrides recently, so an applied rewrite may not reach your agent yet.";

/** "Missed 12 searches", or the absence of any. */
function missedLabel(missed: number): string {
  return missed === 0 ? "No recorded miss" : `Missed ${plural(missed, "search", "searches")}`;
}

/** A fix before its issues, subject and rank are known. */
interface Seed {
  id: string;
  source: FixSource;
  sourceId: string;
  aliases: string[];
  kind: FixKind;
  status: FixStatus;
  toolIds: string[];
  taskIds: string[];
  topicIds: string[];
  /** The intent the fix was found in (`Fix.intent`), and its name when the source read it. */
  intentId: string | null;
  intentName: string | null;
  title: Omit<TitleContext, "tools" | "task" | "topic">;
  /** The source's own why, used when no issue is attached. */
  why: string;
  effect: FixEffect | null;
  gain: FixGain | null;
  evidence: FixEvidence | null;
  copy: { label: string; text: string } | null;
  apply: boolean;
  dismiss: boolean;
  revert: boolean;
  detail: FixDetail | null;
  /** A measured improvement: ranks first. */
  measured: boolean;
  /** How often it applies, for ranking measured fixes. */
  score: number;
  appliedAt: string | null;
  issues: IssueInput[];
}

export function buildFixes(raw: FixesInput): FixesModel {
  // The issues' sentences are Agent health's; Fixes says them in the product's nouns.
  const input: FixesInput = {
    ...raw,
    issues: raw.issues.map((issue) => ({
      ...issue,
      title: productWords(issue.title),
      claim: productWords(issue.claim),
      cost: productWords(issue.cost),
      fix: productWords(issue.fix),
      caveat: issue.caveat === null ? null : productWords(issue.caveat),
    })),
  };
  const name = (id: string) => input.names.get(id) ?? id;
  const dismissedAt = new Map<string, number>();
  for (const { toolId, at } of input.dismissedRewrites ?? []) {
    dismissedAt.set(toolId, Math.max(dismissedAt.get(toolId) ?? 0, Date.parse(at)));
  }
  /** A rewrite of `toolId` raised at `at` that a later dismissal hides. */
  const dismissedSince = (toolId: string, at: number) =>
    (dismissedAt.get(toolId) ?? -Infinity) >= at;

  // 1. Drafted fixes.
  const seeds: Seed[] = (input.rewrites ?? []).map((rewrite) =>
    rewriteSeed(rewrite, input.overridesAdopted),
  );
  const rewriteByTool = new Map(seeds.map((seed) => [seed.toolIds[0]!, seed]));
  // One drafted change per kind and tools, whichever rule drafted it: a second draft of the
  // same change (an intent's merge of a pair the project-wide merge names too) opens the first.
  const draftByKey = new Map<string, Seed>();
  for (const draft of input.drafts) {
    if (draft.kind === "rewrite_tool") {
      const toolId = draft.toolIds[0];
      const same = toolId ? rewriteByTool.get(toolId) : undefined;
      if (same) {
        same.aliases.push(`craft:${draft.id}`);
        continue;
      }
      if (toolId && dismissedSince(toolId, Date.parse(draft.createdAt))) continue;
    }
    const seed = draftSeed(draft);
    const same = draftByKey.get(draft.key);
    if (same) {
      same.aliases.push(seed.id);
      if (same.intentId === null && seed.intentId !== null) {
        same.intentId = seed.intentId;
        same.topicIds.unshift(seed.intentId);
      }
      continue;
    }
    draftByKey.set(draft.key, seed);
    seeds.push(seed);
  }

  // 2. Issues: attach to the fixes that resolve them, or raise their own.
  const own = new Map<string, Seed>();
  for (const issue of input.issues) {
    const linked = issue.proposal ? linkedSeed(seeds, issue.proposal) : null;
    const resolvers = linked
      ? [linked]
      : seeds.filter((seed) =>
          resolvesIssue(
            { kind: seed.kind, toolIds: seed.toolIds, taskIds: seed.taskIds },
            {
              kind: issue.kind,
              subjectKind: issue.subjectKind,
              toolIds: issue.toolIds,
              taskId: issue.taskId,
            },
          ),
        );
    for (const seed of resolvers) seed.issues.push(issue);
    let toolIds = issue.toolIds;
    if (resolvers.length > 0) {
      // "Tools nobody uses" names many; what no drafted fix covers is still to do.
      if (linked || issue.subjectKind !== "project" || issue.toolIds.length < 2) continue;
      const covered = new Set(resolvers.flatMap((seed) => seed.toolIds));
      toolIds = issue.toolIds.filter((id) => !covered.has(id));
      if (toolIds.length === 0) continue;
    }
    // An issue on a task whose fix names one of its tools asks a change of that tool.
    if (
      typeof issue.metrics.fixTool === "string" &&
      issue.toolIds.includes(issue.metrics.fixTool)
    ) {
      toolIds = [issue.metrics.fixTool];
    }
    const kind = issueFixKind({ kind: issue.kind, route: issue.route, toolIds, fix: issue.fix });
    if (kind === null) continue;
    if (
      kind === "rewrite" &&
      toolIds.some((id) => dismissedSince(id, Date.parse(issue.firstSeenAt)))
    )
      continue;
    // One change to the same tools is one fix, whichever tool or task raised it;
    // the tasks it helps are gathered on it.
    const key =
      toolIds.length > 0
        ? [kind, [...toolIds].sort().join("|"), issue.topicId ?? ""].join("~")
        : [kind, "", issue.taskId ?? "", issue.topicId ?? ""].join("~");
    const group = own.get(key);
    if (group) {
      group.issues.push(issue);
      if (issue.taskId && !group.taskIds.includes(issue.taskId)) group.taskIds.push(issue.taskId);
    } else own.set(key, issueSeed(issue, kind, toolIds, issue.toolIds.length - toolIds.length));
  }
  seeds.push(...own.values());

  // 2b. Intents no skill covers: a skill each, the busiest few. A fix already open that makes the
  // same steps one call (`SAME_STEPS_KINDS`) is the same change: it names the intent instead of a
  // second fix, and the skill comes back if that fix is dismissed.
  let gapsShown = 0;
  for (const gap of pickSkillGaps(input.intents ?? [], input.skills ?? [], {
    max: Number.POSITIVE_INFINITY,
  })) {
    const same = seeds.find(
      (seed) => SAME_STEPS_KINDS.has(seed.kind) && sameSet(seed.toolIds, gap.steps),
    );
    if (same) {
      if (same.intentId === null) {
        same.intentId = gap.topicId;
        same.intentName = gap.name;
        if (!same.topicIds.includes(gap.topicId)) same.topicIds.unshift(gap.topicId);
      }
      continue;
    }
    if (gapsShown >= SKILL_GAPS_SHOWN) continue;
    gapsShown += 1;
    seeds.push(skillGapSeed(gap, name, input.intentWindowDays ?? TOPIC_WINDOW_DAYS));
  }

  // 3. Finish every fix and order the lists.
  const colors = taskColors(input.tasks.map((task) => ({ id: task.id, runs: task.runs })));
  const fixes = seeds.map((seed) => finish(seed, input, name, colors));
  const open = fixes
    .filter((fix) => fix.status === "open")
    .sort((a, b) => compareFixes(a, b, FIX_KINDS));
  const applied = fixes
    .filter((fix) => fix.status === "applied")
    .sort(
      (a, b) =>
        (b.appliedAt ?? "").localeCompare(a.appliedAt ?? "") || a.title.localeCompare(b.title),
    );
  return {
    projectId: input.projectId,
    open,
    applied,
    stats: fixStats(open),
    failed: [...(input.failed ?? [])],
    rewritesOn: input.rewrites !== null,
    overridesAdopted: input.overridesAdopted,
  };
}

function linkedSeed(seeds: readonly Seed[], proposal: { kind: string; id: string }): Seed | null {
  const source = PROPOSAL_KIND_SOURCE[proposal.kind];
  if (!source) return null;
  return seeds.find((seed) => seed.source === source && seed.sourceId === proposal.id) ?? null;
}

/* - Sources ------------------------------------------------------------------ */

function rewriteSeed({ row, howWeKnow }: RewriteInput, overridesAdopted: boolean | null): Seed {
  const tone =
    row.effect?.direction === "up" ? "good" : row.effect?.direction === "down" ? "bad" : "neutral";
  const pending = row.status === "pending";
  return {
    id: `rewrite:${row.id}`,
    source: "rewrite",
    sourceId: row.id,
    aliases: [],
    kind: "rewrite",
    status: pending ? "open" : "applied",
    toolIds: [row.toolId],
    taskIds: [],
    topicIds: [],
    intentId: null,
    intentName: null,
    title: {},
    why: `${missedLabel(row.missed)}${row.missed > 0 ? " where it was the right tool" : ""}.`,
    effect: row.effect ? replayEffect(row.effect.delta, row.effect.detail, tone) : null,
    gain: null,
    evidence: {
      strength: strengthOf(row.missed),
      label: EVIDENCE_LABEL[strengthOf(row.missed)],
      detail: [
        missedLabel(row.missed),
        howWeKnow === "seen" ? "Seen it run" : howWeKnow === "judged" ? "Judged" : null,
      ]
        .filter(Boolean)
        .join(" · "),
    },
    copy: { label: "Copy the new description", text: row.proposed },
    apply: pending,
    dismiss: pending,
    revert: !pending,
    detail: {
      source: "rewrite",
      row,
      caveat: pending && overridesAdopted !== true ? NOT_REACHING_RUNTIME : null,
    },
    measured: tone === "good",
    score: row.missed,
    appliedAt: row.appliedAt,
    issues: [],
  };
}

/**
 * The drafts count model round trips; Fixes says "model calls", the word its numbers use
 * everywhere (one round trip is one call to the model). Used by the crafter's filler when it
 * tells a draft as a fix.
 */
export function plainChip(chip: EffectChip): EffectChip {
  const plain = (text: string) =>
    text
      .replace(/round-trips/g, "model calls")
      .replace(/round-trip/g, "model call")
      .replace(/entry in every tool list/g, "tool in every list");
  return { ...chip, text: plain(chip.text), ...(chip.title ? { title: plain(chip.title) } : {}) };
}

/** A replay of past searches: how much more often the right tool is found; a flat one is "No change". */
function replayEffect(figure: string, detail: string | null, tone: FixEffect["tone"]): FixEffect {
  const compact =
    tone === "neutral"
      ? { figure: "No change", unit: "" }
      : tone === "bad" && !/\d/.test(figure)
        ? { figure, unit: "in a replay" }
        : { figure, unit: "found" };
  return { value: effectLine(compact), ...compact, detail, tone, basis: "replay", also: [] };
}

/** A drafted change, as its filler told it: the seed carries what the filler measured. */
function draftSeed(draft: DraftFixInput): Seed {
  return {
    id: `craft:${draft.id}`,
    source: "craft",
    sourceId: draft.id,
    aliases: [],
    kind: CRAFT_FIX_KIND[draft.kind],
    status: "open",
    toolIds: [...draft.toolIds],
    taskIds: [...draft.taskIds],
    topicIds: draft.intentId ? [draft.intentId] : [],
    intentId: draft.intentId,
    intentName: null,
    title: { ask: draft.ask },
    why: draft.why,
    effect: draft.effect,
    gain: draft.gain,
    evidence: draft.evidence,
    copy: draft.copy,
    apply: false,
    // A person can say no; the next analysis then keeps it from coming back.
    dismiss: true,
    revert: false,
    detail: draft.detail,
    measured: draft.measured,
    score: draft.score,
    appliedAt: null,
    issues: [],
  };
}

function issueSeed(issue: IssueInput, kind: FixKind, toolIds: string[], covered: number): Seed {
  const listed =
    typeof issue.metrics.dead === "number"
      ? issue.metrics.dead
      : typeof issue.metrics.tools === "number"
        ? issue.metrics.tools
        : null;
  const count =
    listed !== null && listed > issue.toolIds.length ? listed - covered : toolIds.length;
  const topK =
    typeof issue.metrics.suggestedTopK === "number" && typeof issue.metrics.medianTopK === "number"
      ? { from: Math.round(issue.metrics.medianTopK), to: Math.round(issue.metrics.suggestedTopK) }
      : null;
  // A kind this build only knows by its sentence is titled by that sentence.
  const sentence =
    !knownIssueKind(issue.kind) && routeFixKind(issue.route) === null ? issue.fix : null;
  return {
    id: `issue:${issue.id}`,
    source: "issue",
    sourceId: issue.id,
    aliases: [],
    kind,
    status: "open",
    toolIds,
    taskIds: issue.taskId ? [issue.taskId] : [],
    topicIds: issue.topicId ? [issue.topicId] : [],
    intentId: null,
    intentName: null,
    title: { count, topK, sentence },
    why: issue.claim,
    effect: null,
    gain: null,
    evidence: null,
    copy: null,
    apply: false,
    dismiss: false,
    revert: false,
    detail: null,
    measured: false,
    score: 0,
    appliedAt: null,
    issues: [issue],
  };
}

/** An intent no skill covers, as a skill to add: Copy prompt is its one action, nothing is drafted or stored. */
function skillGapSeed(gap: SkillGap, name: (id: string) => string, windowDays: number): Seed {
  const steps = gap.steps.map(name);
  const title = fixTitle("skill", { tools: steps, intent: gap.name });
  const strength = strengthOf(gap.runs);
  return {
    id: `intent:${gap.topicId}`,
    source: "intent",
    sourceId: gap.topicId,
    aliases: [],
    kind: "skill",
    status: "open",
    toolIds: [...gap.steps],
    taskIds: [],
    topicIds: [gap.topicId],
    intentId: gap.topicId,
    intentName: gap.name,
    title: { intent: gap.name },
    why: `In ${gap.runs} of ${plural(gap.turns, "ask", "asks")} the agent ran ${listOf(steps)}, with no skill used or offered.`,
    effect: null,
    gain: null,
    evidence: {
      strength,
      label: EVIDENCE_LABEL[strength],
      detail: `Seen ${plural(gap.runs, "time", "times")} in this window · No skill used`,
    },
    copy: {
      label: "Copy prompt",
      text: skillGapPrompt({
        title,
        intent: gap.name,
        turns: gap.turns,
        steps,
        runs: gap.runs,
        inOrder: gap.inOrder,
        windowDays,
      }),
    },
    apply: false,
    dismiss: false,
    revert: false,
    detail: {
      source: "intent",
      changes: [
        `Write a skill for ${gap.name} that runs ${listOf(steps)} in their usual order.`,
        "Publish it in Catalog › Skills, and say in its description when to use it.",
      ],
      steps: [...gap.steps],
      caveat: null,
    },
    measured: false,
    score: gap.runs,
    appliedAt: null,
    issues: [],
  };
}

/* - Finishing ---------------------------------------------------------------- */

function finish(
  seed: Seed,
  input: FixesInput,
  name: (id: string) => string,
  colors: ReadonlyMap<string, TaskColorSlot>,
): Fix {
  const { projectId } = input;
  const issues = [...seed.issues].sort((a, b) => b.severity - a.severity);
  const lead = issues[0] ?? null;
  const tools = seed.toolIds.map((id) => ({
    id,
    label: name(id),
    href: catalogToolHref(projectId, name(id)),
  }));
  const tasks = subjectTasks(seed, input.tasks, colors, projectId);
  const topics = subjectTopics(seed, tasks, input.topics, projectId);
  const namedTask =
    seed.taskIds.length > 0
      ? input.tasks.find((task) => task.id === seed.taskIds[0] && task.named !== false)
      : undefined;
  const explicitTask = namedTask?.label ?? null;
  const explicitTopic =
    seed.topicIds.length > 0
      ? (topics.find((topic) => topic.id === seed.topicIds[0])?.label ?? null)
      : null;
  const intentLabel = seed.intentId
    ? (input.topics.find((topic) => topic.id === seed.intentId)?.label ?? seed.intentName)
    : null;
  const intent =
    seed.intentId && intentLabel
      ? { id: seed.intentId, label: intentLabel, href: topicHref(projectId, seed.intentId) }
      : null;
  const titleContext = {
    ...seed.title,
    tools: tools.map((tool) => tool.label),
    task: explicitTask,
    topic: explicitTopic,
  };
  const title = fixTitle(seed.kind, titleContext);
  const group = fixGroup(seed.kind);
  const issueRefs: FixIssueRef[] = issues.map((issue) => ({
    id: issue.id,
    kind: issue.kind,
    title: issue.title,
    claim: issue.claim,
    cost: issue.cost,
    figure: issue.figure ?? null,
    href: issueHref(projectId, issue.id),
  }));
  const aliases = [
    ...seed.aliases,
    ...issues.map((issue) => `issue:${issue.id}`).filter((id) => id !== seed.id),
  ];
  const leadCount = lead ? (lead.totalTurns > 0 ? lead.totalTurns : lead.n) : 0;

  let detail = seed.detail;
  let copy = seed.copy;
  let evidence = seed.evidence;
  if (seed.source === "issue") {
    const changes = [...new Set(issues.map((issue) => issue.fix).filter((fix) => fix.length > 0))];
    detail = { source: "issue", changes, caveat: lead?.caveat ?? null };
    copy = {
      label: "Copy prompt",
      text: issuePrompt({
        title,
        issues,
        change: changes.join(" "),
        tools: tools.map((tool) => tool.label),
      }),
    };
    const strength = strengthOf(leadCount);
    evidence = lead ? { strength, label: EVIDENCE_LABEL[strength], detail: lead.figureRaw } : null;
  }
  // A measured effect leads only on solid evidence: "+100 pts" on one search is not the biggest effect.
  const solid = evidence !== null && evidence.strength !== "early";
  const tier =
    seed.effect?.tone === "bad"
      ? 4
      : seed.measured && solid
        ? 0
        : issues.length > 0
          ? 1
          : seed.measured
            ? 2
            : 3;

  const actions: FixActions = {
    apply: seed.apply,
    dismiss: seed.dismiss,
    revert: seed.revert,
    catalogHref: tools.length === 1 ? tools[0]!.href : null,
    copy,
    descriptionHref:
      group === "descriptions"
        ? descriptionHref(
            projectId,
            seed.source === "rewrite"
              ? { rewriteId: seed.sourceId }
              : { toolId: seed.toolIds[0] ?? null },
          )
        : null,
  };
  return {
    id: seed.id,
    source: seed.source,
    sourceId: seed.sourceId,
    aliases,
    title,
    short: fixShortTitle(seed.kind, titleContext),
    why: lead?.claim ?? seed.why,
    kind: seed.kind,
    kindLabel: FIX_KIND_LABELS[seed.kind],
    group,
    status: seed.status,
    subject: { tools, tasks, topics },
    ...(intent ? { intent } : {}),
    effect: seed.effect,
    gain: seed.gain,
    evidence,
    issues: issueRefs,
    actions,
    detail: detail!,
    rank: {
      tier,
      score: tier === 1 ? (lead?.severity ?? 0) : seed.score,
      count: tier === 1 ? leadCount : 0,
    },
    appliedAt: seed.appliedAt,
  };
}

/** The tasks a fix touches: the one it names, then every task that runs all its tools, busiest first. */
function subjectTasks(
  seed: Seed,
  tasks: readonly TaskInput[],
  colors: ReadonlyMap<string, TaskColorSlot>,
  projectId: string,
): FixTaskRef[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const named = seed.taskIds
    .map((id) => byId.get(id))
    .filter((task): task is TaskInput => task !== undefined);
  const running =
    seed.toolIds.length > 0
      ? tasks
          .filter((task) => seed.toolIds.every((id) => task.tools.includes(id)))
          .sort((a, b) => b.runs - a.runs || (a.id < b.id ? -1 : 1))
      : [];
  const seen = new Set<string>();
  return [...named, ...running]
    .filter((task) => (seen.has(task.id) ? false : (seen.add(task.id), true)))
    .slice(0, MAX_TASKS)
    .map((task) => ({
      id: task.id,
      label: task.label,
      color: colors.get(task.id) ?? null,
      href: taskHref(projectId, task.id),
    }));
}

/** The topics a fix serves: the one it names, then those whose turns mostly run its tools or its tasks. */
function subjectTopics(
  seed: Seed,
  tasks: readonly FixTaskRef[],
  topics: readonly TopicInput[],
  projectId: string,
): FixTopicRef[] {
  const named = seed.topicIds
    .map((id) => topics.find((topic) => topic.id === id))
    .filter((topic): topic is TopicInput => topic !== undefined);
  const taskIds = tasks.map((task) => task.id);
  const served = topics
    .filter(
      (topic) =>
        (seed.toolIds.length > 0 &&
          seed.toolIds.every((id) => (topic.toolShares[id] ?? 0) >= TOPIC_SHARE)) ||
        taskIds.some((id) => (topic.taskShares[id] ?? 0) >= TOPIC_SHARE),
    )
    .sort((a, b) => b.turns - a.turns || (a.id < b.id ? -1 : 1));
  const seen = new Set<string>();
  return [...named, ...served]
    .filter((topic) => (seen.has(topic.id) ? false : (seen.add(topic.id), true)))
    .slice(0, MAX_TOPICS)
    .map((topic) => ({ id: topic.id, label: topic.label, href: topicHref(projectId, topic.id) }));
}
