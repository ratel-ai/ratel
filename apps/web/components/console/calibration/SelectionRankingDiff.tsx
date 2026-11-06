"use client";

import { cn } from "@ratel/design-system/cn";
import { useState } from "react";
import { diffRankings, type RankingDiffEntry } from "@/lib/synthesis/experiments/ranking";

const CHANGE_CLASSES: Record<RankingDiffEntry["change"], string> = {
  stable: "border-forest-300 bg-forest/30 text-cream-dim",
  moved: "border-indigo-300/35 bg-indigo-300/10 text-indigo-300",
  dropped: "border-coral/35 bg-coral/10 text-coral",
  added: "border-green/30 bg-green/10 text-green",
};

/**
 * Side-by-side ranked lists for one selection: what the serving arm returned
 * versus what the shadow arm would have returned, with per-id movement.
 */
export function SelectionRankingDiff({
  servedArm,
  shadowArm,
  servedResultIds,
  shadowResultIds,
  servedResultScores,
  shadowResultScores,
}: {
  servedArm: string | null;
  shadowArm: string | null;
  servedResultIds: string[] | null;
  shadowResultIds: string[] | null;
  servedResultScores: number[] | null;
  shadowResultScores: number[] | null;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);

  if (servedResultIds === null || shadowResultIds === null) {
    return (
      <section className="rounded-2xl border border-dashed border-forest-300 bg-forest-600/20 px-6 py-8 text-center">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-warm-muted">
          Rankings unavailable
        </div>
        <p className="mx-auto mt-2 max-w-md text-pretty text-sm leading-relaxed text-warm-muted">
          One or both arms did not export a{" "}
          <code className="font-mono text-cream-dim">ratel.experiment.results</code> record for this
          selection, so the ranked lists cannot be compared item by item.
        </p>
      </section>
    );
  }

  const entries = diffRankings(servedResultIds, shadowResultIds);
  const servedEntries = entries
    .filter((entry) => entry.servedRank !== null)
    .sort((left, right) => left.servedRank! - right.servedRank!);
  const shadowEntries = entries
    .filter((entry) => entry.shadowRank !== null)
    .sort((left, right) => left.shadowRank! - right.shadowRank!);

  return (
    <section aria-label="Ranking diff" className="grid gap-3 lg:grid-cols-2">
      <RankingColumn
        title={servedArm ?? "served"}
        role="served"
        entries={servedEntries}
        scores={servedResultScores}
        activeId={activeId}
        setActiveId={setActiveId}
      />
      <RankingColumn
        title={shadowArm ?? "shadow"}
        role="shadow"
        entries={shadowEntries}
        scores={shadowResultScores}
        activeId={activeId}
        setActiveId={setActiveId}
      />
    </section>
  );
}

function RankingColumn({
  title,
  role,
  entries,
  scores,
  activeId,
  setActiveId,
}: {
  title: string;
  role: "served" | "shadow";
  entries: RankingDiffEntry[];
  scores: number[] | null;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
}) {
  return (
    <article className="overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/45">
      <header className="flex items-center gap-3 border-b border-forest-300 bg-base-deep/30 px-4 py-3">
        <span
          className={cn("size-2 rounded-full", role === "served" ? "bg-coral" : "bg-indigo-300")}
          aria-hidden
        />
        <h3
          className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-cream"
          title={title}
        >
          {title}
        </h3>
        <span className="rounded-md border border-forest-300 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-warm-muted">
          {role}
        </span>
      </header>

      {entries.length === 0 ? (
        <p className="px-4 py-6 text-center font-mono text-[10px] text-warm-muted">
          empty result list
        </p>
      ) : (
        <ol className="divide-y divide-forest-300/50">
          {entries.map((entry, index) => (
            <li
              key={entry.id}
              tabIndex={0}
              data-ranking-id={entry.id}
              onPointerEnter={() => setActiveId(entry.id)}
              onPointerLeave={() => setActiveId(null)}
              onFocus={() => setActiveId(entry.id)}
              onBlur={() => setActiveId(null)}
              className={cn(
                "flex items-center gap-3 px-4 py-2.5 outline-none transition-[background-color,opacity,transform] duration-200 motion-reduce:transform-none motion-reduce:transition-none",
                activeId === entry.id && "relative z-10 translate-x-0.5 bg-indigo-300/10",
                activeId !== null && activeId !== entry.id && "opacity-35 saturate-50",
              )}
            >
              <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-warm-muted">
                {index + 1}
              </span>
              <span
                className={cn(
                  "inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs",
                  CHANGE_CLASSES[entry.change],
                  activeId === entry.id &&
                    "border-indigo-300/70 shadow-[0_0_0_1px_rgb(165_180_252_/_0.22),0_0_18px_rgb(165_180_252_/_0.15)]",
                )}
                title={changeTitle(entry)}
              >
                <span className="truncate">{entry.id}</span>
                {entry.change === "moved" && (
                  <span className="shrink-0 tabular-nums opacity-80">
                    #{entry.servedRank}→#{entry.shadowRank}
                  </span>
                )}
                {entry.change !== "moved" && entry.change !== "stable" && (
                  <span className="shrink-0 uppercase tracking-wide opacity-80">
                    {entry.change}
                  </span>
                )}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-warm-muted">
                {scoreAt(scores, index)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

function changeTitle(entry: RankingDiffEntry): string {
  switch (entry.change) {
    case "stable":
      return "Same rank on both arms";
    case "moved":
      return `Served #${entry.servedRank}, shadow #${entry.shadowRank}`;
    case "dropped":
      return "Returned by the served arm only";
    case "added":
      return "Returned by the shadow arm only";
  }
}

function scoreAt(scores: number[] | null, index: number): string {
  const value = scores?.[index];
  return value === undefined ? "" : value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}
