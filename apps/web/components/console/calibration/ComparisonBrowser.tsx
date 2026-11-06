"use client";

import { cn } from "@ratel/design-system/cn";
import { type ReactNode, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { loadComparisonPageAction } from "@/app/(console)/project/[projectId]/calibration/[name]/actions";
import type {
  ComparisonFacet,
  ComparisonFilterSelection,
  ComparisonPage,
  RankingComparisonRowView,
} from "@/lib/synthesis/experiments/calibration-types";
import { createComparisonPageCache } from "@/lib/synthesis/experiments/comparison-cache";
import { playgroundHref } from "@/lib/synthesis/playground/links";
import {
  COMPARISON_PAGE_SIZES,
  type ComparisonBrowserView,
  calibrationSelectionPath,
  comparisonRangeLabel,
  comparisonSearchParams,
  nextOpenComparisonRow,
  toggleComparisonFacet,
} from "@/lib/synthesis/traces/calibration-view";
import { COMPARISON_ROW_GRID, ComparisonRow } from "./ComparisonRow";

type ComparisonContentStatus = "ready" | "loading" | "error";
type ComparisonContentMode = "rows" | "skeleton" | "empty" | "error";

const MISMATCH_FACETS: ReadonlyArray<{
  facet: ComparisonFacet;
  label: string;
  description: string;
}> = [
  {
    facet: "top1",
    label: "Top-1 mismatch",
    description: "The first result differs between served and shadow",
  },
  {
    facet: "order",
    label: "Reordered",
    description: "A result both arms returned sits at a different rank",
  },
  {
    facet: "missing",
    label: "Missing tools",
    description: "Served tools are absent from the shadow results",
  },
  {
    facet: "added",
    label: "Added tools",
    description: "The shadow results contain additional tools",
  },
  {
    facet: "outcome",
    label: "Outcome",
    description: "Served and shadow outcomes differ",
  },
];
const FACET_LABELS = new Map(
  MISMATCH_FACETS.map(({ facet, label }) => [facet, label.toLowerCase()]),
);
/**
 * Telemetry keeps arriving, so a page may only be reused for a minute; the key
 * carries project, experiment, window and filter, so a hit is always the same
 * query. Twenty-four pages covers realistic back-and-forth paging.
 */
const pageCache = createComparisonPageCache<ComparisonPage>({
  ttlMs: 60_000,
  maxEntries: 24,
});

/**
 * Per-request comparison browser. Owns its filter and pagination state so a
 * facet toggle or page step re-reads only the comparison list — the window-wide
 * KPIs above it never change with the filter — and serves pages it already
 * fetched from cache. State is mirrored into the URL with `replaceState` so the
 * view stays shareable without a navigation (and without losing scroll).
 */
export function ComparisonBrowser({
  initialPage,
  initialView,
  projectId,
  experimentName,
  basePath,
  rangeSearch,
}: {
  initialPage: ComparisonPage;
  initialView: ComparisonBrowserView;
  projectId: string;
  experimentName: string;
  basePath: string;
  /** Serialised project/range params the comparison query is scoped to. */
  rangeSearch: string;
}) {
  const [view, setView] = useState(initialView);
  // One row at a time: a list where everything previously clicked is still open
  // stops being scannable, which is the whole job of this table.
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [page, setPage] = useState(initialPage);
  const [failed, setFailed] = useState(false);
  const [animateRows, setAnimateRows] = useState(true);
  const [pending, startTransition] = useTransition();
  const latestRequest = useRef(0);
  const rangeParams = useMemo(() => new URLSearchParams(rangeSearch), [rangeSearch]);
  const search = useMemo(
    () => comparisonSearchParams(rangeParams, view).toString(),
    [rangeParams, view],
  );
  const initialSearch = useMemo(
    () => comparisonSearchParams(new URLSearchParams(rangeSearch), initialView).toString(),
    [rangeSearch, initialView],
  );

  // The server already rendered one page: cache it so coming back to it (or
  // returning from the selection inspector) costs nothing.
  useEffect(() => {
    pageCache.set(cacheKey(projectId, experimentName, initialSearch), initialPage, Date.now());
  }, [projectId, experimentName, initialSearch, initialPage]);

  const pageCount = Math.max(1, Math.ceil(page.total / view.pageSize));

  function show(next: ComparisonBrowserView) {
    const request = ++latestRequest.current;
    const nextSearch = comparisonSearchParams(rangeParams, next).toString();
    setView(next);
    setFailed(false);
    syncUrl(next);
    const key = cacheKey(projectId, experimentName, nextSearch);
    const cached = pageCache.get(key, Date.now());
    if (cached) {
      setAnimateRows(false);
      setPage(cached);
      return;
    }
    startTransition(async () => {
      const loaded = await pageCache
        .load(key, Date.now(), () => loadComparisonPage(projectId, experimentName, nextSearch))
        .catch(() => null);
      if (request !== latestRequest.current) return;
      if (!loaded) {
        setFailed(true);
        return;
      }
      setAnimateRows(true);
      setPage(loaded);
    });
  }

  /** Warm a page the user is about to ask for (hovering a pagination step). */
  function warm(next: ComparisonBrowserView) {
    const nextSearch = comparisonSearchParams(rangeParams, next).toString();
    const key = cacheKey(projectId, experimentName, nextSearch);
    void pageCache
      .load(key, Date.now(), () => loadComparisonPage(projectId, experimentName, nextSearch))
      .catch(() => {});
  }

  const update = (next: Partial<ComparisonBrowserView>) =>
    show(withPage({ ...view, ...next }, next.page ?? 1));
  const status = failed ? "error" : pending ? "loading" : "ready";
  const contentMode = comparisonContentMode(status, page.rows.length);
  const selectionHref = (selectionId: string) =>
    `${calibrationSelectionPath(basePath, experimentName, selectionId)}?${search}`;
  // A row without a query has nothing to reproduce, so it gets no Playground
  // link rather than one that lands on an empty prompt.
  const toPlayground = (row: RankingComparisonRowView) =>
    row.query
      ? playgroundHref(projectId, {
          query: row.query,
          selectionId: row.selectionId,
          experimentName,
        })
      : null;

  return (
    <section
      aria-labelledby="comparison-browser-title"
      className="overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/35"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-forest-300 bg-base-deep/30 px-4 py-2.5">
        <span className="h-px w-5 bg-indigo-300/80" aria-hidden />
        <h2 id="comparison-browser-title" className="eyebrow">
          {selectionTitle(view.selection)}
        </h2>
        <span className="font-mono text-[10px] tabular-nums text-warm-muted/70" aria-live="polite">
          {status === "loading"
            ? "loading…"
            : comparisonRangeLabel(view.offset, page.rows.length, page.total)}
        </span>
        <nav aria-label="Comparison scope" className="ml-auto flex items-center gap-1">
          <FilterButton
            onClick={() => update({ selection: scoped(view.selection, "mismatch") })}
            active={view.selection.scope === "mismatch"}
            label="Mismatches"
          />
          <FilterButton
            onClick={() => update({ selection: scoped(view.selection, "all") })}
            active={view.selection.scope === "all"}
            label="All"
          />
        </nav>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-forest-300/60 bg-forest-600/20 px-4 py-2.5">
        <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted">
          mismatch type
        </span>
        {MISMATCH_FACETS.map((item) => (
          <FilterButton
            key={item.facet}
            onClick={() =>
              update({
                selection: toggleComparisonFacet(view.selection, item.facet),
              })
            }
            active={view.selection.facets.includes(item.facet)}
            label={item.label}
            title={item.description}
          />
        ))}
        <MatchToggle
          selection={view.selection}
          onChange={(match) => update({ selection: { ...view.selection, match } })}
        />
        {view.selection.facets.length > 0 && (
          <button
            type="button"
            onClick={() => update({ selection: { ...view.selection, facets: [] } })}
            className="font-mono text-[10px] uppercase tracking-wide text-warm-muted underline-offset-2 hover:text-cream-dim hover:underline"
          >
            clear
          </button>
        )}
      </div>

      <ComparisonColumnHeader />

      {contentMode === "skeleton" ? (
        <ComparisonRowsSkeleton rows={Math.min(view.pageSize, 8)} />
      ) : contentMode === "error" ? (
        <ErrorState onRetry={() => show({ ...view })} />
      ) : contentMode === "empty" ? (
        <EmptyState
          selection={view.selection}
          onBrowseAll={() => update({ selection: { scope: "all", facets: [], match: "any" } })}
          onClearFacets={() => update({ selection: { ...view.selection, facets: [] } })}
        />
      ) : (
        <div
          aria-busy={status === "loading"}
          className={cn(
            "divide-y divide-forest-300/50 transition-opacity",
            status === "loading" && "pointer-events-none opacity-60",
          )}
        >
          {page.rows.map((row, index) => (
            <ComparisonRow
              key={rowKey(row, index)}
              row={row}
              index={index}
              animate={animateRows}
              href={row.selectionId === null ? null : selectionHref(row.selectionId)}
              playgroundHref={toPlayground(row)}
              open={openRow === rowKey(row, index)}
              onToggle={(next) =>
                // Functional update: the closing row's event arrives after the
                // opening row has been recorded, so the decision has to be made
                // against the freshest state rather than this render's copy.
                setOpenRow((current) => nextOpenComparisonRow(current, rowKey(row, index), next))
              }
            />
          ))}
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-forest-300 bg-base-deep/20 px-4 py-3">
        <nav aria-label="Items per page" className="flex flex-wrap items-center gap-1.5">
          {COMPARISON_PAGE_SIZES.map((size) => (
            <FilterButton
              key={size}
              onClick={() => update({ pageSize: size })}
              active={view.pageSize === size}
              label={`${size} per page`}
            />
          ))}
        </nav>
        <nav
          aria-label="Comparison pagination"
          className="flex items-center gap-2 font-mono text-[10px] text-warm-muted"
        >
          <PaginationButton
            onClick={() => update({ page: view.page - 1 })}
            onWarm={() => warm(withPage(view, view.page - 1))}
            disabled={view.page <= 1}
          >
            ← Previous
          </PaginationButton>
          <span className="min-w-20 text-center tabular-nums">
            Page {view.page} of {pageCount}
          </span>
          <PaginationButton
            onClick={() => update({ page: view.page + 1 })}
            onWarm={() => warm(withPage(view, view.page + 1))}
            disabled={view.page >= pageCount}
          >
            Next →
          </PaginationButton>
        </nav>
      </footer>
    </section>
  );
}

function ComparisonColumnHeader() {
  return (
    <div
      className={cn(
        COMPARISON_ROW_GRID,
        "hidden border-b border-forest-300/50 bg-base-deep/20 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-warm-muted lg:grid",
      )}
    >
      <span>When</span>
      <span>Query</span>
      <span>Served top-1</span>
      <span>Shadow top-1</span>
      <span>Changes</span>
      <span>Latency difference</span>
      <span />
    </div>
  );
}

/** Keep the current page in-flow while the next uncached page is fetched. */
/** Stable per-row identity, for both React keys and the open-row pointer. */
function rowKey(row: RankingComparisonRowView, index: number): string {
  return row.selectionId ?? `${row.occurredAt.getTime()}-${index}`;
}

export function comparisonContentMode(
  status: ComparisonContentStatus,
  rowCount: number,
): ComparisonContentMode {
  if (status === "error") return "error";
  if (rowCount > 0) return "rows";
  return status === "loading" ? "skeleton" : "empty";
}

function cacheKey(projectId: string, experimentName: string, search: string): string {
  return `${projectId}|${experimentName}|${search}`;
}

/**
 * Mirror the browser state into the URL without navigating: a router push would
 * re-render the whole page (resetting scroll) for data this component already
 * has. Untouched params (e.g. `?view=`) are preserved.
 */
function syncUrl(view: ComparisonBrowserView): void {
  const params = comparisonSearchParams(new URLSearchParams(window.location.search), view);
  const next = `${window.location.pathname}?${params.toString()}`;
  if (next !== `${window.location.pathname}${window.location.search}`) {
    window.history.replaceState(null, "", next);
  }
}

async function loadComparisonPage(
  projectId: string,
  experimentName: string,
  search: string,
): Promise<ComparisonPage | null> {
  return loadComparisonPageAction({
    projectId,
    experimentName,
    search: Object.fromEntries(new URLSearchParams(search)),
  });
}

/** Any filter change lands on page 1; only paging keeps the requested page. */
function withPage(view: ComparisonBrowserView, page: number): ComparisonBrowserView {
  const nextPage = Math.max(1, page);
  return {
    ...view,
    page: nextPage,
    offset: (nextPage - 1) * view.pageSize,
  };
}

function scoped(
  selection: ComparisonFilterSelection,
  scope: ComparisonFilterSelection["scope"],
): ComparisonFilterSelection {
  return { ...selection, scope };
}

function selectionTitle(selection: ComparisonFilterSelection): string {
  const base = selection.scope === "all" ? "All comparisons" : "Flagged mismatches";
  if (selection.facets.length === 0) return base;
  const joiner = selection.match === "all" ? " and " : " or ";
  return `${base}: ${selection.facets
    .map((facet) => FACET_LABELS.get(facet) ?? facet)
    .join(joiner)}`;
}

function MatchToggle({
  selection,
  onChange,
}: {
  selection: ComparisonFilterSelection;
  onChange: (match: ComparisonFilterSelection["match"]) => void;
}) {
  const enabled = selection.facets.length > 1;
  return (
    <div
      className={cn(
        "ml-1 flex items-center gap-1 border-l border-forest-300 pl-2.5",
        enabled ? "" : "opacity-40",
      )}
      title={
        enabled
          ? "Combine the selected mismatch types"
          : "Pick two or more mismatch types to combine them"
      }
    >
      <FilterButton
        onClick={() => onChange("any")}
        active={selection.match === "any"}
        disabled={!enabled}
        label="any"
      />
      <FilterButton
        onClick={() => onChange("all")}
        active={selection.match === "all"}
        disabled={!enabled}
        label="all"
      />
    </div>
  );
}

function FilterButton({
  onClick,
  active,
  label,
  title,
  disabled,
}: {
  onClick: () => void;
  active: boolean;
  label: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      className={cn(
        "rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors",
        active
          ? "border-indigo-300/40 bg-indigo-300/10 text-indigo-300"
          : "border-forest-300 text-warm-muted hover:border-indigo-300/30 hover:text-cream-dim",
        disabled && "cursor-not-allowed hover:border-forest-300",
      )}
    >
      {label}
    </button>
  );
}

function PaginationButton({
  onClick,
  onWarm,
  disabled,
  children,
}: {
  onClick: () => void;
  onWarm: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  if (disabled) {
    return (
      <span className="rounded-md border border-forest-300/50 px-2.5 py-1.5 text-warm-muted/40">
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerEnter={onWarm}
      onFocus={onWarm}
      className="rounded-md border border-forest-300 px-2.5 py-1.5 text-cream-dim transition-colors hover:border-indigo-300/35 hover:bg-indigo-300/10 hover:text-indigo-300"
    >
      {children}
    </button>
  );
}

function ComparisonRowsSkeleton({ rows }: { rows: number }) {
  return (
    <div className="divide-y divide-forest-300/50" role="status" aria-busy="true">
      <span className="sr-only">Loading comparisons…</span>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className={cn(COMPARISON_ROW_GRID, "py-2")} aria-hidden>
          {[68, 92, 78, 78, 60, 82, 24].map((width, cell) => (
            <div key={cell} className="flex flex-col gap-1.5">
              <div
                className="h-3 animate-pulse rounded bg-forest-300/35"
                style={{
                  width: `${width}%`,
                  animationDelay: `${index * 55 + cell * 20}ms`,
                }}
              />
              {cell === 0 && (
                <div
                  className="h-2.5 w-2/5 animate-pulse rounded bg-forest-300/20"
                  style={{ animationDelay: `${index * 55 + 40}ms` }}
                />
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="px-6 py-10 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-coral">
        Comparisons unavailable
      </div>
      <p className="mx-auto mt-2 max-w-md text-pretty text-sm leading-relaxed text-warm-muted">
        This filter could not be loaded.{" "}
        <button
          type="button"
          onClick={onRetry}
          className="text-indigo-300 underline-offset-2 hover:underline"
        >
          Try again
        </button>
        .
      </p>
    </div>
  );
}

function EmptyState({
  selection,
  onBrowseAll,
  onClearFacets,
}: {
  selection: ComparisonFilterSelection;
  onBrowseAll: () => void;
  onClearFacets: () => void;
}) {
  return (
    <div className="px-6 py-10 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-warm-muted">
        No comparisons
      </div>
      <p className="mx-auto mt-2 max-w-md text-pretty text-sm leading-relaxed text-warm-muted">
        {selection.facets.length > 0 ? (
          <>
            No comparison matched {selection.match === "all" ? "all" : "any"} of the selected
            mismatch types.{" "}
            <button
              type="button"
              onClick={onClearFacets}
              className="text-indigo-300 underline-offset-2 hover:underline"
            >
              Clear the mismatch types
            </button>
            .
          </>
        ) : selection.scope === "mismatch" ? (
          <>
            Both arms returned the same ranking for every comparison in this window.{" "}
            <button
              type="button"
              onClick={onBrowseAll}
              className="text-indigo-300 underline-offset-2 hover:underline"
            >
              Browse all comparisons
            </button>
            .
          </>
        ) : (
          "No comparison records arrived in this window."
        )}
      </p>
    </div>
  );
}
