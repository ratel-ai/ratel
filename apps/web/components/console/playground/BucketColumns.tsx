"use client";

import { Tooltip } from "@base-ui/react/tooltip";
import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Pencil } from "lucide-react";
import { useState } from "react";
import type {
  ColumnKey,
  ComparisonColumn,
  ComparisonRow,
} from "@/lib/synthesis/playground/calibration-compare";
import type { RankedHit } from "@/lib/synthesis/playground/types";
import { formatRankScore } from "@/lib/synthesis/playground/view";
import { ChangeMark } from "./icons";
import { ScorePeek } from "./ScorePeek";

/** One bucket's rankings, as columns you read left to right. */

const COLUMN_LABEL: Record<ColumnKey, string> = {
  served: "Served",
  shadow: "Shadow",
  now: "Now",
  edited: "Your edits",
};

/**
 * "Now" only means anything next to a "then". On a plain run there is nothing
 * recorded to contrast with, so the column says what it is instead.
 */
function columnLabel(key: ColumnKey, hasRecorded: boolean): string {
  if (key === "now" && !hasRecorded) return "Your catalog";
  return COLUMN_LABEL[key];
}

/** What each column means, on hover rather than underneath. */
const COLUMN_HINT: Record<ColumnKey, string> = {
  served: "What your agents actually got when this ran.",
  shadow: "What the other configuration would have returned for the same prompt.",
  now: "What your catalog returns for this prompt today.",
  edited: "What it would return with your unsaved edits applied.",
};

/** The two halves of the story, named once instead of column by column. */
const ZONE_LABEL = {
  recorded: "already happened",
  live: "your catalog now",
} as const;

const RECORDED: ReadonlySet<ColumnKey> = new Set<ColumnKey>(["served", "shadow"]);

export function BucketColumns({
  columns,
  hitsByColumn,
  emptyReason,
  onEdit,
}: {
  columns: readonly ComparisonColumn[];
  /** Score and edit metadata for the live columns. Recorded arms have none. */
  hitsByColumn: Partial<Record<ColumnKey, ReadonlyMap<string, RankedHit>>>;
  emptyReason: string | null;
  /** Opens a capability in the bench. Absent while a column is recorded. */
  onEdit: ((id: string) => void) | null;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const recordedCount = columns.filter((column) => RECORDED.has(column.key)).length;

  if (columns.every((column) => column.rows.length === 0) && emptyReason) {
    return (
      <p className="rounded-lg border border-dashed border-forest-300 px-3 py-4 text-xs leading-relaxed text-warm-muted">
        {emptyReason}
      </p>
    );
  }

  return (
    <Tooltip.Provider delay={220}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: clears the pointer highlight only. */}
      <div
        className="grid gap-2 sm:gap-3"
        style={{
          gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
        }}
        onMouseLeave={() => setHovered(null)}
      >
        {recordedCount > 0 && (
          <>
            <Zone label={ZONE_LABEL.recorded} span={recordedCount} tone="past" />
            <Zone label={ZONE_LABEL.live} span={columns.length - recordedCount} tone="live" />
          </>
        )}
        {columns.map((column) => (
          <Column
            key={column.key}
            column={column}
            hits={hitsByColumn[column.key]}
            hasRecorded={recordedCount > 0}
            emptyReason={emptyReason}
            hovered={hovered}
            onHover={setHovered}
            onEdit={RECORDED.has(column.key) ? null : onEdit}
          />
        ))}
      </div>
    </Tooltip.Provider>
  );
}

function Column({
  column,
  hits,
  hasRecorded,
  emptyReason,
  hovered,
  onHover,
  onEdit,
}: {
  column: ComparisonColumn;
  hits: ReadonlyMap<string, RankedHit> | undefined;
  hasRecorded: boolean;
  emptyReason: string | null;
  hovered: string | null;
  onHover: (id: string | null) => void;
  onEdit: ((id: string) => void) | null;
}) {
  const recorded = RECORDED.has(column.key);
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex h-4 items-baseline gap-1.5 px-1" title={COLUMN_HINT[column.key]}>
        <h4
          className={cn(
            "truncate text-xs font-medium",
            column.key === "edited" ? "text-coral" : recorded ? "text-warm-muted" : "text-cream",
          )}
        >
          {columnLabel(column.key, hasRecorded)}
        </h4>
        {column.arm && (
          <span className="truncate font-mono text-[10px] text-warm-muted/70">{column.arm}</span>
        )}
        {column.mergedShadow && (
          <span
            className="shrink-0 rounded border border-forest-300 px-1 font-mono text-[9px] text-warm-muted"
            title="The shadow arm returned exactly this, so the two columns were the same list twice."
          >
            = shadow
          </span>
        )}
      </div>

      {column.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-forest-300/70 px-2 py-3 text-center text-[10px] leading-relaxed text-warm-muted">
          {recorded ? "none here" : (emptyReason ?? "nothing matched")}
        </p>
      ) : (
        <ol
          className={cn(
            "flex flex-col gap-px overflow-hidden rounded-lg border",
            recorded ? "border-forest-300/40 bg-base-deep/10" : "border-forest-300/70",
          )}
        >
          {column.rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              hit={hits?.get(row.id)}
              recorded={recorded}
              hovered={hovered}
              onHover={onHover}
              onEdit={onEdit}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function Row({
  row,
  hit,
  recorded,
  hovered,
  onHover,
  onEdit,
}: {
  row: ComparisonRow;
  hit: RankedHit | undefined;
  recorded: boolean;
  hovered: string | null;
  onHover: (id: string | null) => void;
  onEdit: ((id: string) => void) | null;
}) {
  const active = hovered === row.id;
  const dimmed = hovered !== null && !active;
  return (
    <li
      onMouseEnter={() => onHover(row.id)}
      onFocus={() => onHover(row.id)}
      onBlur={() => onHover(null)}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a row is focusable so the keyboard reaches its peek.
      tabIndex={0}
      className={cn(
        "group/hit relative px-2 py-1.5 outline-none",
        "transition-[background-color,opacity] duration-100",
        active ? "bg-cream/10" : "bg-base-deep/35",
        dimmed && "opacity-40",
        hit?.edited && !active && "bg-coral/[0.06]",
      )}
    >
      {row.fill > 0 && (
        <span
          aria-hidden
          style={{ width: `${Math.round(row.fill * 100)}%` }}
          className={cn(
            "pointer-events-none absolute bottom-0 left-0 h-px",
            recorded ? "bg-cream/15" : "bg-indigo-300/35",
          )}
        />
      )}
      <ScorePeek row={row} hit={hit} recorded={recorded}>
        <div className="relative flex items-center gap-1.5">
          <span className="w-3.5 shrink-0 text-center font-mono text-[10px] tabular-nums text-warm-muted">
            {row.rank}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-[11px]",
              recorded ? "text-cream-dim" : "text-cream",
            )}
          >
            {row.id}
          </span>
          {row.change && <ChangeMark change={row.change} delta={row.delta} />}
          {row.score !== null && (
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-cream-dim/80">
              {formatRankScore(row.score)}
            </span>
          )}
          {onEdit && (
            <Button
              variant="ghost"
              onClick={() => onEdit(row.id)}
              aria-label={`Edit ${row.id}`}
              title="Edit this description"
              className="-my-1 size-auto rounded border-0 p-0.5 text-warm-muted opacity-0 transition-[opacity,color] group-hover/hit:opacity-100 hover:bg-transparent hover:text-cream focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-indigo-300/60 focus-visible:ring-offset-0"
            >
              <Pencil className="size-2.5" aria-hidden />
            </Button>
          )}
        </div>
      </ScorePeek>
    </li>
  );
}

/** Ids the edit pushed out of the top-K: a regression that leaves no row behind. */
export function DroppedNotice({ ids }: { ids: readonly string[] }) {
  if (ids.length === 0) return null;
  return (
    <p className="mt-2 rounded-lg border border-coral/25 bg-coral/[0.07] px-3 py-2 text-[11px] leading-relaxed text-coral">
      Pushed out of the top results: <span className="font-mono">{ids.join(", ")}</span>
    </p>
  );
}

/** A label spanning the columns it describes. */
function Zone({ label, span, tone }: { label: string; span: number; tone: "past" | "live" }) {
  return (
    <div
      style={{ gridColumn: `span ${span}` }}
      className={cn(
        "mb-1 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.1em]",
        tone === "past" ? "text-warm-muted/60" : "text-indigo-300/80",
      )}
    >
      {label}
      <span
        className={cn("h-px flex-1", tone === "past" ? "bg-forest-300/50" : "bg-indigo-300/25")}
        aria-hidden
      />
    </div>
  );
}
