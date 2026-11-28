import { countRqlUsage, type RqlTableName } from "@/lib/synthesis/rql/compile";
import { pairKey } from "@/lib/synthesis/rql/domain/usage";
import type { AskContextWidget, AskTarget, EarlierAsk } from "./domain";

/**
 * The prompts Ratel proposes before a person types (decision `ask-in-words`), made from the
 * context of one project without a model. Pure. Each candidate is one short sentence a person
 * could type. The sources: what the project's dashboards already show (the topics read from their
 * stored RQL with the compiler's parser), what the dashboard of a new widget lacks next to what it
 * has, the indexed properties no widget reads yet, the tables with data, the dashboard templates
 * whose data the project has, and the earlier asks: a kept ask (a dashboard made from a template is
 * one) raises the candidates of its topic, a discarded one lowers them. The order is fixed: by
 * score, then by the order of `TOPICS`. The decision model picks among them (`suggest-pick.ts`).
 */

/** What a candidate is about. */
export type SuggestTopic =
  | "volume"
  | "errors"
  | "latency"
  | "cost"
  | "tokens"
  | "models"
  | "scores"
  | "sessions"
  | "users"
  | "property"
  | "template";

export interface SuggestCandidate {
  /** Stable for the same context: `<topic>`, `property:<name>` or `template:<id>`. */
  id: string;
  topic: SuggestTopic;
  text: string;
  score: number;
}

export interface SuggestInput {
  target: AskTarget;
  /** Every dashboard of the project, with the titles and RQL of its widgets. */
  dashboards: readonly { id: string; name: string; widgets: readonly AskContextWidget[] }[];
  /** The dashboard of a new widget; null for a new dashboard. */
  dashboardId: string | null;
  /** The names of the indexed properties. */
  properties: readonly string[];
  /** The tables that hold rows of the project; null when not known (every table counts). */
  tablesWithData: readonly RqlTableName[] | null;
  earlierAsks: readonly EarlierAsk[];
  /** The dashboard templates (`views/dashboards/templates`), and whether the project has their data. */
  templates: readonly SuggestTemplate[];
}

/** A dashboard template as a candidate of a new dashboard: its sentence for Ask. */
export interface SuggestTemplate {
  id: string;
  name: string;
  prompt: string;
  has: boolean;
}

/** The most candidates the decision model chooses from. */
export const MAX_CANDIDATES = 12;
/** The prompts a dialog shows. */
export const MAX_SUGGESTIONS = 4;

interface TopicRule {
  topic: Exclude<SuggestTopic, "property">;
  /** The table its widgets read. */
  table: RqlTableName;
  /** Usage keys (`countRqlUsage`) that show a widget reads it: one name, or two names in one query. */
  keys: readonly (string | readonly [string, string])[];
  /** Words of an ask that are about it. */
  words: RegExp;
  dashboard: string;
  widget: string;
}

/** In the fixed order: what most projects look at first comes first. */
const TOPICS: readonly TopicRule[] = [
  {
    topic: "errors",
    table: "traces",
    keys: ["column:has_error", "column:root_error", "column:status"],
    words: /error|fail|broken|crash/i,
    dashboard: "Show the error rate of my agents and what fails most",
    widget: "Show the error rate per hour",
  },
  {
    topic: "latency",
    table: "traces",
    keys: ["column:duration_ms", "column:total_duration_ms"],
    words: /latency|slow|fast|duration|p95/i,
    dashboard: "Show how long traces take, with p95 latency over time",
    widget: "Show p95 latency per hour",
  },
  {
    topic: "cost",
    table: "events",
    keys: ["column:cost_usd"],
    words: /cost|spend|price|\$|usd|money/i,
    dashboard: "Show what my agents cost per day and which models cost the most",
    widget: "Show cost per day",
  },
  {
    topic: "volume",
    table: "traces",
    // A count over time buckets: a count alone is a part of many other widgets.
    keys: [["function:count", "function:time_bucket"]],
    words: /how many|volume|traffic|runs|busy/i,
    dashboard: "Show how many traces my agents run each hour",
    widget: "Show traces per hour",
  },
  {
    topic: "tokens",
    table: "traces",
    keys: ["column:input_tokens", "column:output_tokens", "column:context_tokens"],
    words: /token|context/i,
    dashboard: "Show input and output tokens per day",
    widget: "Show tokens per day",
  },
  {
    topic: "models",
    table: "events",
    keys: ["column:model", "column:models"],
    words: /model|llm/i,
    dashboard: "Compare the models my agents call: calls, cost and errors",
    widget: "Show calls by model",
  },
  {
    topic: "scores",
    table: "scores",
    keys: ["table:scores"],
    words: /score|pass|quality|judge|eval/i,
    dashboard: "Show the pass rate of each scorer over time",
    widget: "Show the pass rate of each scorer",
  },
  {
    topic: "sessions",
    table: "sessions",
    keys: ["table:sessions"],
    words: /session|conversation/i,
    dashboard: "Show the longest sessions and their cost",
    widget: "Show the longest sessions",
  },
  {
    topic: "users",
    table: "users",
    keys: ["table:users"],
    words: /user|customer|people/i,
    dashboard: "Show which end users spend the most",
    widget: "Show the end users who spend the most",
  },
];

const BASE = 10;
const KEPT = 4;
const DISCARDED = -6;
const EDITED = 2;
/** What the dashboard of a new widget lacks next to what it has. */
const GAP = 5;
/** A topic the project has no widget of. */
const NEW_TO_PROJECT = 2;

/** The candidates of the context, in the fixed order, at most `MAX_CANDIDATES`. */
export function buildCandidates(input: SuggestInput): SuggestCandidate[] {
  const all = input.dashboards.flatMap(({ widgets }) => widgets);
  const own = input.dashboardId
    ? (input.dashboards.find(({ id }) => id === input.dashboardId)?.widgets ?? [])
    : [];
  const projectTopics = topicsOf(all);
  const ownTopics = topicsOf(own);
  const usedProperties = propertiesOf(all);
  const hasData = (table: RqlTableName) =>
    input.tablesWithData === null || input.tablesWithData.includes(table);

  const candidates: SuggestCandidate[] = [];
  for (const rule of TOPICS) {
    if (!hasData(rule.table)) continue;
    let score = BASE + askScore(rule.words, input.earlierAsks);
    if (input.target === "widget") {
      // A widget the dashboard already has is no suggestion.
      if (ownTopics.has(rule.topic)) continue;
      if (ownTopics.size > 0) score += GAP;
    } else if (!projectTopics.has(rule.topic)) score += NEW_TO_PROJECT;
    candidates.push({
      id: rule.topic,
      topic: rule.topic,
      text: input.target === "widget" ? rule.widget : rule.dashboard,
      score,
    });
  }
  if (hasData("traces"))
    for (const name of input.properties) {
      if (usedProperties.has(name)) continue;
      const words = new RegExp(escapeRegExp(name), "i");
      candidates.push({
        id: `property:${name}`,
        topic: "property",
        text:
          input.target === "widget"
            ? `Show traces and errors by ${name}`
            : `Break down traces, cost and errors by ${name}`,
        score: BASE + NEW_TO_PROJECT + askScore(words, input.earlierAsks),
      });
    }
  if (input.target === "dashboard") {
    const names = new Set(input.dashboards.map(({ name }) => name));
    const texts = new Set(candidates.map(({ text }) => text));
    for (const template of input.templates) {
      // A template whose data the project lacks, or whose dashboard it has, is no suggestion.
      if (!template.has || names.has(template.name) || texts.has(template.prompt)) continue;
      const words = new RegExp(escapeRegExp(template.name), "i");
      candidates.push({
        id: `template:${template.id}`,
        topic: "template",
        text: template.prompt,
        score: BASE + askScore(words, input.earlierAsks),
      });
    }
  }
  return candidates
    .map((candidate, order) => ({ candidate, order }))
    .sort((a, b) => b.candidate.score - a.candidate.score || a.order - b.order)
    .slice(0, MAX_CANDIDATES)
    .map(({ candidate }) => candidate);
}

/** The prompts of the fixed order: the first candidates. */
export function fixedSuggestions(candidates: readonly SuggestCandidate[]): string[] {
  return candidates.slice(0, MAX_SUGGESTIONS).map(({ text }) => text);
}

/** The topics the widgets read, by their RQL. */
function topicsOf(widgets: readonly AskContextWidget[]): Set<SuggestTopic> {
  const { uses, together } = countRqlUsage(widgets.map(({ rql }) => rql));
  const read = (key: TopicRule["keys"][number]) =>
    typeof key === "string" ? (uses[key] ?? 0) > 0 : (together[pairKey(key[0], key[1])] ?? 0) > 0;
  const found = new Set<SuggestTopic>();
  for (const rule of TOPICS) if (rule.keys.some(read)) found.add(rule.topic);
  return found;
}

/** The properties the widgets read. */
function propertiesOf(widgets: readonly AskContextWidget[]): Set<string> {
  const { uses } = countRqlUsage(widgets.map(({ rql }) => rql));
  return new Set(
    Object.keys(uses)
      .filter((key) => key.startsWith("property:"))
      .map((key) => key.slice("property:".length)),
  );
}

/** What the earlier asks about the same words add: a kept one raises, a discarded one lowers. */
function askScore(words: RegExp, asks: readonly EarlierAsk[]): number {
  let score = 0;
  for (const ask of asks) {
    if (!words.test(ask.words)) continue;
    if (ask.outcome === "kept") score += KEPT;
    else if (ask.outcome === "edited") score += EDITED;
    else if (ask.outcome === "discarded") score += DISCARDED;
  }
  return score;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
