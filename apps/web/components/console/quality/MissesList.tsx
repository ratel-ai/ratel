"use client";

import { Badge } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { ToolPin } from "@ratel/design-system/entity";
import { FilterBar, SearchInput } from "@ratel/design-system/filter-bar";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { stepIndex, withPeek } from "@ratel/design-system/peek";
import { EmptyState } from "@ratel/design-system/states";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { ArrowDown, CircleX, FilePenLine, SearchX, SquareArrowOutUpRight } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { formatTimestamp } from "@/lib/synthesis/traces/format";
import { relativeTimeLabel } from "@/lib/views/fixes/relative-time";
import type { MissRow } from "@/lib/views/quality/miss-rows";
import {
  EVIDENCE_LABEL,
  findMissGroup,
  matchesSearch,
  outcomeOf,
} from "@/lib/views/quality/misses";
import { descriptionsHref, plural } from "@/lib/views/quality/model";
import { OutcomeBadge } from "./Outcome";
import { missRows, RankingList } from "./RankingList";
import { TestSearch } from "./TestSearch";

const SEARCH_PARAM = "q";
const OUTCOME_PARAM = "outcome";

type OutcomeFilter = "all" | "missing" | "lower";

function parseOutcome(raw: string | null): OutcomeFilter {
  return raw === "missing" || raw === "lower" ? raw : "all";
}

/**
 * A filter in the URL beside the open row, so a shared link lands on the same
 * list. The control reads local state, so typing never waits on the router's
 * transition to catch up with the address bar.
 */
function useUrlFilter<T extends string>(
  param: string,
  parse: (raw: string | null) => T,
  fallback: T,
): [T, (next: T) => void] {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState<T>(() => parse(searchParams.get(param)));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      window.history.replaceState(
        null,
        "",
        `${pathname}${withPeek(window.location.search, next === fallback ? null : next, param)}`,
      );
    },
    [fallback, param, pathname],
  );
  return [value, set];
}

const identity = (raw: string | null) => raw ?? "";

/**
 * Every search in the window whose right tool was not ranked first, the most
 * frequent first: the ask, the right tool, where it landed (amber when ranked
 * lower, red when not returned) and what came first instead. A row opens the
 * Panel with the ranking it got, how we know, and where to go next.
 */
export function MissesList({
  projectId,
  rows,
  total,
  now,
}: {
  projectId: string;
  rows: readonly MissRow[];
  total: number;
  now: string;
}) {
  const peek = usePeek();
  const [text, setText] = useUrlFilter<string>(SEARCH_PARAM, identity, "");
  const [outcome, setOutcome] = useUrlFilter<OutcomeFilter>(OUTCOME_PARAM, parseOutcome, "all");
  const [lastId, setLastId] = useState<string | null>(null);
  const at = useMemo(() => new Date(now), [now]);

  const counts = useMemo(() => {
    let missing = 0;
    for (const row of rows) if (outcomeOf(row.rank) === "missing") missing += 1;
    return { missing, lower: rows.length - missing };
  }, [rows]);
  const shown = useMemo(
    () =>
      rows.filter(
        (row) =>
          (outcome === "all" || outcomeOf(row.rank) === outcome) &&
          matchesSearch(
            {
              query: row.query,
              rankedFirstName: row.rankedFirst?.name ?? null,
              expectedName: row.expected.name,
            },
            text,
          ),
      ),
    [rows, text, outcome],
  );
  const open = findMissGroup(shown, peek.id);
  const showing = open ?? findMissGroup(rows, lastId);
  const openRow = (id: string) => {
    setLastId(id);
    peek.open(id);
  };
  const step = (direction: 1 | -1) => {
    const index = open ? shown.indexOf(open) : -1;
    const next = shown[stepIndex(index, direction, shown.length)];
    if (next) openRow(next.id);
  };

  const columns: readonly Column<MissRow>[] = [
    {
      id: "query",
      header: "Search",
      className: "w-full max-w-0 min-w-56",
      cell: (row) => <QueryText query={row.query} />,
    },
    {
      id: "expected",
      header: "Right tool",
      width: "24%",
      hiddenBelow: "sm",
      cell: (row) => <ToolPin name={row.expected.name} />,
    },
    {
      id: "outcome",
      header: "Outcome",
      width: "9.5rem",
      cell: (row) => <OutcomeBadge rank={row.rank} />,
    },
    {
      id: "first",
      header: "Ranked first",
      width: "22%",
      hiddenBelow: "lg",
      cell: (row) =>
        row.rankedFirst ? (
          <ToolPin name={row.rankedFirst.name} />
        ) : (
          <span className="text-fg-subtle">Nothing</span>
        ),
    },
    {
      id: "count",
      header: "Times",
      align: "right",
      width: "4.5rem",
      hiddenBelow: "md",
      cell: (row) => row.count.toLocaleString("en-US"),
    },
    {
      id: "seen",
      header: "Last seen",
      align: "right",
      width: "6rem",
      hiddenBelow: "md",
      cell: (row) => (
        <time
          dateTime={row.lastSeen}
          title={formatTimestamp(row.lastSeen)}
          className="whitespace-nowrap text-fg-muted"
        >
          {relativeTimeLabel(new Date(row.lastSeen), at)}
        </time>
      ),
    },
  ];

  const filtered = text !== "" || outcome !== "all";
  return (
    <>
      <FilterBar
        search={
          <SearchInput
            value={text}
            onValueChange={setText}
            placeholder="Search misses…"
            label="Search misses"
          />
        }
        chips={
          <SegmentedControl<OutcomeFilter>
            label="Outcome"
            value={outcome}
            onValueChange={setOutcome}
            options={[
              { value: "all", label: "All" },
              {
                value: "missing",
                label: (
                  <span className="inline-flex items-center gap-1">
                    <CircleX aria-hidden strokeWidth={1.75} className="size-3.5 text-danger" />
                    Not returned{" "}
                    <span className="tabular-nums text-fg-subtle">{counts.missing}</span>
                  </span>
                ),
              },
              {
                value: "lower",
                label: (
                  <span className="inline-flex items-center gap-1">
                    <ArrowDown aria-hidden strokeWidth={1.75} className="size-3.5 text-warning" />
                    Ranked lower <span className="tabular-nums text-fg-subtle">{counts.lower}</span>
                  </span>
                ),
              },
            ]}
          />
        }
        end={
          <span className="text-xs text-fg-subtle tabular-nums">
            {filtered
              ? `${shown.length} of ${plural(total, "miss", "misses")}`
              : plural(total, "miss", "misses")}
            {rows.length < total ? `, ${rows.length} most frequent listed` : ""}
          </span>
        }
      />
      <DataTable
        caption="Searches where the right tool was not ranked first"
        columns={columns}
        rows={shown}
        rowKey={(row) => row.id}
        selectedKey={open?.id ?? null}
        onRowOpen={(row) => openRow(row.id)}
        empty={
          <EmptyState
            icon={SearchX}
            title="No misses match"
            description="Clear the filters to see every miss."
          />
        }
      />
      <Panel
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) peek.close();
        }}
        title={showing ? <QueryText query={showing.query} /> : ""}
        subtitle={showing ? missSubtitle(showing, at) : undefined}
        onPrevious={() => step(-1)}
        onNext={() => step(1)}
      >
        {showing ? <MissDetail projectId={projectId} row={showing} /> : null}
      </Panel>
    </>
  );
}

function missSubtitle(row: MissRow, now: Date): string {
  return `${row.count === 1 ? "Once" : `${row.count.toLocaleString("en-US")} times`} · last ${relativeTimeLabel(new Date(row.lastSeen), now)}`;
}

const EVIDENCE_MEANING: Record<MissRow["evidence"], string> = {
  seen: "Your agent ran this tool for this ask.",
  judged: "A model read the ask against your catalog and named this tool.",
};

/**
 * The Panel body: the right tool and where it landed, how we know, the
 * ranking it got (and the other variant's), and where to go next: test the
 * search, open its run, or fix the tool's description.
 */
export function MissDetail({ projectId, row }: { projectId: string; row: MissRow }) {
  const ours = missRows(row.ours, row.expected, row.rank);
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-ui">
        <dt className="text-fg-subtle">Right tool</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-2">
          <ToolPin name={row.expected.name} />
          <OutcomeBadge rank={row.rank} />
        </dd>
        <dt className="text-fg-subtle">Ranked first</dt>
        <dd className="min-w-0">
          {row.rankedFirst ? (
            <ToolPin name={row.rankedFirst.name} />
          ) : (
            <span className="text-fg-muted">Nothing returned</span>
          )}
        </dd>
        <dt className="self-start pt-0.5 text-fg-subtle">How we know</dt>
        <dd className="flex min-w-0 flex-col items-start gap-1" data-evidence={row.evidence}>
          <Badge>{EVIDENCE_LABEL[row.evidence]}</Badge>
          <span className="text-fg-muted">{EVIDENCE_MEANING[row.evidence]}</span>
        </dd>
      </dl>

      <div className="flex flex-col gap-4">
        <RankingList
          title={row.comparison ? `Ranked by ${row.ours.arm}` : "What your agent saw"}
          badge={row.comparison && row.ours.served ? <Badge>Shown to your agent</Badge> : null}
          rows={ours.rows}
          footer={ours.footer}
        />
        {row.comparison ? (
          <RankingList
            title={`Ranked by ${row.comparison.arm}`}
            badge={row.comparison.served ? <Badge>Shown to your agent</Badge> : null}
            {...missRows(row.comparison, row.expected, row.comparisonRank)}
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TestSearch projectId={projectId} test={row.test} />
        {row.traceHref ? (
          <Link href={row.traceHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            <SquareArrowOutUpRight aria-hidden className="size-3.5" />
            Open trace
          </Link>
        ) : null}
        <Link
          href={descriptionsHref(projectId, { tool: row.expected.id })}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          data-rewrite={row.rewrite ?? "none"}
        >
          <FilePenLine aria-hidden className="size-3.5" />
          {row.rewrite === "pending" ? "Review its rewrite" : "See its description"}
        </Link>
      </div>
    </div>
  );
}

/** The ask as text only: a person's words never go in an attribute. The Panel shows it whole. */
function QueryText({ query }: { query: string | null }) {
  if (query === null) return <span className="text-fg-subtle">Query not recorded</span>;
  return <span className="block truncate">{query}</span>;
}
