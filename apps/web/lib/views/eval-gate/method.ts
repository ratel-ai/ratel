import type { FixKind } from "@/lib/views/fixes/kinds";
import type { FixChange, SimMethod } from "./types";

/**
 * How a kind of fix is simulated (RC-61), so a number is only ever produced
 * by a method that can tell "better" from "same":
 *
 * - `rerank`: the change moves search results. The run's own ask is ranked
 *   again with the search engine, before and after (deterministic, paired).
 * - `replay`: the change moves what the model does (a tool that fails clearly,
 *   a merged tool, a prerequisite, a skill). The run's recorded conversation is
 *   replayed by a model with and without the change. Without model replay these
 *   kinds can't be simulated: transforming the recorded calls only checks what
 *   the transform guarantees.
 * - `none`: nothing a stored run records can show the change.
 *
 * Pure, client-safe.
 */

const RERANK: ReadonlySet<FixKind> = new Set(["rewrite", "tell-apart", "retire", "fewer-results"]);
const REPLAY: ReadonlySet<FixKind> = new Set([
  "fail-clearly",
  "schema",
  "merge",
  "combine",
  "fold",
  "enrich",
  "parallel",
  "prerequisite",
  "skill",
]);

/** The method a kind asks for, before anything about a run or the deployment is known. */
export function methodForKind(kind: string): SimMethod {
  if (RERANK.has(kind as FixKind)) return "rerank";
  if (REPLAY.has(kind as FixKind)) return "replay";
  return "none";
}

/** Plain-words reasons a run can't be simulated. */
export const CANT_SIMULATE = {
  noModel: "Needs model replay: no model is configured",
  noPrompts: "Needs stored prompts: this run's model calls weren't captured",
  noDefinition: "No drafted tool definition to offer the model",
  budget: "The replay budget ran out before this run",
  dailyBudget: "Daily simulation budget reached",
  failed: "The model replay failed for this run",
  refused: "Needs model replay: the model key was refused",
  ungrounded:
    "Can't be replayed: the run's first tool call uses values its recorded conversation never shows the model",
  noCalls: "Replay failed: the model made no tool calls where the run made some",
  drifted: "Replay failed: without the fix, the model took another path than the run",
} as const;

/**
 * Whether the change gives a replay anything to apply; null when it does,
 * else the reason in words.
 */
export function replayGap(kind: string, change: FixChange): string | null {
  const replay = change.replay;
  if (!replay) return CANT_SIMULATE.noDefinition;
  const has =
    replay.tools.length > 0 ||
    replay.failClearly.length > 0 ||
    replay.prerequisite !== null ||
    replay.skill !== null;
  if (has) return null;
  return kind === "merge" ||
    kind === "combine" ||
    kind === "fold" ||
    kind === "enrich" ||
    kind === "parallel" ||
    kind === "schema"
    ? CANT_SIMULATE.noDefinition
    : "This fix names no change a model replay can apply";
}

/**
 * RC-77: why a fix has nothing to simulate, in words, or null when it has
 * something. A change the simulator can't apply (a rewrite with no drafted
 * text, a tool that doesn't exist yet), a kind no stored run can show, or a
 * replay kind with nothing for the model to use. Such a fix is never queued:
 * "Run simulation" is disabled with this reason and `run_eval` refuses.
 */
export function nothingToSimulate(kind: string, change: FixChange): string | null {
  if (change.unsupportedReason) return change.unsupportedReason;
  const method = methodForKind(kind);
  if (method === "none") return "Nothing a stored run records can show this kind of fix.";
  return method === "replay" ? replayGap(kind, change) : null;
}
