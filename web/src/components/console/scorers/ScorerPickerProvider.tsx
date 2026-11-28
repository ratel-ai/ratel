"use client";

import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import type { PickerScorer, ScorerPickerData } from "@/lib/views/scorers/picker";

/** What every picker of a surface reads: the scorers with the ones saved here, and a way to add one. */
export interface ScorerPickerState {
  projectId: string;
  data: ScorerPickerData;
  /** A scorer saved in a Panel: it shows at once, before the page's next read. */
  keep: (scorer: PickerScorer) => void;
}

const ScorerPickerContext = createContext<ScorerPickerState | null>(null);

/** The one scorer list of a surface. */
export function ScorerPickerProvider({
  projectId,
  data,
  children,
}: {
  projectId: string;
  data: ScorerPickerData;
  children: ReactNode;
}) {
  const [kept, setKept] = useState<readonly PickerScorer[]>([]);
  const state = useMemo<ScorerPickerState>(
    () => ({
      projectId,
      data: withKept(data, kept),
      keep: (scorer) =>
        setKept((current) => [...current.filter(({ id }) => id !== scorer.id), scorer]),
    }),
    [projectId, data, kept],
  );
  return <ScorerPickerContext value={state}>{children}</ScorerPickerContext>;
}

/** The surface's picker state; null outside a `ScorerPickerProvider`. */
export function useScorerPicker(): ScorerPickerState | null {
  return useContext(ScorerPickerContext);
}

/** The surface's scorers, the ones saved here included; null outside a `ScorerPickerProvider`. */
export function useScorers(): readonly PickerScorer[] | null {
  return useScorerPicker()?.data.scorers ?? null;
}

/**
 * The page's read, with the scorers saved since. A kept one wins until the page reads it again with
 * the change (its name), and a new one comes last until the page reads it.
 */
function withKept(data: ScorerPickerData, kept: readonly PickerScorer[]): ScorerPickerData {
  if (kept.length === 0) return data;
  const read = new Map(data.scorers.map((scorer) => [scorer.id, scorer]));
  const byId = new Map(
    kept.flatMap((scorer) => {
      const fresh = read.get(scorer.id);
      return fresh && fresh.name === scorer.name && fresh.summary === scorer.summary
        ? []
        : [[scorer.id, scorer] as const];
    }),
  );
  const added = kept.filter(({ id }) => !read.has(id));
  return {
    ...data,
    scorers: [...data.scorers.map((scorer) => byId.get(scorer.id) ?? scorer), ...added],
    count: data.count + added.length,
  };
}
