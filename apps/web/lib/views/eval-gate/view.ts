import { evalPageHref } from "@/lib/views/lineage/refs";
import type { EvalBadge, SimMethod, Tally, Verdict } from "./types";

/**
 * How the gate reads on screen: the eval page's address, the badge's words
 * and tone. Pure, client-safe.
 */

/** The eval page of one fix (the lineage module owns the address). */
export function evalHref(projectId: string, fixId: string): string {
  return evalPageHref(projectId, fixId);
}

/** A fix id from the page's path segment, which may arrive encoded once. */
export function fixIdFromSegment(segment: string): string {
  try {
    return segment.includes("%") ? decodeURIComponent(segment) : segment;
  } catch {
    return segment;
  }
}

/** "Simulated on 24 historical runs". */
export function simulatedLabel(runs: number): string {
  return `Simulated on ${runs} historical ${runs === 1 ? "run" : "runs"}`;
}

/** A pass rate as a whole percentage: "62%"; a dash when nothing was measured. */
export function percent(rate: number | null): string {
  return rate === null ? "–" : `${Math.round(rate * 100)}%`;
}

/** "62% → 88%". */
export function passLine(before: Tally, after: Tally): string {
  return `${percent(before.passRate)} → ${percent(after.passRate)}`;
}

export const VERDICT_WORDS: Record<
  Verdict,
  { label: string; tone: "success" | "neutral" | "danger" | "warning" }
> = {
  better: { label: "Better", tone: "success" },
  same: { label: "No clear change", tone: "neutral" },
  worse: { label: "Worse", tone: "danger" },
  "too-few": { label: "Too few runs to tell", tone: "warning" },
  unsupported: { label: "Can't simulate yet", tone: "neutral" },
  unreliable: { label: "Replay unreliable", tone: "warning" },
};

/** How a simulation read its runs, in a word or two, for the badge (RC-61). */
export const METHOD_WORDS: Record<SimMethod | "mixed", string> = {
  rerank: "re-ranked",
  replay: "model replay",
  mixed: "re-ranked and replayed",
  none: "can't simulate",
};

/** What the eval page knows about how its fix is and was simulated. */
export interface HowItRanInput {
  /** How this kind of fix is simulated (`methodForKind`, or `none` when the change can't be): known before any run. */
  planned: SimMethod;
  /** The latest completed simulation; null before the first. */
  latest: {
    method: SimMethod | "mixed" | null;
    verdict: Verdict | null;
    fidelity: { matched: number; total: number } | null;
    judge: string | null;
  } | null;
  /** `MIN_REPLAY_FIDELITY`, passed in so this stays free of the scorer. */
  minFidelity: number;
}

const RERANK_WORDS =
  "Each run's own ask is ranked again with the fix applied, on both sides with the same search engine. No tool or live agent is called.";
const REPLAY_WORDS =
  "Each run's recorded conversation is replayed by a model twice, as it was and with the fix. Tool calls are answered from the recording, or by a stand-in where the recording has no answer. Nothing runs against your live agent or tools.";
const NEEDS_REPLAY_WORDS =
  "This kind of fix changes what the model does, so it needs model replay. Until a run can be replayed it reads “Can't simulate”, never a number.";

/**
 * How the runs are simulated, in a few sentences (RC-61). RC-77: named from
 * the fix's kind before any run, so a merge never reads as a re-rank; after a
 * run, from the method the run used, else still from the kind.
 */
export function howItRan({ planned, latest, minFidelity }: HowItRanInput): string {
  const ran = latest?.method ?? null;
  const method = ran === "replay" || ran === "mixed" || ran === "rerank" ? ran : planned;
  const parts: string[] = [];
  const fidelity = latest?.fidelity && latest.fidelity.total > 0 ? latest.fidelity : null;
  if (method === "replay" || method === "mixed") {
    // Before the first run the kind says replay; after one that replayed nothing, say why there's no number.
    parts.push(!latest || ran === "replay" || ran === "mixed" ? REPLAY_WORDS : NEEDS_REPLAY_WORDS);
    if (fidelity)
      parts.push(
        `Without the fix, the replay took the recorded path in ${fidelity.matched} of ${fidelity.total} runs.`,
      );
  } else if (method === "rerank") {
    parts.push(RERANK_WORDS);
  } else {
    parts.push(
      "Nothing a stored run records can show this kind of fix, so it reads “Can't simulate”, never a number.",
    );
  }
  if (latest?.verdict === "unreliable") {
    const why =
      "Usually the recorded conversations don't hold what the agent acted on (an id or a reference from outside the prompt).";
    parts.push(
      fidelity
        ? `That is under ${Math.round(minFidelity * 100)}%, so the replay isn't re-enacting your runs and gives no verdict. ${why}`
        : `The replay isn't re-enacting your runs, so it gives no verdict. ${why}`,
    );
  }
  if (latest?.judge) parts.push(`${latest.judge}.`);
  return parts.join(" ");
}

/** The badge in words, for a tooltip or a screen reader. */
export function badgeSentence(badge: EvalBadge): string {
  switch (badge.state) {
    case "none":
      return "Not simulated yet";
    case "pending":
      return "Simulating…";
    case "failed":
      return "The last simulation failed";
    case "done": {
      if (badge.verdict === "unsupported" || badge.verdict === "unreliable")
        return VERDICT_WORDS[badge.verdict].label;
      const how = badge.method && badge.method !== "none" ? ` (${METHOD_WORDS[badge.method]})` : "";
      const words = `${VERDICT_WORDS[badge.verdict].label}: passes ${passLine(badge.before, badge.after)}. ${simulatedLabel(badge.runs)}${how}.`;
      return badge.stale ? `${words} The runs changed since.` : words;
    }
  }
}
