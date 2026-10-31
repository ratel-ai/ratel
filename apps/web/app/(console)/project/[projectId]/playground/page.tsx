import { notFound } from "next/navigation";
import type { SelectionContext } from "@/components/console/playground/CalibrationBanner";
import { PlaygroundWorkbench } from "@/components/console/playground/PlaygroundWorkbench";
import { requireProjectScope } from "@/components/console/settings/project-scope";
import { composition } from "@/lib/composition/ports";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import type { SelectionDetail } from "@/lib/synthesis/experiments/calibration-types";
import {
  buildSelectionRankingView,
  selectionQuery,
} from "@/lib/synthesis/experiments/selection-view";
import type { RecordedArm } from "@/lib/synthesis/playground/calibration-compare";
import { loadBench } from "@/lib/synthesis/playground/catalog";
import { embeddingsConfigured } from "@/lib/synthesis/playground/embed";
import { loadSuggestedPrompts, type SuggestedPrompt } from "@/lib/synthesis/playground/prompts";
import { getSelectionDetail } from "@/lib/synthesis/traces/experiment-calibration-queries";

export const metadata = { title: "Test a search" };

type SearchParams = {
  q?: string | string[];
  /** A recorded selection to carry in as context. */
  selection?: string | string[];
  experiment?: string | string[];
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Telemetry window the prompt picker draws from: the last 30 days. */
function suggestionWindow(): { since: Date; until: Date } {
  const until = new Date();
  return { since: new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000), until };
}

/**
 * Re-rank a prompt against this project's live catalog with the SDK's own engine, with what-if
 * edits to skill and tool descriptions.
 */
export default async function TestSearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  if (!isDbConfigured()) notFound();
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const { project } = await requireProjectScope(projectId);

  const selectionId = first(query.selection);
  // The picker is a convenience; a failing telemetry read must not stop a typed prompt.
  const [bench, suggestions, selection] = await Promise.all([
    loadBench(project.id, { includeSyncedTools: true }),
    loadOrFallback({
      operation: "playground_suggested_prompts",
      distinctId: `project:${project.id}`,
      fallback: [] as SuggestedPrompt[],
      load: () =>
        withStatementTimeout((db) =>
          loadSuggestedPrompts({ projectId: project.id, window: suggestionWindow(), db }),
        ),
    }),
    selectionId
      ? loadOrFallback({
          operation: "playground_selection_context",
          distinctId: `project:${project.id}`,
          fallback: null as SelectionDetail | null,
          load: () => withStatementTimeout((db) => getSelectionDetail(project.id, selectionId, db)),
        })
      : Promise.resolve(null),
  ]);

  const ranking = selection ? buildSelectionRankingView(selection.records) : null;
  const arms: RecordedArm[] = [
    ...(ranking?.servedArm && ranking.servedResultIds
      ? [
          {
            arm: ranking.servedArm,
            role: "served" as const,
            resultIds: ranking.servedResultIds,
            resultScores: ranking.servedResultScores,
          },
        ]
      : []),
    ...(ranking?.shadowArm && ranking.shadowResultIds
      ? [
          {
            arm: ranking.shadowArm,
            role: "shadow" as const,
            resultIds: ranking.shadowResultIds,
            resultScores: ranking.shadowResultScores,
          },
        ]
      : []),
  ];
  // The recorded query is what the variants belong to; `q` only prefills the box.
  const recordedQuery = selection ? (selectionQuery(selection.records) ?? "") : "";
  const carriedQuery = first(query.q) ?? recordedQuery;
  const selectionContext: SelectionContext | null =
    selection && selectionId
      ? {
          selectionId,
          experimentName: first(query.experiment) ?? null,
          query: recordedQuery || carriedQuery,
          arms,
          exactOrder: ranking?.exactOrder ?? null,
        }
      : null;

  return (
    <PlaygroundWorkbench
      // The workbench seeds its state from these props on mount; a new deep link starts it over.
      key={`${selectionId ?? ""} ${carriedQuery}`}
      projectId={project.id}
      projectSlug={project.slug}
      bench={bench}
      initialQuery={carriedQuery}
      suggestions={suggestions}
      embeddingsEnabled={embeddingsConfigured(composition.embeddingProvider)}
      canSaveSearchableDescription
      selectionContext={selectionContext}
    />
  );
}
