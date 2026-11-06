"use client";

import { cn } from "@ratel/design-system/cn";
import {
  comparisonColumns,
  type KindById,
  type RecordedArm,
  reproducesShadow,
  unresolvedIds,
} from "@/lib/synthesis/playground/calibration-compare";
import type { RankResponse } from "@/lib/synthesis/playground/contract";
import type { BucketDiff } from "@/lib/synthesis/playground/run";
import type {
  CapabilityKind,
  RankedBuckets,
  RankedHit,
  RankMode,
} from "@/lib/synthesis/playground/types";
import { droppedIds, emptyBucketReason } from "@/lib/synthesis/playground/view";
import { BucketColumns, DroppedNotice } from "./BucketColumns";
import { CalibrationBanner, type SelectionContext, UnresolvedNotice } from "./CalibrationBanner";
import { KindIcon } from "./icons";
import { ResultsSkeleton } from "./ResultsSkeleton";

/** What the run returned: */
export function ResultsPanel({
  response,
  mode,
  population,
  pending,
  hasEdits,
  selectionContext,
  kindById,
  backHref,
  onEdit,
}: {
  response: RankResponse | null;
  mode: RankMode;
  population: { skills: number; tools: number };
  pending: boolean;
  /** Drives the skeleton's column count, so the layout does not jump on arrival. */
  hasEdits: boolean;
  /** Present when the Playground was opened from a Calibration mismatch. */
  selectionContext: SelectionContext | null;
  /** Every catalog id's kind, so a recorded arm's mixed list can be split. */
  kindById: KindById;
  backHref: string | null;
  /** Opens a capability's editor on the bench. */
  onEdit: (id: string) => void;
}) {
  if (pending) {
    return (
      <ResultsSkeleton
        mode={mode}
        hasEdits={hasEdits}
        recordedArms={selectionContext?.arms.length ?? 0}
      />
    );
  }

  if (!response) {
    return (
      <section className="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-forest-300 bg-forest-600/20 px-6 py-10">
        <p className="max-w-xs text-center text-sm leading-relaxed text-warm-muted">
          Test a prompt to see what an agent would find.
        </p>
      </section>
    );
  }

  const { run } = response;
  const arms: readonly RecordedArm[] = selectionContext?.arms ?? [];
  const unresolved = selectionContext ? unresolvedIds(arms, kindById) : [];
  const collapseShadow = reproducesShadow(arms, run.baseline)?.sameOrder === true;

  return (
    <section
      aria-labelledby="playground-results-title"
      className="card-enter flex flex-col overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/35"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-forest-300 bg-base-deep/30 px-4 py-2.5">
        <span className="h-px w-5 bg-indigo-300/80" aria-hidden />
        <h2 id="playground-results-title" className="eyebrow">
          Results
        </h2>
        {response.embedding?.local ? (
          <span
            className="ml-auto rounded border border-ctx-tools/30 px-1.5 py-0.5 font-mono text-[10px] text-ctx-tools"
            title="No embedding model is configured, so vectors came from the local hashing stand-in. These scores are much cruder than a real model's. Set OPENAI_API_KEY for a trained one."
          >
            local embeddings
          </span>
        ) : (
          response.embedding && (
            <span
              className="ml-auto font-mono text-[10px] tabular-nums text-warm-muted"
              title="Texts sent to the embedding provider for this run, and how many came from cache."
            >
              {response.embedding.embeddedCount} embedded · {response.embedding.cachedCount} cached
            </span>
          )
        )}
      </header>

      {selectionContext && (
        <CalibrationBanner context={selectionContext} saved={run.baseline} backHref={backHref} />
      )}

      <div className="flex flex-col gap-5 p-4">
        {unresolved.length > 0 && <UnresolvedNotice ids={unresolved} />}
        <Bucket
          kind="skill"
          label="Skills"
          mode={mode}
          arms={arms}
          baseline={run.baseline}
          drafted={run.hasEdits ? run.drafted : null}
          diff={run.diff.skills}
          kindById={kindById}
          collapseShadow={collapseShadow}
          population={population.skills}
          onEdit={onEdit}
        />
        <Bucket
          kind="tool"
          label="Tools"
          mode={mode}
          arms={arms}
          baseline={run.baseline}
          drafted={run.hasEdits ? run.drafted : null}
          diff={run.diff.tools}
          kindById={kindById}
          collapseShadow={collapseShadow}
          population={population.tools}
          onEdit={onEdit}
        />
      </div>
    </section>
  );
}

function byId(hits: readonly RankedHit[]): Map<string, RankedHit> {
  return new Map(hits.map((hit) => [hit.id, hit]));
}

function Bucket({
  kind,
  label,
  mode,
  arms,
  baseline,
  drafted,
  diff,
  kindById,
  collapseShadow,
  population,
  onEdit,
}: {
  kind: CapabilityKind;
  label: string;
  mode: RankMode;
  arms: readonly RecordedArm[];
  baseline: RankedBuckets;
  /** Null when nothing is edited. */
  drafted: RankedBuckets | null;
  diff: BucketDiff;
  kindById: KindById;
  collapseShadow: boolean;
  population: number;
  onEdit: (id: string) => void;
}) {
  const bucket = kind === "skill" ? "skills" : "tools";
  const columns = comparisonColumns({
    arms,
    saved: baseline,
    edited: drafted,
    kind,
    kindById,
    collapseShadow,
  });
  const edits = columns.find((column) => column.key === "edited");

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 border-b border-forest-300/50 pb-1.5">
        <KindIcon kind={kind} className="size-3.5 text-warm-muted" />
        <h3 className="text-sm font-medium text-cream">{label}</h3>
        <span className="font-mono text-[10px] tabular-nums text-warm-muted">
          {population} in catalog
        </span>
        {edits && (
          <span
            className={cn(
              "ml-auto font-mono text-[10px] tabular-nums",
              edits.changed > 0 ? "text-coral" : "text-warm-muted",
            )}
          >
            {edits.changed > 0
              ? `your edits moved ${edits.changed}`
              : "your edits changed nothing here"}
          </span>
        )}
      </div>

      <BucketColumns
        columns={columns}
        hitsByColumn={{
          now: byId(baseline[bucket]),
          ...(drafted ? { edited: byId(drafted[bucket]) } : {}),
        }}
        emptyReason={emptyBucketReason(baseline[bucket], population, mode)}
        onEdit={onEdit}
      />
      {drafted && <DroppedNotice ids={droppedIds(diff.entries)} />}
    </div>
  );
}
