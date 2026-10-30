"use client";

import { DotLoader } from "@ratel/design-system/dot-matrix";
import type { RankMode } from "@/lib/synthesis/playground/types";

/** What a run in flight looks like. */
export function ResultsSkeleton({
  mode,
  hasEdits,
  recordedArms = 0,
}: {
  mode: RankMode;
  hasEdits: boolean;
  /** Recorded arm columns the finished results will carry, so widths match. */
  recordedArms?: number;
}) {
  const columns = recordedArms + 1 + (hasEdits ? 1 : 0);
  return (
    <section
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="flex flex-col overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/35"
    >
      <span className="sr-only">Testing the prompt against your catalog…</span>

      <header className="flex items-center gap-3 border-b border-forest-300 bg-base-deep/30 px-4 py-2.5">
        <span className="shrink-0" aria-hidden>
          <DotLoader />
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-xs text-cream">
            {mode === "bm25"
              ? "Ranking against your catalog"
              : "Embedding the prompt and your catalog"}
          </span>
          <span
            className="relative mt-1.5 block h-1 overflow-hidden rounded-full bg-forest-300/40"
            aria-hidden
          >
            <span className="analyze-scan-fill" />
          </span>
        </div>
      </header>

      <div aria-hidden className="flex flex-col gap-5 p-4 motion-safe:animate-pulse">
        <BucketSkeleton label="Skills" rows={3} columns={columns} />
        <BucketSkeleton label="Tools" rows={4} columns={columns} />
      </div>
    </section>
  );
}

function BucketSkeleton({
  label,
  rows,
  columns,
}: {
  label: string;
  rows: number;
  columns: number;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 border-b border-forest-300/50 pb-1.5">
        <span className="text-sm font-medium text-cream">{label}</span>
        <span className="h-2.5 w-16 rounded bg-forest-300/40" />
      </div>
      <div
        className="grid gap-2 sm:gap-3"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: columns }, (_, index) => index).map((column) => (
          <div key={column}>
            <div className="mb-1.5 h-8 px-1">
              <div className="h-2.5 w-16 rounded bg-forest-300/40" />
              <div className="mt-1.5 h-2 w-20 rounded bg-forest-300/25" />
            </div>
            <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-forest-300/70">
              {Array.from({ length: rows }, (_, index) => index).map((row) => (
                <div key={row} className="bg-base-deep/35 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-3 rounded bg-forest-300/45" />
                    <div
                      className="h-2.5 rounded bg-forest-300/50"
                      style={{ width: `${58 - row * 9}%` }}
                    />
                    <div className="ml-auto h-2.5 w-8 rounded bg-forest-300/35" />
                  </div>
                  {columns <= 2 && (
                    <div
                      className="mt-1.5 ml-5 h-2 rounded bg-forest-300/25"
                      style={{ width: `${76 - row * 6}%` }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
