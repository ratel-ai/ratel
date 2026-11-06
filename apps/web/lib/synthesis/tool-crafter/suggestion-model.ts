import type { IntentToolsView } from "@/lib/readings/tool-explorer/view";
import { formatDuration } from "@/lib/readings/tool-explorer/view";
import {
  INTENT_MERGE_PLAIN,
  KIND_PLAIN,
  KIND_RANK,
  KIND_VERBS,
} from "@/lib/synthesis/tool-crafter/kinds";
import { NO_PRICE, type RoundTripPrice } from "@/lib/synthesis/tool-crafter/round-trip";
import type {
  CraftedToolDefinition,
  CraftKind,
  SourceTool,
} from "@/lib/synthesis/tool-crafter/types";
import {
  backtestReadout,
  type CraftCardModel,
  cardSummary,
  type EvidenceFact,
  evidenceFacts,
  isModeSwitch,
  requestTime,
} from "@/lib/synthesis/tool-crafter/view";

/**
 * A craft proposal as the Tool Explorer shows it beside the asks: what to do
 * (one line), the one measured number that says what it is worth, why (the
 * evidence sentence with its numbers), and which asks it serves, so a reader
 * can jump from the suggestion to the ask on the map. Everything comes from
 * the card model's own summary helpers; this file only picks and orders.
 */

export interface SuggestionFigure {
  /** The big number: "−38%", "+12%", "3 kinds of ask", "0 calls". */
  value: string;
  /** Under it: "per request", "found in replay", "one schema today", "in 30 days". */
  caption: string;
  /** Measured from traffic (timing, replay) or read off the catalog. */
  measured: boolean;
}

export interface SuggestionAsk {
  intentId: string;
  text: string;
  units: number;
}

/** One effect, as an icon and a few words: "−25 s over window", "2 → 1 calls". */
/** What a suggestion removes over the window, with the model round-trips priced when the project has linked model calls. */
export interface SuggestionGain {
  /** Occurrences in the window the suggestion applies to (hops, runs, retries, …). */
  occurrences: number;
  /** Tool calls removed over the window. */
  calls: number;
  /** Model round-trips removed over the window. */
  roundTrips: number;
  /** Waiting removed over the window: the tools' own time plus the round-trips, when priced. */
  ms: number;
  /** Dollars removed over the window; null without a priced model. */
  usd: number | null;
  /** Tokens removed over the window (the round-trips' input and output); null when the linked calls carry no token counts. */
  tokens: { input: number; output: number } | null;
}

export interface EffectChip {
  icon: "time" | "calls" | "failures" | "list" | "schema" | "model" | "cost" | "tokens";
  text: string;
  /** The derivation, for the tooltip: "123 round-trips × 6.1k tokens per model call". */
  title?: string;
}

export interface SuggestionView {
  id: string;
  kind: CraftKind;
  /** "Merge", "Fold in", "Split", "Rewrite", "Retire". */
  verb: string;
  /** cardSummary().suggestion: what to do, with the tool names. */
  headline: string;
  figure: SuggestionFigure | null;
  /** cardSummary().why[0]: the evidence sentence. */
  why: string;
  /** cardSummary().effect: what to expect, one line (the craft page prints it; the explorer prints `effects`). */
  effect: string;
  /** One sentence saying what this kind of suggestion is, in plain words. */
  plain: string;
  /** The four figures an opened row shows: calls per unit, waiting per unit, tokens (or round-trips) over the window, dollars. */
  brief: EffectChip[];
  /** The closed row's effect column: icon and number only, the calls chip and the biggest window figure (dollars, else tokens, else round-trips). */
  glance: EffectChip[];
  /** The crafted definitions, for the inline definition panel; empty for note-only kinds. */
  crafted: CraftedToolDefinition[];
  /** What one application removes: "2 calls → 1", "−1 round-trip", "−686 ms waiting". */
  effects: EffectChip[];
  /** "per run", "per turn", "per failure": the unit `effects` speak of. */
  unit: string;
  /** What the window adds up to: round-trips, waiting, tokens, dollars. Empty when nothing is counted. */
  windowEffects: EffectChip[];
  /** "over the window · 41 runs". */
  windowLabel: string;
  /** The evidence as label/value pairs. */
  facts: EvidenceFact[];
  /** Source tool ids. */
  tools: string[];
  /** The source tools as the runtime last described them: name, description, arguments. The opened row shows them, so a reviewer sees what the suggestion is about. */
  sources: SourceTool[];
  /** Asks whose units mostly call every source tool, biggest first. */
  asks: SuggestionAsk[];
  /** The retrieval replay's verdict, when one ran. */
  replay: { verdict: "better" | "same" | "worse"; delta: string | null } | null;
  /** What the suggestion removes over the window. */
  gain: SuggestionGain;
  /** For ordering: `gain.ms`. */
  savingMs: number;
  /** A tighten's arguments the validation errors named; empty for every other kind. */
  namedArguments: string[];
  support: number;
  /** From `support`: early (< 10), solid (< 30), established. */
  maturity: Maturity;
}

/** A tool serves an ask when at least this share of the ask's units called it. */
export const ASK_SERVES_SHARE = 0.5;
const ASKS_SHOWN = 2;

const pct = (n: number) => `${Math.round(n * 100)}%`;
export const formatTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${Math.round(n / 1000)}k`
      : n >= 1_000
        ? `${(n / 1000).toFixed(1)}k`
        : String(Math.round(n));
export const formatUsd = (usd: number): string =>
  usd >= 100
    ? `$${Math.round(usd).toLocaleString("en-US")}`
    : usd >= 1
      ? `$${usd.toFixed(2)}`
      : `$${usd.toFixed(3)}`;
/** A median under a millisecond is a tool the ledger did not time, not a free one: say calls, not "−0 ms". */
const timed = (ms: number | null): boolean => ms !== null && ms >= 1;

function figureOf(card: CraftCardModel): SuggestionFigure | null {
  const e = card.evidence;
  const time = requestTime(card);
  if (time)
    return {
      value: `−${formatDuration(time.beforeMs - time.afterMs)}`,
      caption: "request time",
      measured: true,
    };
  if (card.kind === "merge_tools" || card.kind === "fold_prerequisite") {
    const support =
      e?.kind === "merge_tools"
        ? e.merge?.support
        : e?.kind === "fold_prerequisite"
          ? e.fold?.support
          : undefined;
    return support
      ? { value: `${support.toLocaleString("en-US")}×`, caption: "ran together", measured: true }
      : null;
  }
  if (card.kind === "rewrite_tool") {
    if (card.backtest) {
      const r = backtestReadout(card.backtest);
      if (r.verdict === "better" && card.backtest.delta.quality !== null)
        return {
          value: `+${pct(card.backtest.delta.quality)}`,
          caption: "found in replay",
          measured: true,
        };
    }
    const r = e?.kind === "rewrite_tool" ? e.rewrite : null;
    const missed = (r?.missedQueries.length ?? 0) + (r?.buriedQueries.length ?? 0);
    return missed > 0
      ? { value: missed.toLocaleString("en-US"), caption: "asks missed", measured: true }
      : null;
  }
  if (card.kind === "compose_chain") {
    const c = e?.kind === "compose_chain" ? e.compose : null;
    if (!c) return null;
    const saved =
      c.medianModelCalls !== null
        ? Math.max(0, Math.round(c.medianModelCalls - c.medianModelCalls / c.order.length))
        : null;
    return saved !== null && saved > 0
      ? { value: `−${saved}`, caption: "model calls / run", measured: true }
      : { value: `${c.order.length} → 1`, caption: "calls / run", measured: true };
  }
  if (card.kind === "parallel_pair") {
    const p = e?.kind === "parallel_pair" ? e.parallel : null;
    if (!p) return null;
    const overlap =
      p.aMedianMs !== null && p.bMedianMs !== null ? Math.min(p.aMedianMs, p.bMedianMs) : null;
    return overlap !== null
      ? { value: `−${formatDuration(overlap)}`, caption: "request time", measured: true }
      : { value: `${p.support}×`, caption: "ran together", measured: true };
  }
  if (card.kind === "tighten_schema") {
    const t = e?.kind === "tighten_schema" ? e.tighten : null;
    return t
      ? {
          value: `−${t.namedRecovered ?? t.recoveredRetries}`,
          caption: "failed calls",
          measured: true,
        }
      : null;
  }
  if (card.kind === "enrich_response") {
    const en = e?.kind === "enrich_response" ? e.enrich : null;
    if (!en) return null;
    return timed(en.bMedianMs)
      ? { value: `−${formatDuration(en.bMedianMs!)}`, caption: "per turn", measured: true }
      : { value: "2 → 1", caption: "calls / turn", measured: true };
  }
  if (card.kind === "preload_context") {
    const pre = e?.kind === "preload_context" ? e.preload : null;
    if (!pre) return null;
    return timed(pre.medianMs)
      ? { value: `−${formatDuration(pre.medianMs!)}`, caption: "per turn", measured: true }
      : { value: "−1", caption: "call / turn", measured: true };
  }
  if (card.kind === "split_by_use") {
    const su = e?.kind === "split_by_use" ? e.splitByUse : null;
    return su ? { value: `${su.uses.length} ways`, caption: "one tool", measured: true } : null;
  }
  if (card.kind === "fill_gap") {
    const g = e?.kind === "fill_gap" ? e.gap : null;
    return g
      ? { value: `${g.callsPerUnit.toFixed(1)} → 1`, caption: "calls / turn", measured: true }
      : null;
  }
  if (card.kind === "require_prerequisite") {
    const r = e?.kind === "require_prerequisite" ? e.require : null;
    if (!r) return null;
    if (r.recovery) return { value: `−${r.recovery.via}`, caption: "failed calls", measured: true };
    const without = r.withoutA.errors / Math.max(1, r.withoutA.calls);
    const withA = r.withA.errors / Math.max(1, r.withA.calls);
    return { value: `${pct(without)} → ${pct(withA)}`, caption: "failures", measured: true };
  }
  if (card.kind === "deprecate_tool") {
    const d = e?.kind === "deprecate_tool" ? e.deprecate : null;
    return d
      ? {
          value: `${d.calls} ${d.calls === 1 ? "call" : "calls"}`,
          caption: `${d.windowDays} days`,
          measured: true,
        }
      : null;
  }
  return null;
}

/** The opened row's four chips, each fact once: what one unit saves in calls and waiting, what the window saves in tokens (round-trips when unpriced) and dollars. */
function briefOf(effects: Effects, gain: SuggestionGain, price: RoundTripPrice): EffectChip[] {
  const unit = effects.unit.replace(/^per /, "");
  const out: EffectChip[] = [];
  const calls = effects.each.find(
    (c) => c.icon === "calls" || c.icon === "failures" || c.icon === "list" || c.icon === "schema",
  );
  if (calls) out.push(calls);
  const wait = effects.each.find((c) => c.icon === "time");
  if (wait)
    out.push({
      ...wait,
      text: unit ? wait.text.replace(" waiting", `/${unit} waiting`) : wait.text,
    });
  if (gain.tokens && gain.tokens.input + gain.tokens.output > 0)
    out.push({
      icon: "tokens",
      text: `−${formatTokens(gain.tokens.input + gain.tokens.output)} tokens total`,
      title: `${gain.roundTrips} round-trips × ${formatTokens((price.inputTokens ?? 0) + (price.outputTokens ?? 0))} tokens per model call in this project`,
    });
  else if (gain.roundTrips > 0)
    out.push({
      icon: "model",
      text: `−${gain.roundTrips.toLocaleString("en-US")} round-trips total`,
      title:
        price.modelCalls > 0
          ? `${pct(gain.roundTrips / price.modelCalls)} of the window's model calls`
          : "the project's model calls are not linked, so no tokens or dollars",
    });
  if (gain.usd !== null && gain.usd > 0)
    out.push({
      icon: "cost",
      text: `−${formatUsd(gain.usd)} total`,
      title: `${gain.roundTrips} round-trips × ${formatUsd(price.usd ?? 0)} per model call in this project`,
    });
  return out;
}

/** "3 calls → 1" → "3 → 1", "−$1.19 total" → "−$1.19", "−302k tokens total" → "−302k": the number with its icon, the words in the tooltip. */
export function glanceOf(brief: readonly EffectChip[]): EffectChip[] {
  const out: EffectChip[] = [];
  const calls = brief.find(
    (c) => c.icon === "calls" || c.icon === "failures" || c.icon === "list" || c.icon === "schema",
  );
  if (calls)
    out.push({
      ...calls,
      title: calls.text,
      text: calls.text
        .replace(
          / (calls?|failed call|round-trips?|entry in every tool list|tools, smaller schemas)/,
          "",
        )
        .replace(/^same, one step$/, "1 step"),
    });
  const money =
    brief.find((c) => c.icon === "cost") ??
    brief.find((c) => c.icon === "tokens") ??
    brief.find((c) => c.icon === "model");
  if (money)
    out.push({
      ...money,
      title: money.title ? `${money.text} · ${money.title}` : money.text,
      text: money.text.replace(/ (tokens|round-trips)? ?total$/, ""),
    });
  return out;
}

interface Effects {
  each: EffectChip[];
  unit: string;
  window: EffectChip[];
  windowLabel: string;
}

const UNIT: Partial<Record<CraftKind, { each: string; many: string }>> = {
  merge_tools: { each: "per request", many: "times together" },
  fold_prerequisite: { each: "per request", many: "times together" },
  compose_chain: { each: "per run", many: "runs" },
  parallel_pair: { each: "per request", many: "times together" },
  tighten_schema: { each: "per failure", many: "failures" },
  require_prerequisite: { each: "per failure", many: "failures" },
  enrich_response: { each: "per turn", many: "turns" },
  preload_context: { each: "per turn", many: "turns" },
  split_by_use: { each: "per hop", many: "hops" },
  fill_gap: { each: "per turn", many: "turns" },
};

/**
 * Two short lines: what one application removes, and what the window adds up
 * to. Each fact once: the per-unit line never repeats the window, the window
 * line never repeats the unit. Derivations go in tooltips.
 */
function effectsOf(card: CraftCardModel, gain: SuggestionGain, price: RoundTripPrice): Effects {
  const e = card.evidence;
  const each: EffectChip[] = [];
  const unit = UNIT[card.kind];
  switch (card.kind) {
    case "merge_tools":
    case "fold_prerequisite": {
      if (isModeSwitch(card)) {
        // One tool for two operations: the catalog shrinks, the calls stay.
        each.push({ icon: "list", text: "−1 entry in every tool list" });
        break;
      }
      each.push({ icon: "calls", text: "2 calls → 1" });
      each.push({ icon: "model", text: "−1 round-trip" });
      const time = requestTime(card);
      if (time)
        each.push({
          icon: "time",
          text:
            time.afterMs > 0
              ? `−${formatDuration(time.beforeMs - time.afterMs)} waiting (−${pct(time.saved)})`
              : `−${formatDuration(time.beforeMs - time.afterMs)} waiting`,
          title: "the hand-off between the two calls, median",
        });
      break;
    }
    case "compose_chain": {
      const c = e?.kind === "compose_chain" ? e.compose : null;
      if (!c) break;
      each.push({ icon: "calls", text: `${c.order.length} calls → 1` });
      const saved =
        c.medianModelCalls !== null
          ? Math.max(0, Math.round(c.medianModelCalls - c.medianModelCalls / c.order.length))
          : c.order.length - 1;
      if (saved > 0)
        each.push({
          icon: "model",
          text: `−${saved} ${saved === 1 ? "round-trip" : "round-trips"}`,
          title:
            c.medianModelCalls !== null
              ? `${c.medianModelCalls} model calls per run today; one step keeps about ${(c.medianModelCalls / c.order.length).toFixed(1)}`
              : "one model call per step today",
        });
      break;
    }
    case "parallel_pair": {
      const p = e?.kind === "parallel_pair" ? e.parallel : null;
      if (!p) break;
      if (p.aMedianMs !== null && p.bMedianMs !== null)
        each.push({
          icon: "time",
          text: `−${formatDuration(Math.min(p.aMedianMs, p.bMedianMs))} waiting`,
          title: "the shorter of the two calls, which now overlaps the longer",
        });
      each.push({ icon: "calls", text: "same calls, one step" });
      break;
    }
    case "tighten_schema":
    case "require_prerequisite":
      each.push({ icon: "failures", text: "−1 failed call" });
      each.push({
        icon: "model",
        text: "−1 round-trip",
        title: "the retry the agent made after the failure",
      });
      break;
    case "enrich_response": {
      const en = e?.kind === "enrich_response" ? e.enrich : null;
      if (!en) break;
      each.push({ icon: "calls", text: "2 calls → 1" });
      each.push({ icon: "model", text: "−1 round-trip" });
      if (timed(en.bMedianMs))
        each.push({
          icon: "time",
          text: `−${formatDuration(en.bMedianMs!)} waiting`,
          title: "the second call's median duration",
        });
      break;
    }
    case "preload_context": {
      const pre = e?.kind === "preload_context" ? e.preload : null;
      if (!pre) break;
      each.push({ icon: "calls", text: "−1 call" });
      each.push({ icon: "model", text: "−1 round-trip" });
      if (timed(pre.medianMs))
        each.push({
          icon: "time",
          text: `−${formatDuration(pre.medianMs!)} waiting`,
          title: "the lookup's median duration",
        });
      break;
    }
    case "split_by_use": {
      const su = e?.kind === "split_by_use" ? e.splitByUse : null;
      if (!su) break;
      each.push({ icon: "calls", text: "2 calls → 1" });
      each.push({ icon: "model", text: "−1 round-trip" });
      break;
    }
    case "fill_gap": {
      const g = e?.kind === "fill_gap" ? e.gap : null;
      if (!g) break;
      each.push({ icon: "calls", text: `${g.callsPerUnit.toFixed(1)} calls → 1` });
      each.push({
        icon: "model",
        text: `−${Math.max(0, g.callsPerUnit - 1).toFixed(1)} round-trips`,
      });
      break;
    }
    case "rewrite_tool": {
      if (card.backtest) {
        const r = backtestReadout(card.backtest);
        if (r.delta) each.push({ icon: "list", text: r.delta });
      }
      break;
    }
    case "deprecate_tool":
      each.push({ icon: "list", text: "−1 entry in every tool list" });
      break;
  }

  const window: EffectChip[] = [];
  if (gain.roundTrips > 0) {
    const share =
      price.modelCalls > 0
        ? `${pct(gain.roundTrips / price.modelCalls)} of the window's ${price.modelCalls.toLocaleString("en-US")} model calls`
        : null;
    window.push({
      icon: "model",
      text: `−${gain.roundTrips.toLocaleString("en-US")} round-trips${share ? ` (${pct(gain.roundTrips / price.modelCalls)})` : ""}`,
      title: [
        share,
        price.ms !== null
          ? `${formatDuration(price.ms)} each in this project`
          : "the project's model calls are not timed",
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  if (gain.ms > 0)
    window.push({
      icon: "time",
      text: `−${formatDuration(gain.ms)} waiting`,
      title:
        price.ms !== null && gain.roundTrips > 0
          ? `tool time plus ${gain.roundTrips} round-trips × ${formatDuration(price.ms)}`
          : "tool time only; the model's time is not known here",
    });
  if (gain.tokens && gain.tokens.input + gain.tokens.output > 0)
    window.push({
      icon: "tokens",
      text: `−${formatTokens(gain.tokens.input + gain.tokens.output)} tokens`,
      title: `${gain.roundTrips} round-trips × ${formatTokens((price.inputTokens ?? 0) + (price.outputTokens ?? 0))} tokens per model call in this project (${formatTokens(gain.tokens.input)} in, ${formatTokens(gain.tokens.output)} out)`,
    });
  if (gain.usd !== null && gain.usd > 0)
    window.push({
      icon: "cost",
      text: `−${formatUsd(gain.usd)}`,
      title: `${gain.roundTrips} round-trips × ${formatUsd(price.usd ?? 0)} per model call in this project`,
    });
  const t =
    e?.kind === "merge_tools"
      ? e.merge?.timing
      : e?.kind === "fold_prerequisite"
        ? e.fold?.timing
        : undefined;
  if (t && t.searchesBetween > 0)
    window.push({ icon: "list", text: `−${t.searchesBetween} tool searches` });
  const windowLabel =
    unit && gain.occurrences > 0
      ? `over the window · ${gain.occurrences.toLocaleString("en-US")} ${unit.many}`
      : "over the window";
  return { each, unit: unit?.each ?? "", window, windowLabel };
}

/**
 * Per kind: how many times the suggestion applies in the window, what one
 * application removes (tool calls, model round-trips, tool time), priced
 * with the project's round-trip when known.
 */
export function gainOf(card: CraftCardModel, price: RoundTripPrice = NO_PRICE): SuggestionGain {
  const e = card.evidence;
  const time = requestTime(card);
  let occurrences = 0;
  let callsEach = 0;
  let tripsEach = 0;
  let toolMsEach = 0;
  switch (e?.kind) {
    case "merge_tools":
    case "fold_prerequisite": {
      const support = e.kind === "merge_tools" ? e.merge?.support : e.fold?.support;
      occurrences = support ?? 0;
      if (isModeSwitch(card)) break;
      callsEach = 1;
      tripsEach = 1;
      toolMsEach = time ? time.beforeMs - time.afterMs : 0;
      break;
    }
    case "compose_chain": {
      const c = e.compose;
      if (!c) break;
      occurrences = c.runs;
      callsEach = Math.max(0, c.order.length - 1);
      tripsEach =
        c.medianModelCalls !== null
          ? Math.max(0, c.medianModelCalls - c.medianModelCalls / c.order.length)
          : callsEach;
      break;
    }
    case "parallel_pair": {
      const p = e.parallel;
      if (!p) break;
      occurrences = p.support;
      toolMsEach =
        p.aMedianMs !== null && p.bMedianMs !== null ? Math.min(p.aMedianMs, p.bMedianMs) : 0;
      break;
    }
    case "tighten_schema": {
      occurrences = e.tighten ? (e.tighten.namedRecovered ?? e.tighten.recoveredRetries) : 0;
      callsEach = 1;
      tripsEach = 1;
      break;
    }
    case "require_prerequisite": {
      const r = e.require;
      if (!r) break;
      const withA = r.withA.errors / Math.max(1, r.withA.calls);
      occurrences = r.recovery
        ? r.recovery.via
        : Math.max(0, Math.round(r.withoutA.errors - withA * r.withoutA.calls));
      callsEach = 1;
      tripsEach = 1;
      break;
    }
    case "enrich_response": {
      const en = e.enrich;
      if (!en) break;
      occurrences = en.n;
      callsEach = 1;
      tripsEach = 1;
      toolMsEach = timed(en.bMedianMs) ? en.bMedianMs! : 0;
      break;
    }
    case "preload_context": {
      const pre = e.preload;
      if (!pre) break;
      occurrences = pre.firstN;
      callsEach = 1;
      tripsEach = 1;
      toolMsEach = timed(pre.medianMs) ? pre.medianMs! : 0;
      break;
    }
    case "split_by_use": {
      const su = e.splitByUse;
      if (!su) break;
      occurrences = su.uses.reduce((sum, u) => sum + u.n, 0);
      callsEach = 1;
      tripsEach = 1;
      break;
    }
    case "fill_gap": {
      const g = e.gap;
      if (!g) break;
      occurrences = g.units;
      callsEach = Math.max(0, g.callsPerUnit - 1);
      tripsEach = callsEach;
      break;
    }
    default:
      break;
  }
  const roundTrips = Math.round(occurrences * tripsEach);
  // Merges and folds carry the measured hand-off total; that beats median × count.
  const measured =
    e?.kind === "merge_tools" || e?.kind === "fold_prerequisite" ? savingMsOf(card) : 0;
  const ms =
    (measured > 0 ? measured : occurrences * toolMsEach) +
    (price.ms !== null ? roundTrips * price.ms : 0);
  const tokens =
    price.inputTokens !== null && price.outputTokens !== null && roundTrips > 0
      ? {
          input: Math.round(roundTrips * price.inputTokens),
          output: Math.round(roundTrips * price.outputTokens),
        }
      : null;
  return {
    occurrences,
    calls: Math.round(occurrences * callsEach),
    roundTrips,
    ms: Math.round(ms),
    usd: price.usd !== null && roundTrips > 0 ? roundTrips * price.usd : null,
    tokens,
  };
}

function savingMsOf(card: CraftCardModel): number {
  if (isModeSwitch(card)) return 0;
  const e = card.evidence;
  if (
    e?.kind === "parallel_pair" &&
    e.parallel &&
    e.parallel.aMedianMs !== null &&
    e.parallel.bMedianMs !== null
  )
    return Math.min(e.parallel.aMedianMs, e.parallel.bMedianMs) * e.parallel.support;
  if (e?.kind === "enrich_response" && e.enrich && e.enrich.bMedianMs !== null)
    return e.enrich.bMedianMs * e.enrich.n;
  if (e?.kind === "preload_context" && e.preload && e.preload.medianMs !== null)
    return e.preload.medianMs * e.preload.firstN;
  const t =
    e?.kind === "merge_tools"
      ? e.merge?.timing
      : e?.kind === "fold_prerequisite"
        ? e.fold?.timing
        : undefined;
  return t?.handoffMsTotal ?? 0;
}

function supportOf(card: CraftCardModel): number {
  const e = card.evidence;
  switch (e?.kind) {
    case "merge_tools":
      return e.merge?.support ?? 0;
    case "fold_prerequisite":
      return e.fold?.support ?? 0;
    case "rewrite_tool":
      return (e.rewrite?.missedQueries.length ?? 0) + (e.rewrite?.buriedQueries.length ?? 0);
    case "compose_chain":
      return e.compose?.runs ?? 0;
    case "parallel_pair":
      return e.parallel?.support ?? 0;
    case "tighten_schema":
      return e.tighten ? (e.tighten.namedRecovered ?? e.tighten.recoveredRetries) : 0;
    case "enrich_response":
      return e.enrich?.n ?? 0;
    case "preload_context":
      return e.preload?.firstN ?? 0;
    case "split_by_use":
      return e.splitByUse?.uses.reduce((sum, u) => sum + u.n, 0) ?? 0;
    case "fill_gap":
      return e.gap?.units ?? 0;
    case "require_prerequisite":
      return e.require
        ? e.require.recovery
          ? e.require.recovery.via
          : e.require.withoutA.errors
        : 0;
    default:
      return 0;
  }
}

/** A per-ask proposal names its ask; others are matched to asks by their tools. */
function askOf(card: CraftCardModel): SuggestionAsk[] | null {
  const e = card.evidence;
  if (e?.kind === "enrich_response" && e.enrich)
    return [
      {
        intentId: e.enrich.intentId,
        text: e.enrich.intentText ?? e.enrich.intentId,
        units: e.enrich.units,
      },
    ];
  if (e?.kind === "preload_context" && e.preload)
    return [
      {
        intentId: e.preload.intentId,
        text: e.preload.intentText ?? e.preload.intentId,
        units: e.preload.units,
      },
    ];
  if (e?.kind === "split_by_use" && e.splitByUse)
    return e.splitByUse.uses.map((u) => ({
      intentId: u.intentId,
      text: u.intentText ?? u.intentId,
      units: u.units,
    }));
  if (e?.kind === "fill_gap" && e.gap)
    return [
      { intentId: e.gap.intentId, text: e.gap.intentText ?? e.gap.intentId, units: e.gap.units },
    ];
  return null;
}

/** How much evidence stands behind a suggestion, from its support count: a reader on day two sees direction, and watches it firm up. */
export type Maturity = "early" | "solid" | "established";
export const MATURITY_SOLID = 10;
export const MATURITY_ESTABLISHED = 30;
export function maturityOf(support: number): Maturity {
  return support >= MATURITY_ESTABLISHED
    ? "established"
    : support >= MATURITY_SOLID
      ? "solid"
      : "early";
}

/** The asks whose units mostly call every source tool, biggest first. */
export function asksServed(
  tools: readonly string[],
  intents: readonly IntentToolsView[],
  minShare: number = ASK_SERVES_SHARE,
  top: number = ASKS_SHOWN,
): SuggestionAsk[] {
  if (tools.length === 0) return [];
  return intents
    .filter((intent) =>
      tools.every((id) => intent.tools.some((t) => t.toolId === id && t.share >= minShare)),
    )
    .sort((x, y) => y.units - x.units || (x.text < y.text ? -1 : 1))
    .slice(0, top)
    .map((intent) => ({ intentId: intent.intentId, text: intent.text, units: intent.units }));
}

export function suggestionView(
  card: CraftCardModel,
  name: (id: string) => string,
  intents: readonly IntentToolsView[] = [],
  opts: { price?: RoundTripPrice } = {},
): SuggestionView {
  const summary = cardSummary(card, name);
  const tools = card.sources.map((s) => s.id);
  const price = opts.price ?? NO_PRICE;
  const gain = gainOf(card, price);
  const effects = effectsOf(card, gain, price);
  const replay = card.backtest
    ? (({ verdict, delta }) => ({ verdict, delta }))(backtestReadout(card.backtest))
    : null;
  return {
    id: card.id,
    kind: card.kind,
    verb: KIND_VERBS[card.kind],
    headline: summary.suggestion,
    figure: figureOf(card),
    why: summary.why[0] ?? card.rationale,
    effect: summary.effect,
    plain:
      card.evidence?.kind === "merge_tools" && card.evidence.merge?.intent
        ? INTENT_MERGE_PLAIN
        : KIND_PLAIN[card.kind],
    brief: briefOf(effects, gain, price),
    glance: glanceOf(briefOf(effects, gain, price)),
    crafted: card.crafted,
    effects: effects.each,
    unit: effects.unit,
    windowEffects: effects.window,
    windowLabel: effects.windowLabel,
    facts: evidenceFacts(card.evidence),
    tools,
    sources: card.sources,
    asks: askOf(card) ?? asksServed(tools, intents),
    replay,
    gain,
    savingMs: Math.max(gain.ms, savingMsOf(card)),
    namedArguments:
      card.evidence?.kind === "tighten_schema" ? (card.evidence.tighten?.namedArguments ?? []) : [],
    support: supportOf(card),
    maturity: maturityOf(supportOf(card)),
  };
}

/** What the customer changes in their tool server or agent for the suggestion to take effect. Shown in the opened row; Ratel itself changes nothing, since it cannot add, rename, hide or remove a tool in the runtime. */
export interface SuggestedChange {
  theirs: string[];
}

export function changeOf(
  view: Pick<SuggestionView, "kind" | "tools" | "crafted"> &
    Partial<Pick<SuggestionView, "namedArguments">>,
  name: (id: string) => string,
): SuggestedChange {
  const tools = view.tools.map(name);
  const named = view.namedArguments ?? [];
  const [a = "the tool", b = "the next tool"] = tools;
  const list =
    tools.length <= 1
      ? a
      : tools.length === 2
        ? `${a} and ${b}`
        : `${tools.slice(0, -1).join(", ")} and ${tools[tools.length - 1]}`;
  const crafted = view.crafted.map((c) => c.name).join(", ");
  const theirs: Record<CraftKind, string[]> = {
    merge_tools: [
      isModeSwitch(view)
        ? `Implement ${crafted} in your tool server from the definition and code below; it runs ${tools.join(" or ")} as its \`mode\` argument says, so the catalog carries one tool for both. Each operation is still its own call.`
        : `Implement ${crafted} in your tool server from the definition and code below; it does what ${list} did in one call.`,
      `Keep ${list} until ${crafted} is live; nothing is renamed, hidden or removed by us.`,
    ],
    fold_prerequisite: [
      `Let ${b} accept what ${a} looks up as a direct argument (definition below), so the agent skips the ${a} call.`,
    ],
    compose_chain: [
      `Implement ${crafted} in your tool server: it runs ${tools.join(" → ")} in one call (definition and code below).`,
      `Keep the step tools until ${crafted} is live; nothing is renamed, hidden or removed by us.`,
    ],
    rewrite_tool: [
      `Set ${a}'s searchable description in your tool server to the \`searchableDescription\` below (\`experimentalSearchableDescription\` in \`tools.register\`), so the next catalog snapshot carries it. Its description, name and schema stay as they are.`,
    ],
    deprecate_tool: [
      `Remove ${a} from your tool server. Every tool list the agent reads gets shorter.`,
    ],
    parallel_pair: [
      `Tell the agent it may call ${a} and ${b} in the same step: in the system prompt, or in both tools' descriptions.`,
    ],
    tighten_schema: [
      ...(named.length > 0
        ? [
            `Start with ${named.map((x) => `\`${x}\``).join(", ")}: the validation errors named ${named.length === 1 ? "it" : "them"}.`,
          ]
        : []),
      `Compare ${a}'s validator with its published input schema, and write every constraint the validator enforces that the schema omits: enums, length and range caps, required fields, formats, and where an id comes from.`,
      `Make each of ${a}'s validation errors name the argument and the accepted values, so a call that still fails fixes itself on the retry.`,
    ],
    require_prerequisite: [
      `Let ${b} resolve what ${a} looks up by itself when the caller passes the name instead of the id, or say in ${b}'s description that the value must come from ${a}.`,
      `Make ${b}'s rejection name the argument and point at ${a}, so an agent that still skips it recovers in one step.`,
    ],
    enrich_response: [
      `Add to ${a}'s response what the agent fetches with ${b} right after it, so the second call is not needed.`,
    ],
    preload_context: [
      `Hand the agent ${a}'s result with the request: in the system prompt, as a resource, or in a turn-start hook. The first call disappears.`,
    ],
    split_by_use: [
      `Give ${a} a variant per use, or return both results in one response, so each ask gets what it needs in one call.`,
    ],
    fill_gap: [
      `Add a tool that answers this ask directly. The tools the agent uses as a detour today are listed above.`,
    ],
  };
  return { theirs: theirs[view.kind] };
}

/**
 * Biggest effect first: a measured time saving over the window, then a
 * replay that came out better, then by kind (merges and folds, retirements,
 * splits, rewrites), then by support.
 */
export function orderSuggestions(views: readonly SuggestionView[]): SuggestionView[] {
  const tier = (v: SuggestionView) => (v.savingMs > 0 ? 0 : v.replay?.verdict === "better" ? 1 : 2);
  return [...views].sort(
    (x, y) =>
      tier(x) - tier(y) ||
      y.savingMs - x.savingMs ||
      KIND_RANK[x.kind] - KIND_RANK[y.kind] ||
      y.support - x.support ||
      (x.id < y.id ? -1 : 1),
  );
}
