import { Badge } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { ToolPin } from "@ratel/design-system/entity";
import { ArrowDown, CircleCheck, CircleX } from "lucide-react";
import type { ReactNode } from "react";
import type { DiffItem } from "@/lib/views/quality/experiments";
import type { RankedListView, ToolRef } from "@/lib/views/quality/miss-rows";
import { type Outcome, ordinal } from "@/lib/views/quality/misses";

/**
 * One ranked list of tools, as a search returned it, every tool a pin. The
 * ranking diff in both panels is one or two of these side by side: what was
 * first, where the right tool sat (green when first, amber when lower, red
 * when missing), and what the other variant did differently.
 */

export interface RankedRow {
  key: string;
  rank: number;
  name: string;
  /** The right tool's row: colored by where it landed. */
  outcome?: Exclude<Outcome, "missing">;
  trailing?: ReactNode;
}

const OUTCOME_ROW: Record<Exclude<Outcome, "missing">, string> = {
  first: "bg-success-subtle",
  lower: "bg-warning-subtle",
};

export function RankingList({
  title,
  badge,
  rows,
  footer,
  empty = "Nothing returned",
}: {
  title: ReactNode;
  badge?: ReactNode;
  rows: readonly RankedRow[];
  footer?: ReactNode;
  empty?: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-h-5 items-center gap-2">
        <h3 className="min-w-0 truncate text-xs font-medium text-fg-subtle">{title}</h3>
        {badge}
      </div>
      <ol className="divide-y divide-line overflow-hidden rounded-lg border border-line">
        {rows.length === 0 ? <li className="px-3 py-2 text-ui text-fg-subtle">{empty}</li> : null}
        {rows.map((row) => (
          <li
            key={row.key}
            data-rank={row.rank}
            data-right-tool={row.outcome ? true : undefined}
            data-outcome={row.outcome}
            className={cn(
              "flex min-h-9 items-center gap-2 px-3 py-1",
              row.outcome && OUTCOME_ROW[row.outcome],
            )}
          >
            <span className="w-5 shrink-0 text-right text-xs text-fg-subtle tabular-nums">
              {row.rank}
            </span>
            <span className="min-w-0 flex-1">
              <ToolPin name={row.name} />
            </span>
            {row.trailing}
          </li>
        ))}
        {footer ? <li className="px-3 py-1.5 text-xs text-fg-subtle">{footer}</li> : null}
      </ol>
    </section>
  );
}

/** The right tool's mark in a list: its outcome's icon and color, with the word. */
function RightTool({ outcome }: { outcome: Exclude<Outcome, "missing"> }) {
  return outcome === "first" ? (
    <Badge tone="success">
      <CircleCheck aria-hidden strokeWidth={1.75} />
      Right tool
    </Badge>
  ) : (
    <Badge tone="warning">
      <ArrowDown aria-hidden strokeWidth={1.75} />
      Right tool
    </Badge>
  );
}

/** A miss's list: the right tool marked where it sat, or named below in red when it was not returned. */
export function missRows(
  list: RankedListView,
  expected: ToolRef,
  rank: number | null,
): { rows: RankedRow[]; footer: ReactNode } {
  const outcome = rank === 1 ? "first" : "lower";
  const rows: RankedRow[] = list.items.map((item, index) => ({
    key: `${index}-${item.id}`,
    rank: index + 1,
    name: item.name,
    ...(item.id === expected.id ? { outcome, trailing: <RightTool outcome={outcome} /> } : {}),
  }));
  if (rank !== null && rank > list.items.length) {
    rows.push({
      key: `expected-${expected.id}`,
      rank,
      name: expected.name,
      outcome,
      trailing: <RightTool outcome={outcome} />,
    });
  }
  const footer =
    rank === null ? (
      <span className="flex flex-wrap items-center gap-2" data-outcome="missing">
        <Badge tone="danger">
          <CircleX aria-hidden strokeWidth={1.75} />
          Not returned
        </Badge>
        <ToolPin name={expected.name} />
      </span>
    ) : list.more > 0 ? (
      `${list.more} more results`
    ) : null;
  return { rows, footer };
}

/** A disagreement's list: each tool marked with where the other variant ranked it. */
export function diffRows(items: readonly DiffItem[]): RankedRow[] {
  return items.map((item, index) => ({
    key: `${index}-${item.id}`,
    rank: index + 1,
    name: item.name,
    trailing:
      item.mark === "only" ? (
        <Badge>Only here</Badge>
      ) : item.mark === "moved" && item.otherRank !== null ? (
        <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
          {ordinal(item.otherRank)} in the other
        </span>
      ) : null,
  }));
}
