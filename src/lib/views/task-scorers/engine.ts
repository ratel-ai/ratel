import { hitCredit } from "@/lib/synthesis/quality/metrics";
import { formatSeconds, formatUsd } from "@/lib/views/task-scorers/format";
import { endsWellOf, selfCorrectionsOf } from "@/lib/views/task-scorers/outcome";
import type { Scorer, ScorerKind, ScorerResult, ScorerRun } from "@/lib/views/task-scorers/types";

/** Increase this version when scorer definitions or measurement rules change. */
export const SCORER_VERSION = 1;

/** Score each supplied scorer in order. Unknown measurements produce a skip result. */
export function scoreRun(run: ScorerRun, scorers: readonly Scorer[]): ScorerResult[] {
  return scorers.map((scorer) => scoreOne(run, scorer));
}

function scoreOne(run: ScorerRun, scorer: Scorer): ScorerResult {
  const kind = scorer.kind;
  switch (scorer.kind) {
    case "judge_criteria":
      return run.criteriaPass == null
        ? skip(kind)
        : result(kind, run.criteriaPass, "task criteria");
    case "ends_well": {
      const ends = endsWellOf(run);
      return ends === null ? skip(kind) : result(kind, ends, ends ? "ends well" : "ends badly");
    }
    case "max_self_corrections": {
      const corrections = selfCorrectionsOf(run);
      return corrections === null
        ? skip(kind)
        : result(
            kind,
            corrections <= scorer.max,
            plural(corrections, "self-correction", "self-corrections"),
          );
    }
    case "max_latency_ms": {
      const latency = run.latencyMs;
      return latency == null
        ? skip(kind)
        : result(kind, latency <= scorer.max, formatSeconds(latency));
    }
    case "max_cost_usd": {
      const cost = run.costUsd;
      return cost == null ? skip(kind) : result(kind, cost <= scorer.max, formatUsd(cost));
    }
    case "expected_tool": {
      if (run.listKnown === false) return skip(kind);
      const index = run.firstList ? run.firstList.indexOf(scorer.tool) : -1;
      const rank = index === -1 ? null : index + 1;
      return {
        ...result(
          kind,
          rank !== null,
          rank === null ? (run.firstList ? "not in the list" : "no search") : `rank ${rank}`,
          hitCredit(rank),
        ),
        rank,
      };
    }
    case "max_tool_calls":
      return run.calls === null
        ? skip(kind)
        : result(kind, run.calls.length <= scorer.max, plural(run.calls.length, "call", "calls"));
  }
}

function skip(kind: ScorerKind): ScorerResult {
  return { kind, status: "skip", score: 0, detail: "not measured" };
}

function result(
  kind: ScorerKind,
  pass: boolean,
  detail: string,
  score = pass ? 1 : 0,
): ScorerResult {
  return { kind, status: pass ? "pass" : "fail", score, detail };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
