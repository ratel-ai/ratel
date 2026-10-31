import type { FixKind } from "@/lib/views/fixes/kinds";
import type { EvidenceStrength } from "@/lib/views/fixes/types";

/**
 * The words a fix is told in: its title (verb first, plain), its evidence in
 * a word, and the text "Copy prompt" puts on the clipboard. Pure; the
 * product's nouns only (DESIGN.md), never an engine's name.
 */

/** Seen this many times or more: the evidence is solid, then strong. */
export const EVIDENCE_SOLID = 10;
export const EVIDENCE_STRONG = 30;

export const EVIDENCE_LABEL: Record<EvidenceStrength, string> = {
  early: "Early",
  solid: "Solid",
  strong: "Strong",
};

export function strengthOf(count: number): EvidenceStrength {
  return count >= EVIDENCE_STRONG ? "strong" : count >= EVIDENCE_SOLID ? "solid" : "early";
}

/** A tool nobody called is retired on its silence: the longer the window, the stronger. */
export function silenceStrength(days: number): EvidenceStrength {
  return days >= 30 ? "strong" : days >= 14 ? "solid" : "early";
}

export function plural(count: number, one: string, many: string): string {
  return `${Math.round(count).toLocaleString("en-US")} ${Math.round(count) === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const ASK_MAX = 60;

/**
 * An engine's sentence in the product's nouns (DESIGN.md): what Agent health
 * still calls a workflow is a task, and its "workflow skill" a skill. Fixes
 * shows the issues' own words, so it says them in the words the page uses.
 */
export function productWords(text: string): string {
  return text
    .replace(/\bworkflow skills\b/g, "skills")
    .replace(/\bworkflow skill\b/g, "skill")
    .replace(/\bWorkflows\b/g, "Tasks")
    .replace(/\bWorkflow\b/g, "Task")
    .replace(/\bworkflows\b/g, "tasks")
    .replace(/\bworkflow\b/g, "task");
}

/** A person's ask inside a title, quoted and cut to fit one line. */
function quoted(ask: string): string {
  const flat = ask.replace(/\s+/g, " ").trim();
  return `“${flat.length > ASK_MAX ? `${flat.slice(0, ASK_MAX - 1).trimEnd()}…` : flat}”`;
}

/** The first sentence of an engine's "What to do" line, as a title. */
export function sentenceTitle(text: string): string {
  const first = text.trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return first.replace(/[.!?]+$/, "").replace(/,$/, "");
}

export interface TitleContext {
  /** Tool display names, in the order the change reads them. */
  tools: readonly string[];
  /** The task the change is about, when it is about one. */
  task?: string | null;
  /** The topic the change is about, when it is about one. */
  topic?: string | null;
  /** The person's ask a drafted change was found under. */
  ask?: string | null;
  /** How many tools a "nobody uses them" retirement covers. */
  count?: number | null;
  /** Results per search today and suggested. */
  topK?: { from: number; to: number } | null;
  /** For kinds told by an engine this build does not know: its own sentence. */
  sentence?: string | null;
  /** The intent a change is written for (an intent's own skill): the title names it. */
  intent?: string | null;
}

/** Verb first, plain: "Rewrite lookup_order's searchable description". */
export function fixTitle(kind: FixKind, ctx: TitleContext): string {
  if (ctx.sentence) return sentenceTitle(ctx.sentence);
  const [a = "the tool", b = "the next tool"] = ctx.tools;
  switch (kind) {
    case "rewrite":
      return `Rewrite ${a}'s searchable description`;
    case "retire":
      return ctx.tools.length <= 1 && (ctx.count ?? 1) <= 1
        ? `Retire ${a}`
        : `Retire ${plural(ctx.count ?? ctx.tools.length, "tool", "tools")} nobody uses`;
    case "merge":
      return `Merge ${listOf(ctx.tools)}`;
    case "combine":
      return ctx.task
        ? `Combine ${ctx.task}'s steps into one tool`
        : `Combine ${listOf(ctx.tools)} into one tool`;
    case "build":
      if (ctx.ask) return `Build a tool that answers ${quoted(ctx.ask)}`;
      if (ctx.topic) return `Build a tool for ${ctx.topic}`;
      return ctx.tools.length > 0 ? `Build ${a}` : "Build a tool for these asks";
    case "skill":
      if (ctx.intent) return `Add a skill for ${ctx.intent}`;
      if (ctx.tools.length >= 2)
        return `Add a skill that runs ${listOf(ctx.tools).replace(/ and ([^ ]+)$/, " then $1")}`;
      if (ctx.task) return `Add a skill for ${ctx.task}`;
      return ctx.topic ? `Add a skill for ${ctx.topic}` : "Add a skill";
    case "fail-clearly":
      return `Make ${a} fail clearly`;
    case "schema":
      return `Tighten ${a}'s input schema`;
    case "fold":
      return `Let ${b} take what ${a} looks up`;
    case "parallel":
      return `Let ${a} and ${b} run in parallel`;
    case "enrich":
      return `Return what ${b} fetches in ${a}'s response`;
    case "preload":
      return `Hand the agent ${a}'s result up front`;
    case "split":
      return `Split ${a} by how it is used`;
    case "prerequisite":
      return `Make ${b} run ${a} first`;
    case "tell-apart":
      return `Tell ${a} and ${b} apart in their descriptions`;
    case "fewer-results":
      return ctx.topK && ctx.topK.to < ctx.topK.from
        ? `Return ${ctx.topK.to} results per search instead of ${ctx.topK.from}`
        : "Return fewer results per search";
  }
}

/**
 * The title without names, verb first, for rows and panels that show the
 * tools, tasks and intents as pins beside it: "Merge 2 tools into one" next to
 * the two tools. Counts stay; the names are the pins' job (DESIGN.md, The
 * product's nouns). A sentence an engine wrote is not used here: its kind
 * says the same in fewer words, and the sentence stays in the change.
 */
export function fixShortTitle(kind: FixKind, ctx: Omit<TitleContext, "sentence">): string {
  const tools = ctx.tools.length;
  switch (kind) {
    case "rewrite":
      return "Rewrite the searchable description";
    case "tell-apart":
      return tools >= 2 ? `Tell ${tools} tools apart` : "Tell look-alike tools apart";
    case "retire": {
      const count = Math.max(ctx.count ?? tools, tools);
      return count <= 1 ? "Retire a tool" : `Retire ${count} tools nobody uses`;
    }
    case "merge":
      return tools >= 2 ? `Merge ${tools} tools into one` : "Merge into one tool";
    case "combine":
      return tools >= 2
        ? `Combine ${tools} steps into one tool`
        : "Combine the steps into one tool";
    case "build":
      return ctx.ask ? "Build a tool for an unanswered ask" : "Build a missing tool";
    case "skill":
      return tools >= 2 ? `Add a skill for ${tools} steps` : "Add a skill";
    case "fail-clearly":
      return "Make it fail clearly";
    case "schema":
      return "Tighten its input schema";
    case "fold":
      return "Fold the lookup into the next call";
    case "parallel":
      return "Run the two calls in parallel";
    case "enrich":
      return "Return both in one call";
    case "preload":
      return "Hand its result over up front";
    case "split":
      return "Split it by how it is used";
    case "prerequisite":
      return "Run the prerequisite first";
    case "fewer-results":
      return fixTitle(kind, ctx);
  }
}

/** One issue as the problem section of a prompt. */
export interface PromptIssue {
  claim: string;
  cost: string;
}

/**
 * What "Copy prompt" puts on the clipboard for a fix Agent health named:
 * the problem with its numbers, and the change, ready to paste into the
 * customer's own coding agent. Deterministic, like the drafted changes' prompt.
 */
export function issuePrompt(input: {
  title: string;
  issues: readonly PromptIssue[];
  change: string;
  tools: readonly string[];
}): string {
  const lines = [
    `Ratel found a change that would make this agent better: ${input.title}.`,
    "",
    "## Problem",
  ];
  for (const issue of input.issues)
    lines.push(`- ${issue.claim}${issue.cost ? ` ${issue.cost}` : ""}`);
  if (input.tools.length > 0) lines.push(`Tools involved: ${input.tools.join(", ")}`);
  lines.push("", "## Change", input.change);
  return lines.join("\n");
}

/**
 * What "Copy prompt" puts on the clipboard for an intent no skill covers:
 * how often it is asked, the steps the agent works out every time, and the
 * skill to write, ready to paste into the customer's own coding agent.
 * Deterministic: no model writes it.
 */
export function skillGapPrompt(input: {
  title: string;
  intent: string;
  turns: number;
  steps: readonly string[];
  runs: number;
  inOrder: number;
  windowDays: number;
}): string {
  const steps = input.steps.map((step, index) => `${index + 1}. ${step}`);
  return [
    `Ratel found a change that would make this agent better: ${input.title}.`,
    "",
    "## Problem",
    `- People asked for ${input.intent} ${plural(input.turns, "time", "times")} in the last ${plural(input.windowDays, "day", "days")}, and no skill was used or offered for it: the agent works the steps out on every ask.`,
    `- In ${plural(input.runs, "ask", "asks")} it ran ${listOf([...input.steps])}, ${input.inOrder} of them in the order below.`,
    `Tools involved: ${input.steps.join(", ")}`,
    "",
    "## Change",
    `Write a skill (a SKILL.md) for ${input.intent} that walks the agent through these steps and says in its description when to use it:`,
    ...steps,
    "Publish it in the project's skill catalog (Catalog › Skills) so the agent finds it when people ask for this.",
  ].join("\n");
}
