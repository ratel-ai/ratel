import { formatDuration } from "@/lib/readings/tool-explorer/view";
import type {
  ComposeEvidence,
  CraftedProposalBody,
  CraftedToolDefinition,
  DeprecateEvidence,
  DispatchNote,
  EnrichEvidence,
  FoldEvidence,
  GapEvidence,
  JsonSchemaObject,
  JsonSchemaProperty,
  MergeEvidence,
  PairTiming,
  ParallelEvidence,
  PreloadEvidence,
  RequireEvidence,
  RewriteEvidence,
  SourceTool,
  SplitByUseEvidence,
  TightenEvidence,
} from "@/lib/synthesis/tool-crafter/types";

/**
 * Rule-drafted proposals. Nothing here calls a model: a merge is the two
 * schemas joined (collisions renamed and mapped), the two descriptions
 * joined, the two searchable texts joined with repeats dropped; a rewrite
 * adds the phrasings that missed to the searchable text and touches nothing
 * else. Every number in the prose comes from the evidence. The drafter is
 * pure so a test can pin every word.
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "for",
  "in",
  "on",
  "at",
  "by",
  "with",
  "and",
  "or",
  "it",
  "its",
  "this",
  "that",
  "me",
  "my",
  "i",
  "we",
  "you",
  "is",
  "are",
  "be",
  "do",
  "does",
  "please",
  "can",
  "could",
  "would",
  "want",
  "need",
  "get",
  "show",
  "find",
  "all",
  "from",
  "as",
  "into",
  "about",
  "then",
  "also",
  "some",
  "any",
  "new",
  "up",
]);
const MAX_TRIGGER_PHRASES = 5;
const MAX_PHRASE_CHARS = 80;

export function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** The words of a tool id: `find_task`, `findTask` and `find-task` all give ["find", "task"]. */
export function nameParts(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length > 0);
}

/** `find_task` + `assign_task` -> `find_assign_task`; otherwise `a_then_b` (sequenced) or `a_or_b` (swapped). */
export function mergedName(a: string, b: string, sequenced: boolean): string {
  const pa = nameParts(a);
  const pb = nameParts(b);
  const last = pa[pa.length - 1];
  if (pa.length > 1 && pb.length > 1 && last === pb[pb.length - 1]) {
    return [...pa.slice(0, -1), ...pb.slice(0, -1).filter((p) => !pa.includes(p)), last].join("_");
  }
  return `${pa.join("_")}_${sequenced ? "then" : "or"}_${pb.join("_")}`;
}

export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  return (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

/** Two texts joined, every repeated word (after the first) dropped, so BM25 does not saturate on repeats. */
export function joinSearchable(...texts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    for (const word of text.split(/\s+/)) {
      const key = word.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (key.length === 0) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(word);
    }
  }
  return out.join(" ");
}

function searchableOf(tool: SourceTool): string {
  return tool.searchableDescription?.trim() || tool.description;
}

function propertiesOf(tool: SourceTool): Record<string, JsonSchemaProperty> {
  return tool.inputSchema?.properties && typeof tool.inputSchema.properties === "object"
    ? tool.inputSchema.properties
    : {};
}

function requiredOf(tool: SourceTool): string[] {
  return Array.isArray(tool.inputSchema?.required)
    ? tool.inputSchema.required.filter((r): r is string => typeof r === "string")
    : [];
}

function sameShape(a: JsonSchemaProperty, b: JsonSchemaProperty): boolean {
  return (
    JSON.stringify(a.type ?? null) === JSON.stringify(b.type ?? null) &&
    JSON.stringify(a.enum ?? null) === JSON.stringify(b.enum ?? null)
  );
}

/**
 * The name a moved argument takes: the whole tool id, then the argument, so
 * `get_user` and `get_task` never share a stem; stepped aside from any
 * property already there.
 */
function movedName(
  tool: SourceTool,
  name: string,
  properties: Readonly<Record<string, JsonSchemaProperty>>,
): string {
  const parts = nameParts(tool.id);
  const base = `${parts.length > 0 ? parts.join("_") : tool.id.toLowerCase()}_${name}`;
  let candidate = base;
  for (let i = 2; candidate in properties; i++) candidate = `${base}_${i}`;
  return candidate;
}

export interface MergedSchema {
  schema: JsonSchemaObject;
  /** Per source tool, old argument name to new one, for the arguments that moved. */
  mappings: Record<string, Record<string, string>>;
}

/**
 * The union of the sources' properties. An argument both tools take with the
 * same type is shared; one they take with different shapes is kept twice
 * under `<tool id>_<name>` and the moves are recorded. `required` is the union,
 * under the new names, unless `optionalAll` (the swapped-siblings merge, where
 * either half's arguments may be absent).
 */
export function mergeSchemas(sources: readonly SourceTool[], optionalAll = false): MergedSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const owner = new Map<string, SourceTool>();
  const mappings: Record<string, Record<string, string>> = Object.fromEntries(
    sources.map((s) => [s.id, {}]),
  );
  const required = new Set<string>();
  for (const source of sources) {
    for (const [name, property] of Object.entries(propertiesOf(source))) {
      const existing = properties[name];
      const first = owner.get(name);
      let target = name;
      if (existing && first && first.id !== source.id && !sameShape(existing, property)) {
        // Move the earlier owner's copy too, so neither side silently wins the bare name.
        const firstName = movedName(first, name, properties);
        properties[firstName] = existing;
        mappings[first.id]![name] = firstName;
        if (required.has(name)) {
          required.delete(name);
          required.add(firstName);
        }
        delete properties[name];
        target = movedName(source, name, properties);
        mappings[source.id]![name] = target;
      }
      if (!(target in properties)) {
        properties[target] = {
          ...property,
          ...(target !== name
            ? { description: `${property.description ?? name} (from ${source.id})` }
            : {}),
        };
        if (target === name) owner.set(name, source);
      }
      if (!optionalAll && requiredOf(source).includes(name)) required.add(target);
    }
  }
  const schema: JsonSchemaObject = {
    type: "object",
    properties,
    ...(required.size > 0 ? { required: [...required].sort() } : {}),
  };
  return { schema, mappings };
}

export interface MergeDraftInput {
  a: SourceTool;
  b: SourceTool;
  evidence: MergeEvidence;
  /** Catalog ids, so the drafted name can step aside from an existing one. */
  catalogIds: ReadonlySet<string>;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * The time sentences a merge or fold carries, from the Explorer's timing:
 * what each call takes, what the agent spent between the two, and what one
 * tool instead of two would therefore save. The tools' own run time is named
 * and left alone; only the hand-off is claimed as saved.
 */
export function timingSentences(
  a: string,
  b: string,
  t: PairTiming | undefined,
): { details: string; effect: string } {
  if (!t || (t.aCalls === 0 && t.bCalls === 0)) return { details: "", effect: "" };
  const runs = [
    t.aMedianMs !== null
      ? `${a} takes ${formatDuration(t.aMedianMs)} a call (median), ${formatDuration(t.aTotalMs)} over its ${t.aCalls} calls`
      : null,
    t.bMedianMs !== null
      ? `${b} takes ${formatDuration(t.bMedianMs)} a call, ${formatDuration(t.bTotalMs)} over its ${t.bCalls} calls`
      : null,
  ].filter((x): x is string => x !== null);
  const handoff =
    t.handoffPairs > 0
      ? `Between the two the agent spent ${formatDuration(t.handoffMsTotal)} in all over ${t.handoffPairs} hand-offs (${formatDuration(t.handoffMsMedian)} each, median)${t.searchesBetween > 0 ? `, including ${t.searchesBetween} searches for the second tool` : ""}.`
      : "";
  const details = [runs.length > 0 ? `${runs.join("; ")}.` : "", handoff]
    .filter((x) => x.length > 0)
    .join(" ");
  const effect =
    t.handoffPairs > 0
      ? `One call instead of two removes the hand-off: about ${formatDuration(t.handoffMsTotal)}${t.searchesBetween > 0 ? ` and ${t.searchesBetween} searches` : ""} over this window, ${formatDuration(t.handoffMsMedian)} per request. The tools' own run time (${formatDuration(t.aTotalMs + t.bTotalMs)} in all) stays.`
      : "";
  return { details, effect };
}
const noun = (scope: "turn" | "session", n: number) =>
  scope === "turn" ? (n === 1 ? "turn" : "turns") : n === 1 ? "session" : "sessions";

function freeName(name: string, catalogIds: ReadonlySet<string>): string {
  let candidate = name;
  for (let i = 2; catalogIds.has(candidate); i++) candidate = `${name}_${i}`;
  return candidate;
}

/**
 * The words of a merge found in one intent's own pattern: the counts are the
 * intent's turns, and the intent is named where the fix is shown, by id,
 * never here.
 */
function intentMergeWords(
  a: string,
  b: string,
  evidence: MergeEvidence,
  intent: NonNullable<MergeEvidence["intent"]>,
): { rationale: string; details: string } {
  return {
    rationale: `${a} and ${b} ran together in ${intent.runs} of one intent's ${intent.turns} turns (${pct(intent.runs / Math.max(1, intent.turns))}), ${a} first in ${evidence.orderAb} of them: one call can do both for that intent.`,
    details: [
      `Inside that intent, ${pct(evidence.pAb)} of ${a}'s ${evidence.unitsA} turns also ran ${b}, and ${pct(evidence.pBa)} of ${b}'s ${evidence.unitsB} ran ${a}.`,
      `${a} ran before ${b} in ${evidence.orderAb} of the ${evidence.support} turns that ran both, so the merged tool runs them in that order.`,
    ].join(" "),
  };
}

/**
 * Two tools the agent never runs apart become one. Sequenced (A nearly always
 * right before B) gets A's arguments then B's and a handler that runs both in
 * order; swapped (either way around) gets a `mode` argument naming which half
 * to run, every other argument optional.
 */
export function draftMerge(input: MergeDraftInput): CraftedProposalBody {
  const { a, b, evidence } = input;
  const sequenced =
    evidence.nextP !== null &&
    evidence.nextP >= 0.6 &&
    evidence.orderAb >= 3 * Math.max(1, evidence.orderBa);
  const merged = mergeSchemas([a, b], !sequenced);
  const name = freeName(mergedName(a.id, b.id, sequenced), input.catalogIds);
  const unitNoun = noun(evidence.scope, evidence.support);

  if (!sequenced) {
    merged.schema.properties = {
      mode: {
        type: "string",
        enum: [a.id, b.id],
        description: `Which operation to run: ${a.id} (${firstSentence(a.description).toLowerCase()}) or ${b.id} (${firstSentence(b.description).toLowerCase()}).`,
      },
      ...merged.schema.properties,
    };
    merged.schema.required = ["mode"];
  }

  const dispatch: DispatchNote[] = [
    {
      sourceToolId: a.id,
      when: sequenced ? "always, as the first step" : `mode = "${a.id}"`,
      argumentMapping: merged.mappings[a.id] ?? {},
    },
    {
      sourceToolId: b.id,
      when: sequenced
        ? "always, as the second step, with what the first step returned"
        : `mode = "${b.id}"`,
      argumentMapping: merged.mappings[b.id] ?? {},
    },
  ];

  const description = sequenced
    ? `${firstSentence(a.description)}, then ${lowerFirst(firstSentence(b.description))}. One call does both; the agent no longer searches twice.`
    : `${firstSentence(a.description)}, or ${lowerFirst(firstSentence(b.description))}, chosen by \`mode\`. One tool for two operations the agent kept switching between.`;

  const crafted: CraftedToolDefinition = {
    name,
    description,
    searchableDescription: joinSearchable(searchableOf(a), searchableOf(b)),
    inputSchema: merged.schema,
    outputNotes: sequenced
      ? `Returns what ${b.id} returned, with ${a.id}'s result alongside so nothing the agent read before is lost.`
      : `Returns what the selected operation (${a.id} or ${b.id}) returned.`,
    dispatch,
  };

  const renamed = Object.entries(merged.mappings)
    .flatMap(([id, map]) => Object.entries(map).map(([from, to]) => `${id}.${from} is now ${to}`))
    .join("; ");
  const time = timingSentences(a.id, b.id, evidence.timing);

  return {
    kind: "merge_tools",
    sourceToolIds: [a.id, b.id],
    crafted: [crafted],
    // A pair one intent always runs may still run apart in other intents: nothing is retired.
    hidden: evidence.intent ? [] : [a.id, b.id],
    ...(evidence.intent
      ? intentMergeWords(a.id, b.id, evidence, evidence.intent)
      : {
          rationale: `${a.id} and ${b.id} ran together in ${evidence.support} of the ${unitNoun} that called either (${pct(evidence.jaccard)}); the agent never needs one without the other.`,
          details: [
            `Over the ${evidence.scope === "turn" ? "turns" : "sessions"} in the window, ${pct(evidence.pAb)} of ${a.id}'s ${evidence.unitsA} ${noun(evidence.scope, evidence.unitsA)} also ran ${b.id}, and ${pct(evidence.pBa)} of ${b.id}'s ${evidence.unitsB} ran ${a.id}.`,
            sequenced
              ? `${a.id} came right before ${b.id} ${pct(evidence.nextP ?? 0)} of the time (${evidence.orderAb} ${a.id}-first against ${evidence.orderBa} ${b.id}-first), so the merged tool runs them in that order.`
              : `The order varied (${evidence.orderAb} ${a.id}-first, ${evidence.orderBa} ${b.id}-first), so the merged tool takes a \`mode\` rather than fixing an order.`,
            `The Jaccard lower bound is ${pct(evidence.jaccardLow)} at this support, which is the bar for "always together".`,
            time.details,
          ]
            .filter((x) => x.length > 0)
            .join(" "),
        }),
    expectedEffect: [
      sequenced
        ? "One search and one call where there were two of each; the second step can no longer be forgotten or mis-ordered."
        : "One search where there were two, and no more picking the wrong sibling: the choice is an argument the agent fills from the request.",
      // A mode switch still takes one call per operation, so the hand-off stays.
      sequenced ? time.effect : "",
    ]
      .filter((x) => x.length > 0)
      .join(" "),
    migrationNotes: [
      `Add a tool named ${name} whose handler ${sequenced ? `calls ${a.id} and then ${b.id} with the first result` : `calls ${a.id} or ${b.id} according to \`mode\``}.`,
      renamed.length > 0 ? `Renamed arguments: ${renamed}.` : "No argument was renamed.",
      evidence.intent
        ? `Keep ${a.id} and ${b.id} registered: other intents may still call them on their own.`
        : `Keep ${a.id} and ${b.id} registered until the agent is seen calling ${name}; then retire them.`,
    ].join(" "),
  };
}

export interface RewriteDraftInput {
  tool: SourceTool;
  evidence: RewriteEvidence;
}

/** Up to five distinct phrasings from the queries that missed, shortest first, that add words the text lacks. */
export function triggerPhrases(
  current: string,
  queries: readonly string[],
  max = MAX_TRIGGER_PHRASES,
): string[] {
  const have = new Set(tokensOf(current));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const query of [...queries]
    .map((q) => q.trim())
    .filter((q) => q.length > 0 && q.length <= MAX_PHRASE_CHARS)
    .sort((x, y) => x.length - y.length)) {
    const key = tokensOf(query)
      .filter((t) => !STOPWORDS.has(t))
      .sort()
      .join(" ");
    if (key.length === 0 || seen.has(key)) continue;
    const fresh = tokensOf(query).filter((t) => !STOPWORDS.has(t) && !have.has(t));
    if (fresh.length === 0) continue;
    seen.add(key);
    out.push(query);
    for (const t of fresh) have.add(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * A rewrite changes the searchable text only: the phrasings users actually
 * used and the text lacked are appended as "Also asked as", so retrieval
 * matches the way the request is put, and the name and schema stay as the
 * runtime defines them.
 */
export function draftRewrite(input: RewriteDraftInput): CraftedProposalBody | null {
  const { tool, evidence } = input;
  const current = searchableOf(tool);
  const phrases = triggerPhrases(current, [
    ...evidence.missedQueries,
    ...evidence.buriedQueries.map((b) => b.query),
  ]);
  if (phrases.length === 0) return null;
  const searchable = joinSearchable(current, `Also asked as: ${phrases.join("; ")}.`);
  const distractors = evidence.distractors.slice(0, 3);
  return {
    kind: "rewrite_tool",
    sourceToolIds: [tool.id],
    crafted: [
      {
        name: tool.id,
        description: tool.description,
        searchableDescription: searchable,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        outputNotes: null,
        dispatch: [{ sourceToolId: tool.id, when: "always", argumentMapping: {} }],
      },
    ],
    hidden: [],
    rationale: `${tool.id} was missed by ${evidence.missedQueries.length} ${evidence.missedQueries.length === 1 ? "query" : "queries"} and buried on ${evidence.buriedQueries.length}; its text lacks the words those asks used.`,
    details: [
      `Missed: ${evidence.missedQueries
        .slice(0, 3)
        .map((q) => `"${q}"`)
        .join(
          ", ",
        )}${evidence.missedQueries.length > 3 ? ` and ${evidence.missedQueries.length - 3} more` : ""}.`,
      evidence.buriedQueries.length > 0
        ? `Buried: ${evidence.buriedQueries
            .slice(0, 2)
            .map((b) => `"${b.query}" at #${b.rank}`)
            .join(", ")}.`
        : "",
      distractors.length > 0 ? `Outranked by ${distractors.join(", ")}.` : "",
    ]
      .filter((s) => s.length > 0)
      .join(" "),
    expectedEffect: `The ${phrases.length} added ${phrases.length === 1 ? "phrasing" : "phrasings"} give retrieval the words these asks used; the name and schema are unchanged, so nothing the agent calls changes.`,
    migrationNotes: `Only the searchable description changes: set it as ${tool.id}'s searchable description in the runtime.`,
  };
}

export interface FoldDraftInput {
  /** The lookup. */
  a: SourceTool;
  /** The tool it feeds. */
  b: SourceTool;
  evidence: FoldEvidence;
  catalogIds: ReadonlySet<string>;
}

/**
 * A lookup the agent only ever runs to feed one tool becomes optional input of
 * that tool: B keeps every argument it had, gains A's (optional, renamed on a
 * collision), and its handler runs A first when A's arguments are the ones
 * given. A stays registered until the agent is seen using the new tool.
 */
export function draftFold(input: FoldDraftInput): CraftedProposalBody {
  const { a, b, evidence } = input;
  const merged = mergeSchemas([b, a]);
  // B's requirements stand; A's arguments are the alternative way in.
  merged.schema.required = requiredOf(b).map((name) => merged.mappings[b.id]?.[name] ?? name);
  if (merged.schema.required.length === 0) delete merged.schema.required;
  const aArgs = Object.keys(propertiesOf(a)).map((name) => merged.mappings[a.id]?.[name] ?? name);
  const name = freeName(
    `${nameParts(b.id).join("_")}_by_${nameParts(a.id)[0] ?? "lookup"}`,
    input.catalogIds,
  );
  const crafted: CraftedToolDefinition = {
    name,
    description: `${firstSentence(b.description)}. Give ${aArgs.length > 0 ? aArgs.map((x) => `\`${x}\``).join(" or ") : "the lookup's input"} instead of ${b.id}'s own identifier and it ${lowerFirst(firstSentence(a.description))} first.`,
    searchableDescription: joinSearchable(searchableOf(b), searchableOf(a)),
    inputSchema: merged.schema,
    outputNotes: `Returns what ${b.id} returned.`,
    dispatch: [
      {
        sourceToolId: a.id,
        when: `${aArgs.length > 0 ? aArgs.join(" or ") : "its input"} given: run first, to resolve ${b.id}'s input`,
        argumentMapping: merged.mappings[a.id] ?? {},
      },
      {
        sourceToolId: b.id,
        when: "always, with what the lookup resolved",
        argumentMapping: merged.mappings[b.id] ?? {},
      },
    ],
  };
  const unitNoun = noun(evidence.scope, evidence.unitsA);
  const time = timingSentences(a.id, b.id, evidence.timing);
  return {
    kind: "fold_prerequisite",
    sourceToolIds: [a.id, b.id],
    crafted: [crafted],
    hidden: [a.id],
    rationale: `${a.id} is only ever a step before ${b.id}: ${pct(evidence.pAb)} of its ${evidence.unitsA} ${unitNoun} went on to ${b.id}, while ${b.id} runs without it ${pct(1 - evidence.pBa)} of the time.`,
    details: [
      `${evidence.orderAb} ${noun(evidence.scope, evidence.orderAb)} ran ${a.id} before ${b.id} against ${evidence.orderBa} the other way around. ${b.id} ran in ${evidence.unitsB} ${noun(evidence.scope, evidence.unitsB)}; ${pct(evidence.pBa)} of them had the lookup first.`,
      time.details,
    ]
      .filter((x) => x.length > 0)
      .join(" "),
    expectedEffect: [
      `One search and one call where the agent made two; ${b.id}'s callers that already hold its identifier are unaffected.`,
      time.effect,
    ]
      .filter((x) => x.length > 0)
      .join(" "),
    migrationNotes: `Add ${name}: ${b.id}'s handler, which calls ${a.id} first when ${aArgs.join(" or ") || "the lookup's input"} is given and ${b.id}'s own identifier is not. Keep ${a.id} registered until the agent is seen calling ${name}.`,
  };
}

export interface DeprecateDraftInput {
  tool: SourceTool;
  replacement: SourceTool | null;
  evidence: DeprecateEvidence;
}

/** A declared tool nothing called in the window: retire it, naming the used tool it overlaps with. */
export function draftDeprecate(input: DeprecateDraftInput): CraftedProposalBody {
  const { tool, replacement, evidence } = input;
  const name = replacement?.id ?? null;
  return {
    kind: "deprecate_tool",
    sourceToolIds: [tool.id],
    crafted: [],
    hidden: [tool.id],
    rationale: `${tool.id} was declared but never called in ${evidence.windowDays} days${name ? `, while ${name}, which shares its words (${evidence.sharedWords.join(", ")}), ran ${evidence.replacementCalls} times` : ""}.`,
    details: name
      ? `Two tools answering to the same words split retrieval between them; the agent chose ${name} every time it chose.`
      : `No used tool shares its words, so retiring it costs nothing the agent has shown it wants.`,
    expectedEffect:
      "One fewer entry in every list the agent reads, and no more splitting of retrieval between look-alikes.",
    migrationNotes: name
      ? `Remove ${tool.id} from the registry and use \`${name}\` instead.`
      : `Remove ${tool.id} from the registry.`,
  };
}

// ---------------------------------------------------------------------------

export interface ComposeDraftInput {
  /** In the chain's order. */
  tools: SourceTool[];
  evidence: ComposeEvidence;
  catalogIds: ReadonlySet<string>;
}

/**
 * One tool for a fixed chain: the schemas joined and every tool's
 * requirements kept, so the agent supplies up front what each step needs.
 * The dispatch is the chain in order; what one step passes to the next is
 * the handler's to work out from the steps' schemas.
 */
export function draftCompose(input: ComposeDraftInput): CraftedProposalBody {
  const { tools, evidence } = input;
  const merged = mergeSchemas(tools);
  const first = tools[0]!;
  const last = tools[tools.length - 1]!;
  const name = freeName(
    `${nameParts(first.id).join("_")}_to_${nameParts(last.id).slice(-1)[0] ?? "end"}`,
    input.catalogIds,
  );
  const steps = tools.map((t) => t.id);
  const crafted: CraftedToolDefinition = {
    name,
    description: `${steps.join(", then ")}: one call that ${lowerFirst(firstSentence(first.description))}, then ${tools
      .slice(1)
      .map((t) => lowerFirst(firstSentence(t.description)))
      .join(", then ")}. Use it when the request needs the whole sequence.`,
    searchableDescription: joinSearchable(...tools.map(searchableOf)),
    inputSchema: merged.schema,
    outputNotes: `Returns what ${last.id} returned, with each earlier step's result alongside.`,
    dispatch: tools.map((t, i) => ({
      sourceToolId: t.id,
      when: i === 0 ? "first" : `after ${tools[i - 1]!.id}, with what it returned`,
      argumentMapping: merged.mappings[t.id] ?? {},
      order: i,
    })),
  };
  const calls = evidence.medianModelCalls;
  const saved = calls !== null ? Math.max(0, Math.round(calls - calls / steps.length)) : null;
  return {
    kind: "compose_chain",
    sourceToolIds: steps,
    crafted: [crafted],
    hidden: [],
    rationale: `${steps.join(" → ")} ran as one chain in ${evidence.runs} runs, in this order ${pct(evidence.orderStability)} of the time.`,
    details: `Agent health found these steps as a task (${evidence.workflowId}); a run takes ${evidence.medianMs !== null ? formatDuration(evidence.medianMs) : "an unmeasured time"}${calls !== null ? ` and ${calls} model calls` : ""}.`,
    expectedEffect: `${steps.length} calls become one${saved !== null && saved > 0 ? `, about ${saved} fewer model round-trips per run (${evidence.runs} runs in this window)` : ""}; the tools' own run time stays.`,
    migrationNotes: `Add ${name}: a handler that calls ${steps.join(", then ")} and passes each result to the next. Keep the ${steps.length} tools registered for requests that need one step alone.`,
  };
}

export interface ParallelDraftInput {
  a: SourceTool;
  b: SourceTool;
  evidence: ParallelEvidence;
}

/** Both tools kept as they are, each told it does not wait for the other; names and schemas unchanged. */
export function draftParallel(input: ParallelDraftInput): CraftedProposalBody {
  const { a, b, evidence } = input;
  const note = (self: SourceTool, other: SourceTool): CraftedToolDefinition => ({
    name: self.id,
    description: `${self.description.trim()} Independent of ${other.id}: when both are needed, call them in the same step.`,
    searchableDescription: searchableOf(self),
    inputSchema: self.inputSchema ?? { type: "object", properties: {} },
    outputNotes: null,
    dispatch: [{ sourceToolId: self.id, when: "always", argumentMapping: {} }],
  });
  const overlap =
    evidence.aMedianMs !== null && evidence.bMedianMs !== null
      ? Math.min(evidence.aMedianMs, evidence.bMedianMs)
      : null;
  const ordered = evidence.orderAb + evidence.orderBa;
  return {
    kind: "parallel_pair",
    sourceToolIds: [a.id, b.id],
    crafted: [note(a, b), note(b, a)],
    hidden: [],
    rationale: `${a.id} and ${b.id} ran together in ${evidence.support} ${noun(evidence.scope, evidence.support)} (${pct(evidence.jaccard)} of those with either), ${a.id} first ${pct(evidence.orderAb / Math.max(1, ordered))} of the time and ${b.id} first ${pct(evidence.orderBa / Math.max(1, ordered))}: neither waits for the other.`,
    details: `Consecutive runs went ${a.id} → ${b.id} ${evidence.nextAb} times and ${b.id} → ${a.id} ${evidence.nextBa} times. Medians: ${a.id} ${evidence.aMedianMs !== null ? formatDuration(evidence.aMedianMs) : "—"}, ${b.id} ${evidence.bMedianMs !== null ? formatDuration(evidence.bMedianMs) : "—"}.`,
    expectedEffect:
      overlap !== null
        ? `Called in the same step, the two waits overlap: about ${formatDuration(overlap)} less per request, ${evidence.support} requests in this window.`
        : "Called in the same step, the two waits overlap instead of adding up.",
    migrationNotes: `Say in each description that the tools are independent (the text above), and let the runtime run tool calls of one step concurrently. No schema change.`,
  };
}

export interface TightenDraftInput {
  tool: SourceTool;
  evidence: TightenEvidence;
}

/** Failed first calls a schema fix is known to avoid: the named ones when the run kept recovery paths, else every recovered retry. */
export function tightenAvoidable(evidence: TightenEvidence): number {
  return evidence.namedRecovered ?? evidence.recoveredRetries;
}

/**
 * No definition is drafted: only the customer's validator knows the real
 * constraints. The notes name the arguments the errors named, then say how
 * to find the rest: compare the validator with the published schema, write
 * every constraint the validator enforces into the schema, and make each
 * validation error name the argument.
 */
export function draftTighten(input: TightenDraftInput): CraftedProposalBody {
  const { tool, evidence } = input;
  const named = evidence.namedArguments ?? [];
  const classed = evidence.namedRecovered !== undefined;
  const avoidable = tightenAvoidable(evidence);
  const unnamed = classed
    ? Math.max(0, (evidence.directRecovered ?? 0) - evidence.namedRecovered!)
    : 0;
  const viaLookup = (evidence.viaLookup ?? []).reduce((sum, v) => sum + v.n, 0);
  const steps: string[] = [];
  if (named.length > 0)
    steps.push(
      `start with ${named.map((x) => `\`${x}\``).join(", ")}: the validation errors named ${named.length === 1 ? "it" : "them"}`,
    );
  steps.push(
    `compare ${tool.id}'s validator with its published input schema and write every constraint the validator enforces that the schema omits: enums, length and range caps, required fields, formats, and where an id comes from`,
  );
  if (evidence.freeTextArgs.length > 0)
    steps.push(
      `give ${evidence.freeTextArgs.map((x) => `\`${x}\``).join(", ")} an enum of the accepted values`,
    );
  if (evidence.undocumentedArgs.length > 0)
    steps.push(
      `describe ${evidence.undocumentedArgs.map((x) => `\`${x}\``).join(", ")} (format, example)`,
    );
  steps.push(
    "make each validation error name the argument and the accepted values, so a call that still fails fixes itself on the retry",
  );
  return {
    kind: "tighten_schema",
    sourceToolIds: [tool.id],
    crafted: [],
    hidden: [],
    rationale: classed
      ? `${tool.id} failed ${evidence.errorCalls} of ${evidence.calls} calls. ${evidence.namedRecovered} ${evidence.namedRecovered === 1 ? "failure" : "failures"} named the argument and the agent's straight retry then succeeded, so the first call was shaped wrong, not the tool${unnamed > 0 ? `; ${unnamed} more recovered the same way after a bare error code, which may be the same cause` : ""}${viaLookup > 0 ? `; ${viaLookup} recovered only after a lookup, which is a prerequisite, not a schema matter` : ""}${(evidence.excludedRetried ?? 0) > 0 ? `; ${evidence.excludedRetried} retried not-found or server ${evidence.excludedRetried === 1 ? "error is" : "errors are"} not counted` : ""}.`
      : `${tool.id} failed ${evidence.errorCalls} of ${evidence.calls} calls; ${evidence.retriedErrors} failures were retried and ${evidence.recoveredRetries} of those retries succeeded, so the first call was shaped wrong, not the tool.`,
    details: `${named.length > 0 ? `The validation errors named ${named.map((x) => `\`${x}\``).join(", ")}. ` : ""}The schema declares ${evidence.requiredArgs.length} required ${evidence.requiredArgs.length === 1 ? "argument" : "arguments"}${evidence.undocumentedArgs.length > 0 ? `, ${evidence.undocumentedArgs.length} without a description` : ""}${evidence.freeTextArgs.length > 0 ? `, and ${evidence.freeTextArgs.length} free-text ${evidence.freeTextArgs.length === 1 ? "argument that reads" : "arguments that read"} like a fixed set of values` : ""}. Argument values are not recorded, so which value was wrong is not known here.`,
    expectedEffect: `Up to ${avoidable} failed first calls avoided in this window, each a tool call and a model round-trip.`,
    migrationNotes: `In ${tool.id}'s tool server: ${steps.join("; ")}.`,
  };
}

export interface EnrichDraftInput {
  a: SourceTool;
  b: SourceTool;
  evidence: EnrichEvidence;
}

/** No definition is drafted: the change is to a's response, whose shape only the customer knows. */
export function draftEnrich(input: EnrichDraftInput): CraftedProposalBody {
  const { a, b, evidence } = input;
  const ask = evidence.intentText ? `"${evidence.intentText}"` : "this ask";
  const p = Math.round((evidence.n / evidence.na) * 100);
  return {
    kind: "enrich_response",
    sourceToolIds: [a.id, b.id],
    crafted: [],
    hidden: [],
    rationale: `For ${ask}, ${b.id} came right after ${a.id} in ${evidence.n} of ${evidence.na} calls (${p}%): ${a.id}'s response is never enough on its own, the agent always has to fetch what ${b.id} returns.`,
    details: `${b.id} reads (${b.description.trim().split(/(?<=[.!?])\s/)[0] ?? b.id}). Outside this ask it ran in ${evidence.bUnitsOutside} ${evidence.bUnitsOutside === 1 ? "turn" : "turns"} in this window, so ${evidence.bUnitsOutside === 0 ? "every call of it is this hop" : "most of it is elsewhere and it stays as it is"}.`,
    expectedEffect: `One call instead of two for every turn of ${ask} (${evidence.n} ${evidence.n === 1 ? "hop" : "hops"} in this window)${evidence.bMedianMs !== null ? `, about ${formatDuration(evidence.bMedianMs)} less per turn` : ""}, and one fewer model round-trip.`,
    migrationNotes: `In ${a.id}'s handler, include what ${b.id} returns for the same subject in the response (a field named after ${nameParts(b.id).slice(-1)[0] ?? b.id}). Keep ${b.id} registered: other asks still call it on its own.`,
  };
}

export interface PreloadDraftInput {
  tool: SourceTool;
  evidence: PreloadEvidence;
}

/** No definition is drafted: the change is to what the agent is handed before the turn, not to a tool. */
export function draftPreload(input: PreloadDraftInput): CraftedProposalBody {
  const { tool, evidence } = input;
  const ask = evidence.intentText ? `"${evidence.intentText}"` : "this ask";
  const p = Math.round((evidence.firstN / Math.max(1, evidence.units)) * 100);
  return {
    kind: "preload_context",
    sourceToolIds: [tool.id],
    crafted: [],
    hidden: [],
    rationale: `${evidence.firstN} of ${evidence.units} turns of ${ask} (${p}%) open with ${tool.id}, before the agent has decided anything: that lookup is setup, not a choice.`,
    details: `${tool.id} reads (${tool.description.trim().split(/(?<=[.!?])\s/)[0] ?? tool.id}). Handing its result to the agent at the start of the turn removes the call and the model round-trip that waits for it.`,
    expectedEffect: `One call and one model round-trip fewer for every turn of ${ask} (${evidence.firstN} in this window)${evidence.medianMs !== null ? `, about ${formatDuration(evidence.medianMs)} less per turn` : ""}.`,
    migrationNotes: `Where the agent's turn is assembled (system prompt, resources, or the host's turn-start hook), include ${tool.id}'s result for the current user or project. Keep ${tool.id} registered for turns that need it fresh.`,
  };
}

export interface SplitByUseDraftInput {
  tool: SourceTool;
  evidence: SplitByUseEvidence;
}

/** No definition is drafted: which way to split, or whether to return both, only the customer knows. */
export function draftSplitByUse(input: SplitByUseDraftInput): CraftedProposalBody {
  const { tool, evidence } = input;
  const ways = evidence.uses.map(
    (u) =>
      `under "${u.intentText ?? u.intentId}" it is followed by ${u.follower} (${u.n} of ${u.na})`,
  );
  return {
    kind: "split_by_use",
    sourceToolIds: [tool.id, ...new Set(evidence.uses.map((u) => u.follower))],
    crafted: [],
    hidden: [],
    rationale: `${tool.id} is used ${evidence.uses.length} ways: ${ways.join("; ")}. Its output is read differently by each ask.`,
    details: `Each follower fetches or does something the ask needs next, every time. Either ${tool.id}'s response can carry what ${evidence.uses.map((u) => u.follower).join(" and ")} provide, or each ask wants its own variant of ${tool.id}.`,
    expectedEffect: `One call instead of two for the ${evidence.uses.reduce((sum, u) => sum + u.n, 0)} hops in this window, whichever way is chosen.`,
    migrationNotes: `Decide per use: return the follower's result inside ${tool.id} (one tool, richer response) or add ${evidence.uses.map((u) => `${tool.id}_for_${nameParts(u.follower)[0] ?? "use"}`).join(", ")} (one tool per use, each with the smaller response). Keep ${tool.id} until callers move.`,
  };
}

export interface GapDraftInput {
  /** The tools the ask reaches most; they are the proposal's sources. */
  tools: SourceTool[];
  evidence: GapEvidence;
}

/** No definition is drafted: the tool does not exist yet; the note says what it would answer and what it would replace. */
export function draftGap(input: GapDraftInput): CraftedProposalBody {
  const { tools, evidence } = input;
  const ask = evidence.intentText ? `"${evidence.intentText}"` : "this ask";
  return {
    kind: "fill_gap",
    sourceToolIds: tools.map((t) => t.id),
    crafted: [],
    hidden: [],
    rationale: `${ask} has no fixed path: ${evidence.units} turns reached ${evidence.distinctTools} different tools, ${evidence.callsPerUnit.toFixed(1)} calls per turn against ${evidence.projectCallsPerUnit.toFixed(1)} for the project, and no tool is followed by the same tool even 90% of the time. The agent improvises a path every time.`,
    details: `The tools it reaches most: ${evidence.topTools.map((t) => `${t.toolId} (${t.n} turns)`).join(", ")}. Nothing in the catalog answers the ask directly.`,
    expectedEffect: `A tool that answers ${ask} in one call would remove about ${Math.max(0, evidence.callsPerUnit - 1).toFixed(1)} calls and as many model round-trips per turn, over ${evidence.units} turns in this window.`,
    migrationNotes: `Add a tool, e.g. \`${evidence.suggestedName}\`, that returns what the agent assembles today from ${evidence.topTools.map((t) => t.toolId).join(", ")}. Keep those tools: other asks use them on their own.`,
  };
}

export interface RequireDraftInput {
  /** The predecessor. */
  a: SourceTool;
  /** The tool that fails without it. */
  b: SourceTool;
  evidence: RequireEvidence;
  catalogIds: ReadonlySet<string>;
}

/** The main tool accepting the predecessor's input, as a fold does, because the ledger shows it fails without that step. */
export function draftRequire(input: RequireDraftInput): CraftedProposalBody {
  const { a, b, evidence } = input;
  const merged = mergeSchemas([b, a]);
  merged.schema.required = requiredOf(b).map((name) => merged.mappings[b.id]?.[name] ?? name);
  if (merged.schema.required.length === 0) delete merged.schema.required;
  const aArgs = Object.keys(propertiesOf(a)).map((name) => merged.mappings[a.id]?.[name] ?? name);
  const name = freeName(
    `${nameParts(b.id).join("_")}_with_${nameParts(a.id)[0] ?? "lookup"}`,
    input.catalogIds,
  );
  const rateWith = evidence.withA.errors / Math.max(1, evidence.withA.calls);
  const rateWithout = evidence.withoutA.errors / Math.max(1, evidence.withoutA.calls);
  const crafted: CraftedToolDefinition = {
    name,
    description: `${firstSentence(b.description)}. Runs ${a.id} first when ${aArgs.length > 0 ? aArgs.map((x) => `\`${x}\``).join(" or ") : "its input"} is given, so the call cannot miss that step.`,
    searchableDescription: joinSearchable(searchableOf(b), searchableOf(a)),
    inputSchema: merged.schema,
    outputNotes: `Returns what ${b.id} returned.`,
    dispatch: [
      {
        sourceToolId: a.id,
        when: `${aArgs.length > 0 ? aArgs.join(" or ") : "its input"} given: run first`,
        argumentMapping: merged.mappings[a.id] ?? {},
        order: 0,
      },
      {
        sourceToolId: b.id,
        when: "always, with what the first step returned",
        argumentMapping: merged.mappings[b.id] ?? {},
        order: 1,
      },
    ],
  };
  const rec = evidence.recovery;
  return {
    kind: "require_prerequisite",
    sourceToolIds: [a.id, b.id],
    crafted: [crafted],
    hidden: [],
    rationale: rec
      ? `${b.id} failed and was retried ${rec.retried} times in this window; ${rec.via} of the ${rec.recovered} retries that worked came only after the agent called ${a.id} in between, so the call was missing what ${a.id} looks up${evidence.withA.calls > 0 ? ` (with ${a.id} earlier in the turn it fails ${pct(rateWith)} of the time, without it ${pct(rateWithout)})` : ""}.`
      : `${b.id} fails ${pct(rateWithout)} of the time when ${a.id} did not run earlier in the turn (${evidence.withoutA.errors} of ${evidence.withoutA.calls}) and ${pct(rateWith)} when it did (${evidence.withA.errors} of ${evidence.withA.calls}).`,
    details: rec
      ? `The agent reaches for ${a.id} only after ${b.id} has rejected the call, because nothing in ${b.id}'s definition says the value must come from there. Each such recovery is a failed call, a lookup and a retry where one call would do.`
      : `The dependency is real but nothing in ${b.id}'s definition says so, so the agent skips ${a.id} and the call fails.`,
    expectedEffect: rec
      ? `About ${rec.via} fewer failed calls in this window, each with its lookup, its retry and their model round-trips.`
      : `About ${Math.max(0, Math.round(evidence.withoutA.errors - rateWith * evidence.withoutA.calls))} fewer failed calls in this window, each with its retry and model round-trip.`,
    migrationNotes: `Either add ${name} (${b.id}'s handler, calling ${a.id} first when ${aArgs.join(" or ") || "its input"} is given), or state in ${b.id}'s description that it needs ${a.id}'s result.`,
  };
}
