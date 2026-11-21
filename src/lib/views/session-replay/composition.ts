import type { CategorySplits, ToolsByName } from "@/lib/ingest/categorize";
import type { ContextSource } from "@/lib/ingest/context";

/**
 * The context lens (RC-144): what one model call's input held, in parts that
 * sum to its `input_tokens`. It reads the stored `event_metrics` split
 * (`lib/categorize.ts`, unchanged) and refines two of its buckets when the
 * payload's sizes are known (`PayloadShape`, measured in SQL, never text):
 * the base system prompt out of `skills`, and tool results out of `history`.
 * Without the sizes those two stay inside their bucket, and `gaps` says so.
 * The context-window size is not known, so no part is "free space".
 */

export const LENS_PARTS = [
  "system",
  "skills",
  "memory",
  "tools_used",
  "tools_unused",
  "history",
  "tool_results",
  "user_input",
] as const;
export type LensPart = (typeof LENS_PARTS)[number];
export type CompositionGap = "system_in_skills" | "tool_results_in_history";

/** Character counts of a payload, measured in the database. */
export interface PayloadShape {
  /** The system prompt minus the skill and memory blocks found in it. */
  systemBaseChars: number;
  /** The skill blocks in the system prompt. */
  skillChars: number;
  /** Tool-role messages. */
  toolResultChars: number;
  /** Every message (history and the current user input). */
  messageChars: number;
}

export interface CallMetrics {
  eventId: string;
  inputTokens: number | null;
  tokensByCategory: Record<ContextSource, number>;
  splits: CategorySplits;
  toolsByName: ToolsByName;
  shape: PayloadShape | null;
}

export interface LoadedTool {
  name: string;
  tokens: number;
  calls: number;
}

export interface Composition {
  eventId: string;
  inputTokens: number;
  parts: Record<LensPart, number>;
  /** Tools whose definitions the call carried, largest first. */
  loadedTools: LoadedTool[];
  gaps: CompositionGap[];
}

export interface LensMarkers {
  /** The model call (event id) where bloat starts, or null. */
  bloatStart: string | null;
  /** Per model call: tools it loaded that the session never used. */
  unusedTools: Record<string, string[]>;
}

const SOURCE_ORDER: ContextSource[] = ["skills", "tools", "history", "memory", "user_input"];
const BLOAT_GROWTH = 2;
const BLOAT_SHARE = 0.5;

export function composition(call: CallMetrics): Composition {
  const stored = SOURCE_ORDER.map((source) => Math.max(0, call.tokensByCategory[source] ?? 0));
  const storedTotal = stored.reduce((a, b) => a + b, 0);
  const total = call.inputTokens ?? storedTotal;
  const scaled = storedTotal === total ? stored : allocate(stored, total);
  const bucket = Object.fromEntries(
    SOURCE_ORDER.map((source, i) => [source, scaled[i]!]),
  ) as Record<ContextSource, number>;
  const [toolsUsed, toolsUnused] = allocate(
    [call.splits.tools_used, call.splits.tools_unused],
    bucket.tools,
  );
  const gaps: CompositionGap[] = [];
  const shape = call.shape;

  let system = 0;
  let skills = bucket.skills;
  const promptChars = shape ? shape.systemBaseChars + shape.skillChars : 0;
  if (shape && promptChars > 0) {
    system = Math.round((bucket.skills * shape.systemBaseChars) / promptChars);
    skills = bucket.skills - system;
  } else if (bucket.skills > 0) gaps.push("system_in_skills");

  let toolResults = 0;
  let history = bucket.history;
  if (shape && shape.messageChars > 0) {
    toolResults = Math.min(
      bucket.history,
      Math.round(
        (shape.toolResultChars / shape.messageChars) * (bucket.history + bucket.user_input),
      ),
    );
    history = bucket.history - toolResults;
  } else if (bucket.history > 0) gaps.push("tool_results_in_history");

  const loadedTools = Object.entries(call.toolsByName)
    .filter(([, stat]) => stat.tokens > 0)
    .map(([name, stat]) => ({ name, tokens: stat.tokens, calls: stat.calls }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

  return {
    eventId: call.eventId,
    inputTokens: total,
    parts: {
      system,
      skills,
      memory: bucket.memory,
      tools_used: toolsUsed ?? 0,
      tools_unused: toolsUnused ?? 0,
      history,
      tool_results: toolResults,
      user_input: bucket.user_input,
    },
    loadedTools,
    gaps,
  };
}

/**
 * The lens markers over a session's model calls, oldest first. Bloat starts at
 * the first call where history plus tool results are more than half the
 * input, once the input has doubled since the first call. `usedTools` holds
 * every tool the session ran (model tool calls and ledger invocations).
 */
export function lensMarkers(
  calls: readonly Composition[],
  usedTools: ReadonlySet<string>,
): LensMarkers {
  const first = calls[0]?.inputTokens ?? 0;
  const bloat = calls.find(
    (call) =>
      first > 0 &&
      call.inputTokens >= BLOAT_GROWTH * first &&
      call.parts.history + call.parts.tool_results > BLOAT_SHARE * call.inputTokens,
  );
  const unusedTools = Object.fromEntries(
    calls.map((call) => [
      call.eventId,
      call.loadedTools
        .filter((tool) => tool.calls === 0 && !usedTools.has(tool.name))
        .map((tool) => tool.name),
    ]),
  );
  return { bloatStart: bloat?.eventId ?? null, unusedTools };
}

/** Split `total` across `weights` by largest remainder, so the parts sum to it exactly. */
function allocate(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / sum) * total);
  const out = raw.map(Math.floor);
  let remainder = total - out.reduce((a, b) => a + b, 0);
  const byFraction = raw
    .map((r, i) => ({ i, fraction: r - Math.floor(r) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let k = 0; remainder > 0 && k < byFraction.length; k++, remainder--)
    out[byFraction[k]!.i]! += 1;
  return out;
}
