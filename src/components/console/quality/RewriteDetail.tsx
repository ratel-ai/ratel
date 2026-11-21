"use client";

import { cn } from "@ratel/design-system/cn";
import { CopyButton } from "@ratel/design-system/code";
import { Skeleton } from "@ratel/design-system/states";
import { ArrowDownRight, ArrowRight, ArrowUpRight, SquarePen } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import {
  type RewriteSearch,
  rewriteSearchesAction,
} from "@/app/(console)/project/[projectId]/improvement/match-quality/actions";
import type { RewriteEffect, RewriteRow } from "@/lib/views/quality/descriptions";
import { plural } from "@/lib/views/quality/model";
import { searchTest } from "@/lib/views/quality/test-search";
import { FoundMeter } from "./FoundMeter";
import { TestSearch } from "./TestSearch";

/**
 * One rewrite in the Panel: what the replay says it does for its tool, the
 * searchable description now and rewritten (the change marked in each), the
 * searches it missed (read when the panel opens: they are people's asks), and
 * the actions. The description is edited in Catalog; Apply writes this text
 * through Match quality's own action.
 */
export function RewriteDetail({
  projectId,
  row,
  experimentName,
  catalogHref,
  actions,
  caveat = null,
}: {
  projectId: string;
  row: RewriteRow;
  /** The experiment its searches came from, so "Test this search" goes by ids. */
  experimentName: string | null;
  catalogHref: string;
  actions: ReactNode;
  /** Said beside the actions when an applied rewrite may not reach the agent yet. */
  caveat?: string | null;
}) {
  return (
    <div className="flex flex-col gap-6" data-rewrite={row.id}>
      <ReplayEffect toolName={row.toolName} effect={row.effect} />
      <BeforeAfter row={row} />
      <MissedSearches projectId={projectId} rewriteId={row.id} experimentName={experimentName} />
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        {caveat ? (
          <p className="flex items-start gap-2 text-xs text-fg-muted" data-caveat="runtime">
            <span aria-hidden className="mt-1 size-1.5 shrink-0 rounded-full bg-warning" />
            {caveat}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={catalogHref}
            className="mr-auto inline-flex items-center gap-1 rounded-md text-ui text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
          >
            <SquarePen aria-hidden className="size-3.5" />
            Edit in Catalog
          </Link>
          {actions}
        </div>
      </div>
    </div>
  );
}

/** "Found in 15 of 15", the meter, and the change in points. */
function ReplayEffect({ toolName, effect }: { toolName: string; effect: RewriteEffect | null }) {
  if (!effect) {
    return (
      <p className="text-ui text-fg-subtle" data-effect="none">
        Not replayed yet. The next analysis replays it on past searches.
      </p>
    );
  }
  const tool = effect.tool;
  return (
    <section
      className="flex flex-col gap-2"
      aria-label="Found in a replay of past searches"
      data-effect={effect.direction}
    >
      <h3 className="text-xs font-medium text-fg-subtle">Found in a replay of past searches</h3>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {tool ? (
          <span className="text-2xl font-semibold tracking-tight text-fg tabular-nums">
            {tool.after}
            <span className="text-base font-medium text-fg-subtle"> of {tool.n}</span>
          </span>
        ) : null}
        <EffectDelta effect={effect} size="md" />
        {tool ? (
          <span className="text-xs text-fg-subtle tabular-nums">was {tool.before}</span>
        ) : null}
      </div>
      {tool ? (
        <FoundMeter
          n={tool.n}
          before={tool.before}
          after={tool.after}
          label={`${toolName} found in ${tool.after} of ${tool.n} past searches with the rewrite, ${tool.before} without it`}
        />
      ) : null}
    </section>
  );
}

/** "+60 pts" with its arrow, green when the tool is found more often. */
export function EffectDelta({
  effect,
  size = "sm",
}: {
  effect: RewriteEffect;
  size?: "sm" | "md";
}) {
  const Icon =
    effect.direction === "up"
      ? ArrowUpRight
      : effect.direction === "down"
        ? ArrowDownRight
        : ArrowRight;
  const tone =
    effect.direction === "up"
      ? "text-success"
      : effect.direction === "down"
        ? "text-danger"
        : "text-fg-subtle";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 font-medium tabular-nums",
        size === "md" ? "text-sm" : "text-ui",
        tone,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {effect.delta}
    </span>
  );
}

/** The searchable description now, with what goes struck through, and rewritten, with what is new marked. */
function BeforeAfter({ row }: { row: RewriteRow }) {
  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-1.5" aria-label="Searchable description now">
        <h3 className="text-xs font-medium text-fg-subtle">Now</h3>
        <p
          className="rounded-lg border border-line px-3 py-2.5 text-sm leading-6 text-fg-muted"
          data-before
        >
          {row.spans.map((span, index) =>
            span.op === "added" ? null : span.op === "removed" ? (
              <del key={index} className="text-fg-faint decoration-danger/60">
                {span.text}
              </del>
            ) : (
              <span key={index}>{span.text}</span>
            ),
          )}
        </p>
      </section>
      <section className="flex flex-col gap-1.5" aria-label="Searchable description rewritten">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 text-xs font-medium text-fg-subtle">Rewrite</h3>
          <CopyButton text={row.after} label="Copy the new description" />
        </div>
        <p
          className="rounded-lg border border-line bg-raised px-3 py-2.5 text-sm leading-6 text-fg-muted"
          data-after
        >
          {row.spans.map((span, index) =>
            span.op === "removed" ? null : span.op === "added" ? (
              <ins key={index} className="rounded-sm bg-success-subtle px-0.5 text-fg no-underline">
                {span.text}
              </ins>
            ) : (
              <span key={index}>{span.text}</span>
            ),
          )}
        </p>
        <p className="text-ui text-fg-muted">{row.rationale}</p>
      </section>
    </div>
  );
}

export type SearchesState =
  | { status: "loading" }
  | { status: "ready"; searches: RewriteSearch[]; more: number }
  | { status: "failed"; message: string };

/**
 * The searches this rewrite was drafted from, read once the panel is open. An
 * answer belongs to the rewrite it was read for, so stepping to the next one
 * shows it loading until its own answer lands.
 */
function MissedSearches({
  projectId,
  rewriteId,
  experimentName,
}: {
  projectId: string;
  rewriteId: string;
  experimentName: string | null;
}) {
  const [answer, setAnswer] = useState<{ rewriteId: string; state: SearchesState } | null>(null);
  useEffect(() => {
    let current = true;
    const settle = (state: SearchesState) => {
      if (current) setAnswer({ rewriteId, state });
    };
    rewriteSearchesAction(projectId, rewriteId).then(
      (result) =>
        settle(
          result.ok
            ? { status: "ready", searches: result.searches ?? [], more: result.more ?? 0 }
            : { status: "failed", message: result.message ?? "Couldn't load the searches." },
        ),
      () =>
        settle({ status: "failed", message: "Couldn't load the searches. Try again in a moment." }),
    );
    return () => {
      current = false;
    };
  }, [projectId, rewriteId]);
  const state: SearchesState =
    answer?.rewriteId === rewriteId ? answer.state : { status: "loading" };
  return <MissedSearchesList projectId={projectId} state={state} experimentName={experimentName} />;
}

/** The list itself, for each state of the read. */
export function MissedSearchesList({
  projectId,
  state,
  experimentName,
}: {
  projectId: string;
  state: SearchesState;
  experimentName: string | null;
}) {
  return (
    <section
      className="flex flex-col gap-1.5"
      aria-label="Searches it missed"
      aria-busy={state.status === "loading"}
    >
      <h3 className="text-xs font-medium text-fg-subtle">Searches it missed</h3>
      {state.status === "loading" ? (
        <ul
          aria-hidden
          className="divide-y divide-line overflow-hidden rounded-lg border border-line"
        >
          {[0, 1, 2].map((index) => (
            <li key={index} className="flex min-h-9 items-center px-3">
              <Skeleton className="h-3 w-2/3" />
            </li>
          ))}
        </ul>
      ) : state.status === "failed" ? (
        <p role="alert" className="text-ui text-fg-muted">
          {state.message}
        </p>
      ) : state.searches.length === 0 ? (
        <p className="text-ui text-fg-subtle">No search with its words recorded.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {state.searches.map((search, index) => (
            <li
              key={`${search.selectionId ?? "search"}-${index}`}
              className="flex min-h-9 items-center gap-2 px-3 py-1"
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-ui",
                  search.query ? "text-fg" : "text-fg-subtle",
                )}
              >
                {search.query ?? "Query not recorded"}
              </span>
              <TestSearch
                projectId={projectId}
                test={searchTest({ ...search, experimentName })}
                variant="icon"
              />
            </li>
          ))}
          {state.more > 0 ? (
            <li className="px-3 py-1.5 text-xs text-fg-subtle">
              And {plural(state.more, "more search", "more searches")}
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}
