import type { ClosedTurnPage, listClosedTurnsPage, TurnCursor } from "@/lib/ledger/closed-turns";

/** Thrown by a walk that ran past its wall-clock budget; the caller marks the run as over budget rather than failed. */
export class TimeBudgetError extends Error {
  constructor() {
    super("time_budget");
    this.name = "TimeBudgetError";
  }
}

export interface TurnWalkOptions {
  pageSize: number;
  /** The budget is measured from here, so a second pass shares the first pass's clock. */
  startedAt: number;
  now: () => Date;
  timeBudgetMs: number;
}

/**
 * The keyset walk Agent health and the Tool Explorer both make: closed turns
 * ending in `range`, a page at a time by `(ended_at, id)`, each page handed to
 * `visit`, under a wall-clock budget checked after every page. Returns the
 * number of pages read.
 */
export async function walkClosedTurnPages(
  listPage: typeof listClosedTurnsPage,
  projectId: string,
  range: { from: Date; to: Date },
  opts: TurnWalkOptions,
  visit: (page: ClosedTurnPage) => Promise<void> | void,
): Promise<number> {
  let pages = 0;
  let after: TurnCursor | null = null;
  for (;;) {
    const page = await listPage(
      projectId,
      { from: range.from, to: range.to, after },
      undefined,
      opts.pageSize,
    );
    pages += 1;
    await visit(page);
    if (opts.now().getTime() - opts.startedAt > opts.timeBudgetMs) throw new TimeBudgetError();
    if (!page.next || page.turns.length < opts.pageSize) return pages;
    after = page.next;
  }
}
