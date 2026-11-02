import { formatDuration } from "@/lib/readings/tool-explorer/view";
import type { CraftBacktest } from "@/lib/synthesis/tool-crafter/backtest";
import { switchesByMode } from "@/lib/synthesis/tool-crafter/export";
import type { ToolCraftProposalRow } from "@/lib/synthesis/tool-crafter/schema";
import type {
  CraftEvidence,
  CraftedToolDefinition,
  CraftKind,
  CraftStatus,
  SourceTool,
} from "@/lib/synthesis/tool-crafter/types";

/**
 * Pure view helpers for the Craft tab: a proposal row as the card reads it,
 * the diff between a source and its crafted replacement, and the run's
 * headline. No database, no React.
 */

export interface CraftCardModel {
  id: string;
  kind: CraftKind;
  status: CraftStatus;
  sources: SourceTool[];
  crafted: CraftedToolDefinition[];
  hidden: string[];
  rationale: string;
  details: string;
  expectedEffect: string;
  migrationNotes: string;
  evidence: CraftEvidence | null;
  backtest: CraftBacktest | null;
  createdAt: Date;
}

export function cardModel(row: ToolCraftProposalRow): CraftCardModel {
  const crafted = row.crafted as unknown as CraftedToolDefinition[];
  return {
    id: row.id,
    kind: row.kind as CraftKind,
    status: row.status as CraftStatus,
    sources: row.sourceDefinitions as unknown as SourceTool[],
    crafted,
    hidden: row.hiddenToolIds,
    rationale: row.rationale,
    details: row.details,
    expectedEffect: row.expectedEffect,
    migrationNotes: row.migrationNotes,
    evidence: (row.evidence as unknown as CraftEvidence | null) ?? null,
    backtest: (row.backtest as unknown as CraftBacktest | null) ?? null,
    createdAt: row.createdAt,
  };
}

export interface BacktestReadout {
  /** "Found 38 of 40 → 39 of 40 on the 40 searches this touches (of 523)". */
  headline: string;
  /** Mean hit-credit change on the affected searches, as a signed percent, with its interval. */
  delta: string | null;
  caveats: string[];
  /** "better" | "worse" | "same", by whether the interval clears zero. */
  verdict: "better" | "worse" | "same";
}

export function backtestReadout(backtest: CraftBacktest): BacktestReadout {
  const pct = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n * 100)}%`;
  const interval = backtest.delta.interval;
  const verdict = !interval
    ? "same"
    : interval.low > 0
      ? "better"
      : interval.high < 0
        ? "worse"
        : "same";
  return {
    headline: `Found ${backtest.before.contained} of ${backtest.n} → ${backtest.after.contained} of ${backtest.n}; ${backtest.affectedN} of the ${backtest.n} stored searches ${backtest.affectedN === 1 ? "is" : "are"} ones this proposal touches.`,
    delta:
      backtest.delta.quality === null
        ? null
        : `${pct(backtest.delta.quality)} hit credit on those${interval ? ` (${pct(interval.low)} to ${pct(interval.high)})` : ""}`,
    caveats: backtest.caveats,
    verdict,
  };
}

export interface EvidenceFact {
  label: string;
  value: string;
}

/**
 * The numbers behind a proposal, as label/value pairs for a chip row; empty
 * for kinds without them. For a pair the per-request times live in
 * `requestTime`, so the tiles carry only what that line does not.
 */
export function evidenceFacts(evidence: CraftEvidence | null): EvidenceFact[] {
  if (!evidence || typeof evidence !== "object") return [];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (evidence.kind === "merge_tools" || evidence.kind === "fold_prerequisite") {
    const e = evidence.kind === "merge_tools" ? evidence.merge : evidence.fold;
    if (!e) return [];
    const facts: EvidenceFact[] = [
      {
        label: "run together",
        value: evidence.kind === "merge_tools" ? pct(evidence.merge.jaccard) : pct(e.pAb),
      },
      { label: "times", value: `${e.support}` },
    ];
    const t = e.timing;
    if (t && t.handoffPairs > 0) {
      facts.push({
        label: "waited in total",
        value: formatDuration(t.handoffMsTotal),
      });
      if (t.searchesBetween > 0)
        facts.push({
          label: "extra searches",
          value: String(t.searchesBetween),
        });
    }
    return facts;
  }
  if (evidence.kind === "rewrite_tool") {
    if (!evidence.rewrite) return [];
    return [
      { label: "missed", value: String(evidence.rewrite.missedQueries.length) },
      { label: "buried", value: String(evidence.rewrite.buriedQueries.length) },
      ...(evidence.rewrite.distractors[0]
        ? [
            {
              label: "outranked by",
              value: evidence.rewrite.distractors.slice(0, 2).join(", "),
            },
          ]
        : []),
    ];
  }
  if (evidence.kind === "compose_chain") {
    const c = evidence.compose;
    if (!c) return [];
    return [
      { label: "steps", value: String(c.order.length) },
      { label: "runs", value: String(c.runs) },
      { label: "in this order", value: pct(c.orderStability) },
      ...(c.medianMs !== null ? [{ label: "per run", value: formatDuration(c.medianMs) }] : []),
      ...(c.medianModelCalls !== null
        ? [{ label: "model calls per run", value: String(c.medianModelCalls) }]
        : []),
    ];
  }
  if (evidence.kind === "parallel_pair") {
    const p = evidence.parallel;
    if (!p) return [];
    const ordered = Math.max(1, p.orderAb + p.orderBa);
    return [
      { label: "run together", value: pct(p.jaccard) },
      { label: "times", value: String(p.support) },
      { label: "either order", value: `${pct(p.orderAb / ordered)} / ${pct(p.orderBa / ordered)}` },
    ];
  }
  if (evidence.kind === "tighten_schema") {
    const t = evidence.tighten;
    if (!t) return [];
    return [
      { label: "failed", value: `${t.errorCalls} of ${t.calls}` },
      { label: "retried", value: String(t.retriedErrors) },
      { label: "retry succeeded", value: String(t.recoveredRetries) },
      ...(t.namedRecovered !== undefined
        ? [{ label: "named and retried straight", value: String(t.namedRecovered) }]
        : []),
      ...(t.directRecovered !== undefined && t.directRecovered > (t.namedRecovered ?? 0)
        ? [
            {
              label: "bare error, retried straight",
              value: String(t.directRecovered - (t.namedRecovered ?? 0)),
            },
          ]
        : []),
      ...(t.viaLookup && t.viaLookup.length > 0
        ? [
            {
              label: "recovered after a lookup",
              value: t.viaLookup.map((v) => `${v.tool} ×${v.n}`).join(", "),
            },
          ]
        : []),
      ...(t.excludedRetried
        ? [{ label: "not counted", value: `${t.excludedRetried} not-found or server` }]
        : []),
      ...(t.namedArguments && t.namedArguments.length > 0
        ? [{ label: "named by the errors", value: t.namedArguments.join(", ") }]
        : []),
      ...(t.undocumentedArgs.length > 0
        ? [{ label: "undocumented", value: t.undocumentedArgs.join(", ") }]
        : []),
      ...(t.freeTextArgs.length > 0
        ? [{ label: "free text", value: t.freeTextArgs.join(", ") }]
        : []),
    ];
  }
  if (evidence.kind === "enrich_response") {
    const en = evidence.enrich;
    if (!en) return [];
    return [
      { label: "followed", value: `${en.n} of ${en.na}` },
      { label: "ask", value: en.intentText ?? en.intentId },
      { label: "turns", value: String(en.units) },
      ...(en.bMedianMs !== null
        ? [{ label: "second call", value: formatDuration(en.bMedianMs) }]
        : []),
      {
        label: "elsewhere",
        value: `${en.bUnitsOutside} ${en.bUnitsOutside === 1 ? "turn" : "turns"}`,
      },
    ];
  }
  if (evidence.kind === "preload_context") {
    const pre = evidence.preload;
    if (!pre) return [];
    return [
      { label: "opens with it", value: `${pre.firstN} of ${pre.units}` },
      { label: "ask", value: pre.intentText ?? pre.intentId },
      ...(pre.medianMs !== null
        ? [{ label: "the call", value: formatDuration(pre.medianMs) }]
        : []),
    ];
  }
  if (evidence.kind === "split_by_use") {
    const su = evidence.splitByUse;
    if (!su) return [];
    return su.uses.map((u) => ({
      label: `under “${u.intentText ?? u.intentId}”`,
      value: `${u.follower} next, ${u.n} of ${u.na}`,
    }));
  }
  if (evidence.kind === "fill_gap") {
    const g = evidence.gap;
    if (!g) return [];
    return [
      { label: "ask", value: g.intentText ?? g.intentId },
      { label: "turns", value: String(g.units) },
      { label: "tools reached", value: String(g.distinctTools) },
      {
        label: "calls per turn",
        value: `${g.callsPerUnit.toFixed(1)} vs ${g.projectCallsPerUnit.toFixed(1)}`,
      },
      { label: "sure hops", value: "none" },
    ];
  }
  if (evidence.kind === "require_prerequisite") {
    const r = evidence.require;
    if (!r) return [];
    return [
      ...(r.recovery
        ? [
            {
              label: "recovered after the lookup",
              value: `${r.recovery.via} of ${r.recovery.recovered} recoveries`,
            },
          ]
        : []),
      ...(r.withoutA.calls > 0
        ? [
            {
              label: "fails without it",
              value: `${pct(r.withoutA.errors / Math.max(1, r.withoutA.calls))} (${r.withoutA.errors} of ${r.withoutA.calls})`,
            },
          ]
        : []),
      ...(r.withA.calls > 0
        ? [
            {
              label: "fails with it",
              value: `${pct(r.withA.errors / Math.max(1, r.withA.calls))} (${r.withA.errors} of ${r.withA.calls})`,
            },
          ]
        : []),
    ];
  }
  if (evidence.kind !== "deprecate_tool" || !evidence.deprecate) return [];
  return [
    { label: "calls in window", value: String(evidence.deprecate.calls) },
    { label: "window", value: `${evidence.deprecate.windowDays} days` },
    ...(evidence.deprecate.replacement
      ? [
          {
            label: "look-alike",
            value: `${evidence.deprecate.replacement} (${evidence.deprecate.replacementCalls} calls)`,
          },
        ]
      : []),
  ];
}

export interface RequestTime {
  /** A typical request today: first tool, the wait, second tool. */
  beforeMs: number;
  /** The same request after the change: both tools, no wait. */
  afterMs: number;
  /** Share of the request removed, 0..1. */
  saved: number;
}

/** A merge whose drafted tool runs one source per call, chosen by `mode`: it consolidates the catalog but saves no call. */
export function isModeSwitch(card: Pick<CraftCardModel, "kind" | "crafted">): boolean {
  return (
    card.kind === "merge_tools" && card.crafted.length > 0 && card.crafted.every(switchesByMode)
  );
}

/**
 * What one request costs before and after a merge or fold, from the medians:
 * the tools' own run time stays, the hand-off between them goes. Null when
 * the pair carries no timing, or when a mode switch keeps both calls.
 */
export function requestTime(card: CraftCardModel): RequestTime | null {
  if (isModeSwitch(card)) return null;
  const e = card.evidence;
  const t =
    e?.kind === "merge_tools"
      ? e.merge?.timing
      : e?.kind === "fold_prerequisite"
        ? e.fold?.timing
        : undefined;
  if (!t || t.handoffPairs === 0 || t.handoffMsMedian === null) return null;
  const tools = (t.aMedianMs ?? 0) + (t.bMedianMs ?? 0);
  const beforeMs = tools + t.handoffMsMedian;
  if (beforeMs <= 0) return null;
  return { beforeMs, afterMs: tools, saved: t.handoffMsMedian / beforeMs };
}

export interface CardSummary {
  /** 1. What is suggested, one line. */
  suggestion: string;
  /** 2. Why, as up to three short facts (the measured ones first). */
  why: string[];
  /** 3. What we propose, one line; the definition panel carries the rest. */
  proposal: string;
  /** 4. What to expect after applying it, one line with the numbers. */
  effect: string;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** The four lines a reviewer needs, in plain words, from the proposal and its evidence. */
export function cardSummary(
  card: CraftCardModel,
  name: (id: string) => string = (id) => id,
): CardSummary {
  const [a, b] = card.sources.map((s) => name(s.id));
  const crafted = card.crafted.map((c) => c.name);
  const e = card.evidence;
  switch (card.kind) {
    case "merge_tools": {
      const m = e?.kind === "merge_tools" ? e.merge : null;
      const t = m?.timing;
      const why: string[] = [];
      if (m?.intent)
        why.push(
          `${a} and ${b} ran together in ${pct(m.intent.runs / Math.max(1, m.intent.turns))} of the intent's ${m.intent.turns} turns (${m.support} times), ${a} first in ${pct(m.nextP ?? 0)} of them.`,
        );
      else if (m)
        why.push(
          `${a} and ${b} ran together in ${pct(m.jaccard)} of the ${m.scope === "turn" ? "turns" : "sessions"} that used either (${m.support} times).`,
        );
      if (t && (t.aMedianMs !== null || t.bMedianMs !== null))
        why.push(
          `${a} takes ${formatDuration(t.aMedianMs)} per call, ${b} ${formatDuration(t.bMedianMs)}.`,
        );
      if (t && t.handoffPairs > 0)
        why.push(
          `Between them the agent waited ${formatDuration(t.handoffMsTotal)} in total (${formatDuration(t.handoffMsMedian)} per request${t.searchesBetween > 0 ? `, ${t.searchesBetween} extra searches` : ""}).`,
        );
      if (isModeSwitch(card))
        return {
          suggestion: `Merge ${a} and ${b} into one tool.`,
          why,
          proposal: `One tool, ${crafted[0] ?? "merged"}, that runs ${a} or ${b} as its \`mode\` says; ${a} and ${b} retire once it is adopted.`,
          effect:
            "One entry in the tool list instead of two. Each operation is still its own call, so calls and waiting stay the same.",
        };
      return {
        suggestion: `Merge ${a} and ${b} into one tool.`,
        why,
        proposal: `One tool, ${crafted[0] ?? "merged"}, that does both in one call; ${a} and ${b} retire once it is adopted.`,
        effect:
          t && t.handoffPairs > 0
            ? `About ${formatDuration(t.handoffMsTotal)} less waiting over this window; one search and one call instead of two.`
            : "One search and one call instead of two; the second step can no longer be skipped or mis-ordered.",
      };
    }
    case "fold_prerequisite": {
      const f = e?.kind === "fold_prerequisite" ? e.fold : null;
      const t = f?.timing;
      const why: string[] = [];
      if (f)
        why.push(
          `${pct(f.pAb)} of ${a}'s calls were followed by ${b}; ${b} runs without it ${pct(1 - f.pBa)} of the time.`,
        );
      if (t && t.handoffPairs > 0)
        why.push(
          `Between them the agent waited ${formatDuration(t.handoffMsTotal)} in total (${formatDuration(t.handoffMsMedian)} per request).`,
        );
      return {
        suggestion: `Let ${b} accept ${a}'s input directly.`,
        why,
        proposal: `${crafted[0] ?? b}: ${b} with ${a}'s arguments added as an optional way in; its handler runs the lookup itself.`,
        effect:
          t && t.handoffPairs > 0
            ? `About ${formatDuration(t.handoffMsTotal)} less waiting over this window; one call instead of two.`
            : "One call instead of two when the agent starts from the lookup's input.",
      };
    }
    case "rewrite_tool": {
      const r = e?.kind === "rewrite_tool" ? e.rewrite : null;
      return {
        suggestion: `Rewrite the retrieval text of ${a}.`,
        why: r
          ? [
              `Searches missed it ${r.missedQueries.length} times and buried it ${r.buriedQueries.length} times${r.distractors[0] ? `; ${r.distractors[0]} came up instead` : ""}.`,
            ]
          : [],
        proposal:
          "The same tool with the phrasings that missed added to its searchable text; name and schema unchanged.",
        effect: "Those asks retrieve the tool first; nothing the agent calls changes.",
      };
    }
    case "compose_chain": {
      const c = e?.kind === "compose_chain" ? e.compose : null;
      const steps = card.sources.map((s) => name(s.id));
      const saved =
        c?.medianModelCalls !== null && c?.medianModelCalls !== undefined
          ? Math.max(0, Math.round(c.medianModelCalls - c.medianModelCalls / steps.length))
          : null;
      return {
        suggestion: `Compose ${steps.join(" → ")} into one tool.`,
        why: c
          ? [
              `The chain ran ${c.runs} times, in this order ${pct(c.orderStability)} of the time${c.medianMs !== null ? `, ${formatDuration(c.medianMs)} per run` : ""}${c.medianModelCalls !== null ? ` and ${c.medianModelCalls} model calls` : ""}.`,
            ]
          : [],
        proposal: `${crafted[0] ?? "one tool"}: the ${steps.length} handlers called in order, each result passed on; the ${steps.length} tools stay for single steps.`,
        effect: `${steps.length} calls become one${saved !== null && saved > 0 ? `; about ${saved} fewer model round-trips per run` : ""}.`,
      };
    }
    case "parallel_pair": {
      const p = e?.kind === "parallel_pair" ? e.parallel : null;
      const ordered = Math.max(1, (p?.orderAb ?? 0) + (p?.orderBa ?? 0));
      const overlap =
        p && p.aMedianMs !== null && p.bMedianMs !== null
          ? Math.min(p.aMedianMs, p.bMedianMs)
          : null;
      return {
        suggestion: `Let ${a} and ${b} run in the same step.`,
        why: p
          ? [
              `Always both called (${pct(p.jaccard)}, ${p.support} times), ${a} first ${pct(p.orderAb / ordered)} of the time and ${b} first ${pct(p.orderBa / ordered)}: neither waits for the other.`,
            ]
          : [],
        proposal: `Both descriptions say the tools are independent; names and schemas unchanged.`,
        effect:
          overlap !== null
            ? `The two waits overlap: about ${formatDuration(overlap)} less per request.`
            : "The two waits overlap instead of adding up.",
      };
    }
    case "tighten_schema": {
      const t = e?.kind === "tighten_schema" ? e.tighten : null;
      const edits = [
        ...(t?.freeTextArgs.length ? [`an enum for ${t.freeTextArgs.join(", ")}`] : []),
        ...(t?.undocumentedArgs.length
          ? [`descriptions for ${t.undocumentedArgs.join(", ")}`]
          : []),
      ];
      return {
        suggestion: `Tighten ${a}'s schema.`,
        why: t
          ? [
              t.namedRecovered !== undefined
                ? `${t.errorCalls} of ${t.calls} calls failed; ${t.namedRecovered} ${t.namedRecovered === 1 ? "failure" : "failures"} named the argument and the straight retry then succeeded, so the first call was shaped wrong${t.namedArguments && t.namedArguments.length > 0 ? ` (the errors named ${t.namedArguments.join(", ")})` : ""}.`
                : `${t.errorCalls} of ${t.calls} calls failed; ${t.recoveredRetries} of ${t.retriedErrors} retries then succeeded, so the first call was shaped wrong.`,
            ]
          : [],
        proposal:
          edits.length > 0
            ? `Add ${edits.join(" and ")}.`
            : "Write the validator's constraints into the schema and make each validation error name the argument.",
        effect: t
          ? `Up to ${t.namedRecovered ?? t.recoveredRetries} failed first calls avoided, each a tool call and a model round-trip.`
          : "Fewer failed first calls.",
      };
    }
    case "enrich_response": {
      const en = e?.kind === "enrich_response" ? e.enrich : null;
      const ask = en?.intentText ? `“${en.intentText}”` : "this ask";
      return {
        suggestion: `Return what ${b} fetches in ${a}'s response.`,
        why: en
          ? [
              `For ${ask}, ${b} came right after ${a} in ${en.n} of ${en.na} calls (${pct(en.n / en.na)}).`,
            ]
          : [],
        proposal: `Add ${b}'s result to ${a}'s response; keep ${b} for other asks.`,
        effect: en
          ? `One call instead of two for every turn of ${ask}${en.bMedianMs !== null ? `, about ${formatDuration(en.bMedianMs)} less per turn` : ""}.`
          : "One call instead of two.",
      };
    }
    case "preload_context": {
      const pre = e?.kind === "preload_context" ? e.preload : null;
      const ask = pre?.intentText ? `“${pre.intentText}”` : "this ask";
      return {
        suggestion: `Hand the agent ${a}'s result before the turn starts.`,
        why: pre
          ? [
              `${pre.firstN} of ${pre.units} turns of ${ask} (${pct(pre.firstN / Math.max(1, pre.units))}) open with ${a}, before anything is decided.`,
            ]
          : [],
        proposal: `Put ${a}'s result in the context the agent starts with (system prompt, resource, or turn-start hook).`,
        effect: pre
          ? `One call and one model round-trip fewer for every turn of ${ask}${pre.medianMs !== null ? `, about ${formatDuration(pre.medianMs)} less per turn` : ""}.`
          : "One call fewer per turn.",
      };
    }
    case "split_by_use": {
      const su = e?.kind === "split_by_use" ? e.splitByUse : null;
      const followers = su ? [...new Set(su.uses.map((u) => name(u.follower)))] : [];
      return {
        suggestion: `${a} is used ${su?.uses.length ?? 2} ways: split it, or return what ${followers.join(" and ")} fetch.`,
        why: su
          ? su.uses.map(
              (u) =>
                `Under “${u.intentText ?? u.intentId}” ${name(u.follower)} follows it ${pct(u.n / u.na)} of the time (${u.n} of ${u.na}).`,
            )
          : [],
        proposal: `One variant per use, or one richer response.`,
        effect: su
          ? `One call instead of two for ${su.uses.reduce((sum, u) => sum + u.n, 0)} hops in this window.`
          : "One call instead of two.",
      };
    }
    case "fill_gap": {
      const g = e?.kind === "fill_gap" ? e.gap : null;
      const ask = g?.intentText ? `“${g.intentText}”` : "this ask";
      return {
        suggestion: `No tool answers ${ask}: add one (e.g. ${g?.suggestedName ?? "a new tool"}).`,
        why: g
          ? [
              `${g.units} turns reached ${g.distinctTools} different tools, ${g.callsPerUnit.toFixed(1)} calls per turn against ${g.projectCallsPerUnit.toFixed(1)} for the project, with no fixed path.`,
            ]
          : [],
        proposal: g
          ? `A tool returning what the agent assembles from ${g.topTools.map((t) => name(t.toolId)).join(", ")}.`
          : "A tool that answers the ask directly.",
        effect: g
          ? `About ${Math.max(0, g.callsPerUnit - 1).toFixed(1)} fewer calls and round-trips per turn, over ${g.units} turns.`
          : "One call instead of several.",
      };
    }
    case "require_prerequisite": {
      const r = e?.kind === "require_prerequisite" ? e.require : null;
      const without = r ? r.withoutA.errors / Math.max(1, r.withoutA.calls) : 0;
      const withA = r ? r.withA.errors / Math.max(1, r.withA.calls) : 0;
      return {
        suggestion: `Make ${b} run ${a} first.`,
        why: r
          ? [
              r.recovery
                ? `${r.recovery.via} of ${b}'s ${r.recovery.recovered} recovered failures worked only after the agent called ${a} in between: the call was missing what ${a} looks up.`
                : `${b} fails ${pct(without)} of the time without ${a} earlier in the turn (${r.withoutA.errors} of ${r.withoutA.calls}) and ${pct(withA)} with it (${r.withA.errors} of ${r.withA.calls}).`,
            ]
          : [],
        proposal: `${crafted[0] ?? "one tool"}: ${b}'s handler, calling ${a} first when its input is given; or say the dependency in ${b}'s description.`,
        effect: r
          ? `About ${r.recovery ? r.recovery.via : Math.max(0, Math.round(r.withoutA.errors - withA * r.withoutA.calls))} fewer failed calls in this window.`
          : "Fewer failed calls.",
      };
    }
    default: {
      const d = e?.kind === "deprecate_tool" ? e.deprecate : null;
      return {
        suggestion: `Retire ${a}.`,
        why: d
          ? [
              `Declared, never called in ${d.windowDays} days${d.replacement ? `; ${d.replacement} covers it and ran ${d.replacementCalls} times` : ""}.`,
            ]
          : [],
        proposal: d?.replacement ? `Remove ${a}; use ${d.replacement}.` : `Remove ${a}.`,
        effect: "One fewer entry in every list the agent reads.",
      };
    }
  }
}
