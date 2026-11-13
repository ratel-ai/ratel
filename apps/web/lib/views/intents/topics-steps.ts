import { type TaskColorSlot, taskColors } from "@ratel/design-system/task-colors";
import { COMES_BEFORE_STRONG } from "@/lib/readings/topics/patterns";
import type {
  ComesBeforeStep,
  PatternTool,
  StoredTopicPattern,
  TopicStats,
} from "@/lib/readings/topics/types";
import { runsInFixedOrder } from "@/lib/readings/trace-signals/workflows/fixed-order";
import type { TaskInfo } from "@/lib/views/intents/topics-view";

/**
 * "Step by step" in an Intent's panel, from the pattern the topics job stored
 * (`patterns.ts`): the sentence ("Most of the time this intent is done with X
 * 60% and Y 60%"), the directed picture (the intent, the tools its turns
 * start with, then what comes after each, three steps deep, a share on every
 * arrow), the helper tools named apart, and the task whose steps the main
 * path matches, so the panel can wear that task's color. Pure and
 * client-safe; ids and counts only, names are the panel's to look up.
 */

/** Tool columns after the intent. */
export const PICTURE_DEPTH = 3;
/** Arrows out of one node at most, surest first. */
export const PICTURE_BRANCHES = 3;
/** Tools drawn at most. */
export const PICTURE_MAX_TOOLS = 9;
/** A first call is drawn from this many turns and this share of the intent's... */
export const PICTURE_FIRST_MIN_TURNS = 2;
export const PICTURE_FIRST_MIN_SHARE = 0.2;
/** A task matches the main path when this share of the two sets of tools is shared (overlap over union)... */
export const TASK_MATCH_MIN_OVERLAP = 0.5;
/** ...and it ran at least this share of the intent's turns: a task two of its turns ran as says nothing about it. */
export const TASK_MATCH_MIN_SHARE = 0.2;

export interface StepTool {
  /** A catalog id, or `skill:<id>`. */
  id: string;
  turns: number;
  /** Of the intent's turns. */
  share: number;
}

export interface StepsSentence {
  /** The pattern's tools in their usual order: the X and Y of the sentence. */
  tools: StepTool[];
  /** Turns that ran every one of them, and their share of the intent's turns. */
  together: number;
  togetherShare: number;
  /** Of those, the share that first called them in this order. */
  inOrderShare: number;
  /** Whether the intent runs them in a fixed order, by the one rule (`workflows/fixed-order.ts`). */
  fixedOrder: boolean;
}

export interface StepNode {
  /** Unique in the picture: `intent` for the intent, else the keys on the way to the tool joined with `>`. */
  key: string;
  /** Null for the intent itself. */
  toolId: string | null;
  /** 0 for the intent, 1 for a first call, up to `PICTURE_DEPTH`. */
  depth: number;
  parent: string | null;
  /** One of the pattern's tools: on the main path. */
  main: boolean;
}

export interface StepLink {
  from: string;
  to: string;
  /**
   * `starts`: from the intent, the share of its turns that start with the
   * tool. `follows`: of the tool's turns, the share where the tool before it
   * ran first (What comes before).
   */
  kind: "starts" | "follows";
  /** The share and the turns it is read from. */
  together: number;
  of: number;
  share: number;
  /** A `follows` arrow at the strong share: almost always. */
  strong: boolean;
}

export interface StepsPicture {
  /** The intent first, then by depth, surest first. */
  nodes: StepNode[];
  /** One per tool node, from its parent. */
  links: StepLink[];
}

export interface StepsTask {
  id: string;
  /** Its color when it is one of the three busiest tasks (`lib/tasks/palette.ts`); null wears neutral. */
  color: TaskColorSlot | null;
  /** The intent's turns that ran as this task, and their share. */
  turns: number;
  share: number;
  /** The task's steps are exactly the main path's tools. */
  exact: boolean;
}

export interface IntentStepsView {
  topicId: string;
  /** The intent's turns, and those that called anything. */
  turns: number;
  withCalls: number;
  /** Null when no tool runs in most of its turns: there is no one way it is done. */
  sentence: StepsSentence | null;
  /** Tools it also runs sometimes, busiest first. */
  also: StepTool[];
  /** What its turns start with (helpers skipped), busiest first, each with its share of the turns. */
  firsts: StepTool[];
  /** Helper tools it runs in most turns, named apart and never drawn. */
  helpers: StepTool[];
  /** Empty when no first call reaches the bar. */
  picture: StepsPicture;
  task: StepsTask | null;
}

export interface IntentStepsInput {
  stats: Pick<TopicStats, "id" | "turns" | "tasks" | "pattern">;
  /** The latest signal run's tasks (`loadTaskRuns`): their steps and runs, for the match and the colors. */
  tasks: readonly TaskInfo[];
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function stepTools(tools: readonly PatternTool[], turns: number): StepTool[] {
  return tools.map((tool) => ({ id: tool.id, turns: tool.turns, share: ratio(tool.turns, turns) }));
}

/** The panel's "Step by step" for one intent; null when the reading stored no pattern for it. */
export function buildIntentSteps(input: IntentStepsInput): IntentStepsView | null {
  const { stats } = input;
  const pattern = stats.pattern;
  if (!pattern) return null;
  const tools = stepTools(pattern.tools, stats.turns);
  const main = pattern.tools.map((tool) => tool.id);
  return {
    topicId: stats.id,
    turns: stats.turns,
    withCalls: pattern.withCalls,
    sentence:
      tools.length === 0
        ? null
        : {
            tools,
            together: pattern.runs,
            togetherShare: ratio(pattern.runs, stats.turns),
            inOrderShare: ratio(pattern.inOrder, pattern.runs),
            fixedOrder: fixedOrderOf(pattern),
          },
    also: stepTools(pattern.also, stats.turns),
    firsts: stepTools(pattern.firsts, stats.turns),
    helpers: stepTools(pattern.helpers, stats.turns),
    picture: buildStepsPicture(pattern, stats.turns),
    task: matchTask(main, new Set(pattern.helpers.map((tool) => tool.id)), stats, input.tasks),
  };
}

/**
 * The one fixed-order rule, read for an intent over the turns that ran every
 * one of its pattern's tools: the order is only seen there, so those are its
 * runs (an intent whose three tools ran together in 3 of 100 turns has seen
 * no order), its steps are the pattern's tools, and its stability is the
 * share of those turns that ran them in this order.
 */
export function fixedOrderOf(
  pattern: Pick<StoredTopicPattern, "tools" | "runs" | "inOrder">,
): boolean {
  return runsInFixedOrder({
    runs: pattern.runs,
    coreTools: pattern.tools.map((tool) => tool.id),
    orderStability: ratio(pattern.inOrder, pattern.runs),
  });
}

interface Branch {
  toolId: string;
  kind: StepLink["kind"];
  together: number;
  of: number;
  children: Branch[];
}

interface Placed {
  branch: Branch;
  depth: number;
}

const shareOf = (step: ComesBeforeStep) => ratio(step.together, step.turns);

/** Surer first, then more turns, then by ids, so the picture never depends on input order. */
function surer(a: ComesBeforeStep, b: ComesBeforeStep): number {
  return (
    shareOf(b) - shareOf(a) ||
    b.together - a.together ||
    compareIds(a.first, b.first) ||
    compareIds(a.tool, b.tool)
  );
}

/**
 * A tree from the intent, each tool once. The main path comes first, as a
 * chain: each pattern tool hangs under the one before it when a What comes
 * before step links them (else under the surest earlier one, else from the
 * intent). Then the usual first calls start their own branches, and every
 * other tool a step reaches hangs under the placed tool it most surely comes
 * after, surest arrow first, three steps deep and three arrows a node (the
 * intent's included) at most. A pattern tool no arrow reaches and no turn
 * starts with, or with no arrow left for it, is left out.
 */
function grow(pattern: StoredTopicPattern, turns: number): Branch[] {
  let budget = PICTURE_MAX_TOOLS;
  const roots: Branch[] = [];
  const placed = new Map<string, Placed>();
  const firstsOf = new Map(pattern.firsts.map((first) => [first.id, first.turns]));
  const stepsInto = (tool: string) =>
    pattern.comesBefore.filter((step) => step.tool === tool && step.first !== tool);
  const open = (node: Placed) =>
    node.depth < PICTURE_DEPTH && node.branch.children.length < PICTURE_BRANCHES;
  const place = (
    toolId: string,
    parent: Placed | null,
    kind: StepLink["kind"],
    together: number,
    of: number,
  ) => {
    budget -= 1;
    const branch: Branch = { toolId, kind, together, of, children: [] };
    if (parent) parent.branch.children.push(branch);
    else roots.push(branch);
    placed.set(toolId, { branch, depth: parent ? parent.depth + 1 : 1 });
  };

  // 1. The main path.
  for (const [index, tool] of pattern.tools.entries()) {
    if (budget <= 0) break;
    const earlier = new Set(pattern.tools.slice(0, index).map((t) => t.id));
    const previous = index > 0 ? pattern.tools[index - 1]!.id : null;
    const into = stepsInto(tool.id).filter(
      (step) => earlier.has(step.first) && placed.has(step.first) && open(placed.get(step.first)!),
    );
    const step = into.find((candidate) => candidate.first === previous) ?? [...into].sort(surer)[0];
    if (step) place(tool.id, placed.get(step.first)!, "follows", step.together, step.turns);
    else if ((firstsOf.get(tool.id) ?? 0) > 0 && roots.length < PICTURE_BRANCHES)
      place(tool.id, null, "starts", firstsOf.get(tool.id)!, turns);
  }

  // 2. The other usual first calls.
  const firsts = [...pattern.firsts]
    .filter(
      (first) =>
        !placed.has(first.id) &&
        first.turns >= PICTURE_FIRST_MIN_TURNS &&
        ratio(first.turns, turns) >= PICTURE_FIRST_MIN_SHARE,
    )
    .sort((a, b) => b.turns - a.turns || compareIds(a.id, b.id));
  for (const first of firsts) {
    if (budget <= 0 || roots.length >= PICTURE_BRANCHES) break;
    place(first.id, null, "starts", first.turns, turns);
  }

  // 3. Every other tool a step reaches, surest arrow first.
  while (budget > 0) {
    const next = pattern.comesBefore
      .filter(
        (step) =>
          step.first !== step.tool &&
          !placed.has(step.tool) &&
          placed.has(step.first) &&
          open(placed.get(step.first)!),
      )
      .sort(surer)[0];
    if (!next) break;
    place(next.tool, placed.get(next.first)!, "follows", next.together, next.turns);
  }
  return roots;
}

/** The picture as nodes and links: the intent, then each tool where the tree placed it. */
export function buildStepsPicture(pattern: StoredTopicPattern, turns: number): StepsPicture {
  const roots = grow(pattern, turns);
  if (roots.length === 0) return { nodes: [], links: [] };
  const inPattern = new Set(pattern.tools.map((tool) => tool.id));
  const nodes: StepNode[] = [{ key: "intent", toolId: null, depth: 0, parent: null, main: false }];
  const links: StepLink[] = [];
  let level: { branch: Branch; parent: string }[] = roots.map((branch) => ({
    branch,
    parent: "intent",
  }));
  for (let depth = 1; level.length > 0; depth += 1) {
    const next: { branch: Branch; parent: string }[] = [];
    for (const { branch, parent } of level) {
      const key = `${parent}>${branch.toolId}`;
      const share = ratio(branch.together, branch.of);
      nodes.push({ key, toolId: branch.toolId, depth, parent, main: inPattern.has(branch.toolId) });
      links.push({
        from: parent,
        to: key,
        kind: branch.kind,
        together: branch.together,
        of: branch.of,
        share,
        strong: branch.kind === "follows" && share >= COMES_BEFORE_STRONG,
      });
      for (const child of branch.children) next.push({ branch: child, parent: key });
    }
    level = next;
  }
  return { nodes, links };
}

export interface StepRow {
  node: StepNode;
  /** The arrow into it. */
  link: StepLink;
}

/**
 * The picture as rows to read top to bottom: each tool under the one it
 * comes after, depth first, siblings in the picture's own order (the main
 * path first, then the surest).
 */
export function pictureRows(picture: StepsPicture): StepRow[] {
  const into = new Map(picture.links.map((link) => [link.to, link]));
  const under = new Map<string, StepNode[]>();
  for (const node of picture.nodes) {
    if (node.parent !== null) under.set(node.parent, [...(under.get(node.parent) ?? []), node]);
  }
  const rows: StepRow[] = [];
  const walk = (key: string) => {
    for (const node of under.get(key) ?? []) {
      const link = into.get(node.key);
      if (!link) continue;
      rows.push({ node, link });
      walk(node.key);
    }
  };
  walk("intent");
  return rows;
}

/**
 * The task whose steps the main path matches: among the tasks the intent's
 * turns ran as (in at least `TASK_MATCH_MIN_SHARE` of them), the one whose
 * steps (helpers aside) share the most with the pattern's tools, from half
 * of the two together; ties go to the task more of the intent's turns ran as.
 */
function matchTask(
  main: readonly string[],
  helpers: ReadonlySet<string>,
  stats: Pick<TopicStats, "turns" | "tasks">,
  tasks: readonly TaskInfo[],
): StepsTask | null {
  if (main.length === 0) return null;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const path = new Set(main);
  const candidates = stats.tasks.flatMap((served) => {
    const task = byId.get(served.id);
    if (!task || ratio(served.turns, stats.turns) < TASK_MATCH_MIN_SHARE) return [];
    const steps = new Set(task.typicalOrder.filter((id) => !helpers.has(id)));
    if (steps.size === 0) return [];
    const shared = [...steps].filter((id) => path.has(id)).length;
    const overlap = shared / new Set([...steps, ...path]).size;
    return overlap >= TASK_MATCH_MIN_OVERLAP ? [{ served, overlap }] : [];
  });
  const best = candidates.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      b.served.turns - a.served.turns ||
      compareIds(a.served.id, b.served.id),
  )[0];
  if (!best) return null;
  const colors = taskColors(tasks.map((task) => ({ id: task.id, runs: task.runs })));
  return {
    id: best.served.id,
    color: colors.get(best.served.id) ?? null,
    turns: best.served.turns,
    share: ratio(best.served.turns, stats.turns),
    exact: best.overlap === 1,
  };
}
