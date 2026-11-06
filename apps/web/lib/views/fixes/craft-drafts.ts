import { craftKey } from "@/lib/synthesis/tool-crafter/craft-key";
import { toPythonStub, toToolJson, toTypeScriptStub } from "@/lib/synthesis/tool-crafter/export";
import { promptFor } from "@/lib/synthesis/tool-crafter/prompt";
import { listCraftProposals } from "@/lib/synthesis/tool-crafter/queries";
import {
  NO_PRICE,
  type RoundTripPrice,
  roundTripPriceOf,
} from "@/lib/synthesis/tool-crafter/round-trip";
import type { ToolCraftProposalRow } from "@/lib/synthesis/tool-crafter/schema";
import {
  changeOf,
  type EffectChip,
  type SuggestionView,
  suggestionView,
} from "@/lib/synthesis/tool-crafter/suggestion-model";
import { type CraftCardModel, cardModel, cardSummary } from "@/lib/synthesis/tool-crafter/view";
import { plainChip, replayEffect } from "@/lib/views/fixes/build";
import { EVIDENCE_LABEL, plural, silenceStrength, strengthOf } from "@/lib/views/fixes/copy";
import { compactEffect, effectLine } from "@/lib/views/fixes/effect";
import { type DraftFixInput, fixSeams } from "@/lib/views/fixes/seams";
import type { CraftDetail, EffectReading, FixEffect } from "@/lib/views/fixes/types";
import type { TaskFixSource } from "@/lib/views/tasks/model";
import { tasksSeams } from "@/lib/views/tasks/seams";

/**
 * The tool crafter's drafted changes as Fixes and the task pages read them. Loading this module
 * fills the seams `loadFixes` and `loadTasksInputs` read: the pending proposals told as fixes
 * (`fixSeams.loadDrafts`), each task's drafted fixes (`tasksSeams.loadDrafts`) and what one model
 * round trip costs the project (`fixSeams.priceOf`).
 * The telling is upstream's `craftSeed` and `craftEffect` (`lib/fixes/build.ts`), moved here so
 * the fixes build reads a `DraftFixInput` and never the crafter.
 */

/** Pending drafts read for the page; a project with more has older ones waiting on the next run. */
export const DRAFTS_READ = 200;

const CALL_ICONS: ReadonlySet<EffectChip["icon"]> = new Set([
  "calls",
  "failures",
  "list",
  "schema",
]);
const TOTAL_ICONS: readonly EffectChip["icon"][] = ["cost", "tokens", "model"];
/** The order a row's other marks take: the waiting it saves, then the money, then tokens, then model calls. */
const ALSO_ORDER: readonly EffectChip["icon"][] = [
  "time",
  "cost",
  "tokens",
  "model",
  "calls",
  "failures",
  "list",
  "schema",
];

/** Every reading beside the headline chip that has a number, as its mark and the whole chip for the tooltip. */
export function alsoReadings(brief: readonly EffectChip[], headline: EffectChip): EffectReading[] {
  const rest = brief.filter((chip) => chip !== headline && /\d/.test(chip.text));
  return ALSO_ORDER.flatMap((icon) => {
    const chip = rest.find((candidate) => candidate.icon === icon);
    return chip ? [{ icon, label: chip.title ? `${chip.text} · ${chip.title}` : chip.text }] : [];
  });
}

/** What one application removes, the row's one figure; the window's biggest total is its derivation. */
export function craftEffect(view: SuggestionView): FixEffect | null {
  if (view.kind === "rewrite_tool") {
    if (view.replay?.verdict === "better" && view.figure)
      return replayEffect(view.figure.value, null, "good");
    if (view.replay?.verdict === "worse") return replayEffect("Worse", null, "bad");
    return null;
  }
  const brief = view.brief.map(plainChip);
  // "Same calls, one step" says no number; running in parallel is told by the time it saves.
  const counted = (chip: EffectChip) => CALL_ICONS.has(chip.icon) && !/^same\b/i.test(chip.text);
  const each = brief.find(counted) ?? brief.find((chip) => chip.icon === "time") ?? null;
  const total =
    TOTAL_ICONS.map((icon) => brief.find((chip) => chip.icon === icon)).find(Boolean) ?? null;
  const strip = (chip: EffectChip) => chip.text.replace(/ total$/, "");
  const headline = each ?? total;
  if (!headline) return null;
  const compact = compactEffect(headline.text);
  return {
    value: effectLine(compact),
    ...compact,
    detail: each && total ? `${strip(total)} in all` : null,
    tone: "good",
    basis: "runs",
    also: alsoReadings(brief, headline),
  };
}

/** One drafted change, told as the fix the build reads: its worth, evidence, prompt and panel. */
export function craftDraft(
  card: CraftCardModel,
  name: (id: string) => string,
  price: RoundTripPrice,
): DraftFixInput {
  const view = suggestionView(card, name, [], { price });
  const summary = cardSummary(card, name);
  const evidence = card.evidence;
  const deprecate = evidence?.kind === "deprecate_tool" ? evidence.deprecate : null;
  const compose = evidence?.kind === "compose_chain" ? evidence.compose : null;
  const gap = evidence?.kind === "fill_gap" ? evidence.gap : null;
  // A merge found in one intent's own pattern names that intent.
  const intentId =
    evidence?.kind === "merge_tools" ? (evidence.merge?.intent?.topicId ?? null) : null;
  const strength = deprecate
    ? silenceStrength(deprecate.windowDays)
    : view.support > 0
      ? strengthOf(view.support)
      : null;
  const delta = view.replay?.delta ?? null;
  const detail: CraftDetail = {
    source: "craft",
    craftKind: card.kind,
    plain: view.plain,
    why: summary.why,
    worth: (delta ? view.brief.filter((chip) => chip.text !== delta) : view.brief).map(plainChip),
    worthCaption: view.gain.occurrences > 0 ? view.windowLabel : null,
    replay: view.replay,
    change: changeOf(view, name).theirs,
    facts: view.facts,
    sources: card.sources.map((tool) => ({
      id: tool.id,
      name: name(tool.id),
      description: tool.description,
    })),
    crafted: card.crafted.map((tool) => ({
      name: tool.name,
      json: toToolJson(tool),
      typescript: toTypeScriptStub(tool),
      python: toPythonStub(tool),
    })),
  };
  const effect = craftEffect(view);
  const measured =
    view.gain.roundTrips > 0 ||
    view.gain.ms > 0 ||
    view.gain.calls > 0 ||
    (card.kind === "rewrite_tool" && view.replay?.verdict === "better");
  const toolIds = card.sources.map((tool) => tool.id);
  return {
    id: card.id,
    kind: card.kind,
    key: craftKey(card.kind, toolIds),
    createdAt: card.createdAt.toISOString(),
    toolIds,
    taskIds: compose?.workflowId ? [compose.workflowId] : [],
    intentId,
    ask: gap?.intentText ?? null,
    why: summary.why[0] ?? card.rationale,
    effect,
    gain:
      measured || view.gain.roundTrips > 0
        ? {
            // The token, cost and window savings land with fixes savings.
            windowDays: null,
            roundTrips: view.gain.roundTrips,
            calls: view.gain.calls,
            tokens: null,
            usd: null,
            ms: view.gain.ms,
          }
        : null,
    evidence: strength
      ? {
          strength,
          label: EVIDENCE_LABEL[strength],
          detail: deprecate
            ? `Not called in ${plural(deprecate.windowDays, "day", "days")}`
            : `Seen ${plural(view.support, "time", "times")} in this window`,
        }
      : null,
    copy: { label: "Copy prompt", text: promptFor(view, name) },
    detail,
    measured,
    score: view.gain.occurrences > 0 ? view.gain.occurrences : view.support,
  };
}

/** Pending drafted fixes, each with the tools it touches and the task it composes. */
export function fixSources(
  rows: readonly ToolCraftProposalRow[],
  names: ReadonlyMap<string, string>,
): TaskFixSource[] {
  const name = (id: string) => names.get(id) ?? id;
  return rows.map((row) => {
    const card = cardModel(row);
    const evidence = card.evidence;
    return {
      id: card.id,
      kind: card.kind,
      headline: cardSummary(card, name).suggestion,
      toolIds: row.sourceToolIds,
      workflowId: evidence?.kind === "compose_chain" ? evidence.compose.workflowId : null,
    };
  });
}

/** What one model round trip costs, off a run's day buckets; none without linked model calls. */
export function priceOf(daily: unknown): RoundTripPrice {
  return Array.isArray(daily) && daily.length > 0
    ? roundTripPriceOf(daily as Parameters<typeof roundTripPriceOf>[0])
    : NO_PRICE;
}

fixSeams.loadDrafts = async (projectId, db, { names, price }) => {
  const name = (id: string) => names.get(id) ?? id;
  const rows = await listCraftProposals(
    projectId,
    { statuses: ["pending"], limit: DRAFTS_READ },
    db,
  );
  return rows.map((row) => craftDraft(cardModel(row), name, price));
};

fixSeams.priceOf = priceOf;

tasksSeams.loadDrafts = async (projectId, db, names) =>
  fixSources(
    await listCraftProposals(projectId, { statuses: ["pending"], limit: DRAFTS_READ }, db),
    names,
  );
