import { and, eq, inArray } from "drizzle-orm";
import { toolExplorerRuns } from "@/lib/readings/tool-explorer/schema";
import { craftKey } from "@/lib/synthesis/tool-crafter/craft-key";
import { toPythonStub, toToolJson, toTypeScriptStub } from "@/lib/synthesis/tool-crafter/export";
import { promptFor } from "@/lib/synthesis/tool-crafter/prompt";
import { listCraftProposals } from "@/lib/synthesis/tool-crafter/queries";
import {
  NO_PRICE,
  type RoundTripPrice,
  roundTripPriceOf,
} from "@/lib/synthesis/tool-crafter/round-trip";
import { type ToolCraftProposalRow, toolCraftRuns } from "@/lib/synthesis/tool-crafter/schema";
import {
  changeOf,
  type EffectChip,
  suggestionView,
} from "@/lib/synthesis/tool-crafter/suggestion-model";
import { type CraftCardModel, cardModel, cardSummary } from "@/lib/synthesis/tool-crafter/view";
import { plainChip } from "@/lib/views/fixes/build";
import { EVIDENCE_LABEL, plural, silenceStrength, strengthOf } from "@/lib/views/fixes/copy";
import { type DraftFixInput, fixSeams } from "@/lib/views/fixes/seams";
import type { CraftDetail, EffectReading, FixGain } from "@/lib/views/fixes/types";
import type { TaskFixSource } from "@/lib/views/tasks/model";
import { tasksSeams } from "@/lib/views/tasks/seams";

/**
 * The tool crafter's drafted changes as Fixes and the task pages read them. Loading this module
 * fills the seams `loadFixes` and `loadTasksInputs` read: the pending proposals told as fixes
 * (`fixSeams.loadDrafts`), the days of runs each crafter run measured
 * (`fixSeams.loadDraftWindows`), each task's drafted fixes (`tasksSeams.loadDrafts`) and what one
 * model round trip costs the project (`fixSeams.priceOf`).
 * The telling is upstream's `craftSeed` (`lib/fixes/build.ts`), moved here so the fixes build
 * reads a `DraftFixInput` and never the crafter; the build tells the draft's gain as its effect.
 */

/** Pending drafts read for the page; a project with more has older ones waiting on the next run. */
export const DRAFTS_READ = 200;

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

/**
 * One drafted change, told as the fix the build reads: its worth, evidence, prompt and panel.
 * `windowDays` is the days of runs its crafter run measured (null: unknown, so no rate); a card
 * without the field is read as 30 days.
 */
export function craftDraft(
  card: CraftCardModel & { windowDays?: number | null },
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
  const measured =
    view.gain.roundTrips > 0 ||
    view.gain.ms > 0 ||
    view.gain.calls > 0 ||
    (card.kind === "rewrite_tool" && view.replay?.verdict === "better");
  const gain: FixGain | null = measured
    ? {
        windowDays: card.windowDays === undefined ? 30 : card.windowDays,
        roundTrips: view.gain.roundTrips,
        calls: view.gain.calls,
        tokens: view.gain.tokens === null ? null : view.gain.tokens.input + view.gain.tokens.output,
        usd: view.gain.usd,
        ms:
          view.gain.ms > 0 || (price.ms !== null && view.gain.roundTrips > 0) ? view.gain.ms : null,
      }
    : null;
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
    gain,
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
    worse: view.replay?.verdict === "worse",
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
  // The window is read apart (`loadDraftWindows`); until then a draft has no rate.
  return rows.map((row) => ({
    ...craftDraft({ ...cardModel(row), windowDays: null }, name, price),
    runId: row.runId,
  }));
};

fixSeams.loadDraftWindows = async (projectId, runIds, db) => {
  const rows = await db
    .select({ id: toolCraftRuns.id, windowDays: toolExplorerRuns.windowDays })
    .from(toolCraftRuns)
    .leftJoin(
      toolExplorerRuns,
      and(
        eq(toolExplorerRuns.id, toolCraftRuns.explorerRunId),
        eq(toolExplorerRuns.projectId, projectId),
      ),
    )
    .where(and(eq(toolCraftRuns.projectId, projectId), inArray(toolCraftRuns.id, [...runIds])));
  return new Map(rows.map((row) => [row.id, row.windowDays]));
};

fixSeams.priceOf = priceOf;

tasksSeams.loadDrafts = async (projectId, db, names) =>
  fixSources(
    await listCraftProposals(projectId, { statuses: ["pending"], limit: DRAFTS_READ }, db),
    names,
  );
