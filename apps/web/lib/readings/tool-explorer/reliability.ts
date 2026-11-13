import { nodeIdOf } from "@/lib/readings/tool-explorer/units";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * What the ledger says about a tool failing, counted per turn: how often a
 * tool's error was followed by the same tool again (a retry) and whether
 * that retry succeeded, and, for every tool that fails, how its error rate
 * differs when another tool ran earlier in the turn. The crafter reads both
 * (a retry that succeeds hints at a schema the agent gets wrong first time;
 * a tool that fails mostly without its usual predecessor hints at a hidden
 * prerequisite). Argument values are never stored. The error message is,
 * on the runtime event, and the compute hands it in by end-event id: each
 * retried error is classed (`classifyError`) so a validation failure counts
 * toward a schema fix and a not-found or server error does not, and when
 * the message names the argument (`argumentNamedIn`) the tool keeps it.
 */

export type ErrorClass = "validation" | "not_found" | "server" | "other";

/** What the runtime event behind an error step carried: its message. */
export interface ErrorInfo {
  message: string | null;
}

const VALIDATION =
  /\b(validat|invalid|must be|is required|required (?:field|argument|parameter)|unknown (?:field|argument|parameter|key)|unexpected (?:field|argument|key)|not (?:a |an )?(?:valid|allowed)|too (?:long|short)|at (?:most|least) \d|out of range|malformed|bad request|cannot be (?:empty|blank|null)|missing (?:required|field|argument|parameter)|enum|one of)/i;
const NOT_FOUND =
  /\b(not found|does not exist|no such|not accessible|not available|unknown (?:task|project|document|id|user|member)|404)\b/i;
const SERVER =
  /\b(internal server error|internal error|server error|timed? ?out|timeout|unavailable|rate limit|too many requests|econn|5\d\d|temporar|try again)\b/i;

/** The class of an error from its message; an absent or opaque message is `other`. */
export function classifyError(message: string | null | undefined): ErrorClass {
  if (!message) return "other";
  if (VALIDATION.test(message)) return "validation";
  if (NOT_FOUND.test(message)) return "not_found";
  if (SERVER.test(message)) return "server";
  return "other";
}

const NAMED = [
  /\binvalid\s+[`'"]?([A-Za-z_][A-Za-z0-9_]*)/i,
  /[`'"]?\b([A-Za-z_][A-Za-z0-9_]*)[`'"]?\s+(?:must be|is required|is invalid|is not|cannot be|should be|has to be|exceeds|too long|too short)/i,
  /\b(?:unknown|unexpected|missing|required)\s+(?:field|argument|parameter|key|property)\s+[`'"]?([A-Za-z_][A-Za-z0-9_]*)/i,
  /\b(?:field|argument|parameter|property)\s+[`'"]?([A-Za-z_][A-Za-z0-9_]*)[`'"]?\s+(?:must|is|cannot|should|has)/i,
];
const NOT_ARGUMENTS = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "it",
  "value",
  "request",
  "input",
  "body",
  "payload",
  "error",
  "validation",
  "task",
  "project",
  "document",
]);
const MAX_ARGUMENT = 64;

/** The argument an error message names, when it names one in a way the patterns read; null otherwise. */
export function argumentNamedIn(message: string | null | undefined): string | null {
  if (!message) return null;
  for (const pattern of NAMED) {
    const m = pattern.exec(message);
    const name = m?.[1];
    if (name && name.length <= MAX_ARGUMENT && !NOT_ARGUMENTS.has(name.toLowerCase())) return name;
  }
  return null;
}

export interface ToolReliability {
  toolId: string;
  calls: number;
  errorCalls: number;
  /** Errors followed by a call of the same tool later in the turn. */
  retriedErrors: number;
  /** Of those, retries whose next call of the tool succeeded. */
  recoveredRetries: number;
  /** Retried errors by the class of their message; absent on runs stored before messages were read. */
  retriedByClass?: Record<ErrorClass, number>;
  /** Recovered retries by the class of the error they followed. */
  recoveredByClass?: Record<ErrorClass, number>;
  /** Arguments the retried errors' messages named, commonest first, at most three. */
  namedArguments?: string[];
  /** Recovered retries where the agent called the tool again with nothing else in between: it fixed the arguments by itself. */
  recoveredDirect?: number;
  /** Of those, retries whose error message named an argument: the one case a schema fix is known to address. */
  namedRecovered?: number;
  /** Recovered retries where the agent called another tool in between, by that tool: a lookup it needed first. At most five. */
  recoveredVia?: { tool: string; n: number }[];
}

/** Tool b's calls split by whether tool a had run earlier in the same turn. */
export interface PrerequisiteReliability {
  a: string;
  b: string;
  withA: { calls: number; errors: number };
  withoutA: { calls: number; errors: number };
}

export interface StoredReliability {
  tools: ToolReliability[];
  /** Pairs for tools with errors only, biggest `withA` first. */
  prerequisites: PrerequisiteReliability[];
}

/** Pairs stored at most; the rest are the long tail of rarely co-called tools. */
export const MAX_PREREQUISITE_ROWS = 200;

interface PairCount {
  withCalls: number;
  withErrors: number;
}

export interface ReliabilityStats {
  tools: Map<string, ToolReliability>;
  /** Per tool, how often each named argument appeared in a retried error. */
  named: Map<string, Map<string, number>>;
  /** Per tool, how often each other tool sat between a failed call and the retry that worked. */
  via: Map<string, Map<string, number>>;
  /** Keyed `a|b`: b's calls that had a earlier in the turn. */
  pairs: Map<string, PairCount>;
}

export function createReliabilityStats(): ReliabilityStats {
  return { tools: new Map(), named: new Map(), via: new Map(), pairs: new Map() };
}

function toolOf(stats: ReliabilityStats, id: string): ToolReliability {
  let t = stats.tools.get(id);
  if (!t) {
    t = {
      toolId: id,
      calls: 0,
      errorCalls: 0,
      retriedErrors: 0,
      recoveredRetries: 0,
      retriedByClass: emptyClasses(),
      recoveredByClass: emptyClasses(),
      recoveredDirect: 0,
      namedRecovered: 0,
    };
    stats.tools.set(id, t);
  }
  return t;
}

const emptyClasses = (): Record<ErrorClass, number> => ({
  validation: 0,
  not_found: 0,
  server: 0,
  other: 0,
});
const bump = (map: Map<string, Map<string, number>>, tool: string, key: string): void => {
  let counts = map.get(tool);
  if (!counts) {
    counts = new Map();
    map.set(tool, counts);
  }
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

/**
 * Count one turn. `errors` maps an error step's end event id to what its
 * runtime event carried; absent, every error is `other`. A retried error is
 * one followed by a call of the same tool later in the turn; it recovered
 * when that call succeeded, and the calls in between are its recovery path.
 */
export function countTurnReliability(
  stats: ReliabilityStats,
  turn: Pick<SignalTurn, "steps">,
  errors?: ReadonlyMap<string, ErrorInfo>,
): void {
  const calls: { id: string; error: boolean; info: ErrorInfo | null }[] = [];
  for (const step of turn.steps) {
    if (step.kind === "search") continue;
    const id = nodeIdOf(step);
    if (id === null) continue;
    const error = step.outcome === "error";
    const info = error && step.endTraceEventId ? (errors?.get(step.endTraceEventId) ?? null) : null;
    calls.push({ id, error, info });
  }
  const before = new Set<string>();
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]!;
    const tool = toolOf(stats, call.id);
    tool.calls += 1;
    if (call.error) {
      tool.errorCalls += 1;
      const j = calls.findIndex((c, k) => k > i && c.id === call.id);
      if (j !== -1) {
        const next = calls[j]!;
        tool.retriedErrors += 1;
        const cls = classifyError(call.info?.message);
        tool.retriedByClass![cls] += 1;
        const named = cls === "validation" ? argumentNamedIn(call.info?.message) : null;
        if (named) bump(stats.named, call.id, named);
        if (!next.error) {
          tool.recoveredRetries += 1;
          tool.recoveredByClass![cls] += 1;
          if (cls === "validation" || cls === "other") {
            const between = [
              ...new Set(
                calls
                  .slice(i + 1, j)
                  .map((c) => c.id)
                  .filter((id) => id !== call.id),
              ),
            ];
            if (between.length === 0) {
              tool.recoveredDirect! += 1;
              if (named) tool.namedRecovered! += 1;
            } else {
              for (const via of between) bump(stats.via, call.id, via);
            }
          }
        }
      }
    }
    for (const a of before) {
      if (a === call.id) continue;
      const key = `${a}|${call.id}`;
      let pair = stats.pairs.get(key);
      if (!pair) {
        pair = { withCalls: 0, withErrors: 0 };
        stats.pairs.set(key, pair);
      }
      pair.withCalls += 1;
      if (call.error) pair.withErrors += 1;
    }
    before.add(call.id);
  }
}

const MAX_NAMED_ARGUMENTS = 3;
const MAX_VIA_TOOLS = 5;
const ranked = (counts: Map<string, number> | undefined): [string, number][] =>
  [...(counts ?? new Map<string, number>())].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));

export function finishReliability(stats: ReliabilityStats): StoredReliability {
  const tools = [...stats.tools.values()]
    .map((t) => ({
      ...t,
      namedArguments: ranked(stats.named.get(t.toolId))
        .slice(0, MAX_NAMED_ARGUMENTS)
        .map(([name]) => name),
      recoveredVia: ranked(stats.via.get(t.toolId))
        .slice(0, MAX_VIA_TOOLS)
        .map(([tool, n]) => ({ tool, n })),
    }))
    .sort(
      (x, y) => y.errorCalls - x.errorCalls || y.calls - x.calls || (x.toolId < y.toolId ? -1 : 1),
    );
  const prerequisites: PrerequisiteReliability[] = [];
  for (const [key, pair] of stats.pairs) {
    const [a, b] = key.split("|") as [string, string];
    const tool = stats.tools.get(b);
    if (!tool || tool.errorCalls === 0) continue;
    prerequisites.push({
      a,
      b,
      withA: { calls: pair.withCalls, errors: pair.withErrors },
      withoutA: { calls: tool.calls - pair.withCalls, errors: tool.errorCalls - pair.withErrors },
    });
  }
  prerequisites.sort(
    (x, y) =>
      y.withA.calls - x.withA.calls || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1),
  );
  return { tools, prerequisites: prerequisites.slice(0, MAX_PREREQUISITE_ROWS) };
}
