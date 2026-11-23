"use client";

import { Badge } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import { Highlighted } from "@/components/console/playground/Highlighted";
import type {
  ColumnKey,
  ComparisonColumn,
  ComparisonRow,
} from "@/lib/synthesis/playground/calibration-compare";

const RECORDED: ReadonlySet<ColumnKey> = new Set<ColumnKey>(["served", "shadow"]);

/**
 * Column names (DESIGN.md glossary: variants, never arms). "Today" becomes
 * "Before" once there is an "After" beside it to be before.
 */
function columnLabel(key: ColumnKey, hasAfter: boolean): { title: string; meta: string } {
  switch (key) {
    case "served":
      return { title: "Current variant", meta: "recorded" };
    case "shadow":
      return { title: "Comparison variant", meta: "recorded" };
    case "now":
      return { title: hasAfter ? "Before" : "Today", meta: "saved catalog" };
    case "edited":
      return { title: "After", meta: "your changes" };
  }
}

/**
 * The same search, side by side: what an experiment's variants returned, what
 * the saved catalog returns, and what it would return with your changes. Read
 * left to right; each row's arrow is its move from the column before.
 *
 * Pointing at a tool lights it in every column and dims the rest, so "the
 * variant led with this and my change buries it" is one gesture rather than
 * lining lists up by eye.
 */
export function CompareView({
  columns,
  terms,
  expected,
  openId,
  onOpen,
}: {
  columns: readonly ComparisonColumn[];
  /** The ask's words, lit in names. */
  terms: ReadonlySet<string>;
  expected: string | null;
  openId: string | null;
  /** Opens a tool in the Panel. Recorded tools the catalog no longer has stay inert. */
  onOpen: (id: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const recorded = columns.filter((column) => RECORDED.has(column.key)).length;
  const hasAfter = columns.some((column) => column.key === "edited");
  const focus = hovered ?? openId;

  return (
    <div className="-mx-6 overflow-x-auto px-6 lg:-mx-8 lg:px-8">
      <div
        className="grid gap-x-3 gap-y-1.5"
        style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(11rem, 1fr))` }}
        onMouseLeave={() => setHovered(null)}
      >
        {recorded > 0 ? (
          <>
            <Zone label="Recorded" span={recorded} />
            <Zone label="Live" span={columns.length - recorded} />
          </>
        ) : null}
        {columns.map((column) => {
          const { title, meta } = columnLabel(column.key, hasAfter);
          return (
            <div key={column.key} className="flex min-w-0 items-baseline gap-1.5 pt-1">
              <h4 className="truncate text-xs font-medium text-fg">{title}</h4>
              {column.mergedShadow ? (
                <Badge>Same as comparison</Badge>
              ) : (
                <span className="truncate text-xs text-fg-subtle">{meta}</span>
              )}
            </div>
          );
        })}
        {columns.map((column) => (
          <Column
            key={column.key}
            column={column}
            terms={terms}
            expected={expected}
            focus={focus}
            onHover={setHovered}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}

function Zone({ label, span }: { label: string; span: number }) {
  return (
    <div
      style={{ gridColumn: `span ${span}` }}
      className="flex items-center gap-2 text-xs text-fg-subtle"
    >
      {label}
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}

function Column({
  column,
  terms,
  expected,
  focus,
  onHover,
  onOpen,
}: {
  column: ComparisonColumn;
  terms: ReadonlySet<string>;
  expected: string | null;
  focus: string | null;
  onHover: (id: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const recorded = RECORDED.has(column.key);
  if (column.rows.length === 0) {
    return (
      <p className="self-start rounded-lg border border-dashed border-line px-3 py-3 text-center text-xs text-fg-subtle">
        Nothing matched
      </p>
    );
  }
  return (
    <ol
      className={cn(
        "self-start overflow-hidden rounded-lg border border-line",
        recorded ? "bg-app" : "bg-raised",
      )}
    >
      {column.rows.map((row) => (
        <Row
          key={row.id}
          row={row}
          recorded={recorded}
          terms={terms}
          expected={row.id === expected}
          focus={focus}
          onHover={onHover}
          onOpen={onOpen}
        />
      ))}
    </ol>
  );
}

function Row({
  row,
  recorded,
  terms,
  expected,
  focus,
  onHover,
  onOpen,
}: {
  row: ComparisonRow;
  recorded: boolean;
  terms: ReadonlySet<string>;
  expected: boolean;
  focus: string | null;
  onHover: (id: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const active = focus === row.id;
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={() => onOpen(row.id)}
        onMouseEnter={() => onHover(row.id)}
        onFocus={() => onHover(row.id)}
        onBlur={() => onHover(null)}
        className={cn(
          "flex h-9 w-full items-center gap-2 border-l-2 pr-2.5 pl-2 text-left outline-none",
          "transition-[background-color,opacity] duration-120 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
          expected
            ? row.rank === 1
              ? "border-l-success"
              : "border-l-warning"
            : "border-l-transparent",
          active ? "bg-selected" : "hover:bg-hover",
          focus !== null && !active && "opacity-40",
        )}
      >
        <span
          className={cn(
            "w-4 shrink-0 text-right text-xs tabular-nums",
            row.rank === 1 ? "font-semibold text-fg" : "text-fg-subtle",
          )}
        >
          {row.rank}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-xs",
            recorded ? "text-fg-muted" : "text-fg",
          )}
        >
          <Highlighted text={row.id} terms={terms} />
        </span>
        <Change row={row} />
      </button>
    </li>
  );
}

/** The move from the column before: an arrow and a number, or "New". A direction, so it stays gray. */
function Change({ row }: { row: ComparisonRow }) {
  if (row.change === null || row.change === "same") return null;
  if (row.change === "new") return <span className="shrink-0 text-xs text-fg-subtle">New</span>;
  const up = row.change === "up";
  const places = Math.abs(row.delta ?? 0);
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-fg-muted tabular-nums">
      <Icon aria-hidden strokeWidth={2} className="size-3" />
      {places}
      <span className="sr-only">{up ? `up ${places}` : `down ${places}`}</span>
    </span>
  );
}
