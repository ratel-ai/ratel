"use client";

import { Button } from "@ratel/design-system/button";
import { Checkbox } from "@ratel/design-system/checkbox";
import { cn } from "@ratel/design-system/cn";
import { GitCompareArrows } from "lucide-react";
import { formatStamp, relativeTime } from "@/lib/console/settings/format";
import type { RecordedItemView } from "@/lib/views/sandboxes/page";
import { checkCompareSelection, itemLabel, MAX_COMPARE_ITEMS } from "@/lib/views/sandboxes/replay";

/**
 * The sandbox's recorded production items of the last 30 days (RC-1103). A click
 * opens an item: its input fills the form and its recorded output shows next
 * to the new one. The checkboxes pick items for Compare (at most 50).
 */
export function RecordedItems({
  items,
  loading,
  error,
  openSpanId,
  picked,
  now,
  compareDisabled,
  onOpen,
  onPick,
  onCompare,
}: {
  items: readonly RecordedItemView[];
  loading: boolean;
  error: string | null;
  openSpanId: string | null;
  picked: ReadonlySet<string>;
  now: Date;
  compareDisabled: boolean;
  onOpen: (item: RecordedItemView) => void;
  onPick: (spanIds: readonly string[], on: boolean) => void;
  onCompare: () => void;
}) {
  if (error) return <p className="text-ui text-danger">{error}</p>;
  if (loading && items.length === 0) {
    return (
      <div aria-hidden className="flex flex-col gap-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-10 animate-pulse rounded-md bg-hover motion-reduce:animate-none"
          />
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="text-ui text-fg-muted">
        No recorded items in the last 30 days. Production calls of this sandbox show here once they
        carry their input.
      </p>
    );
  }
  const refusal = picked.size > 0 ? checkCompareSelection([...picked]) : null;
  const allPicked = items.every((item) => picked.has(item.spanId));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-2">
        <Checkbox
          label={
            <span className="text-xs text-fg-muted">
              {allPicked ? "Clear" : `Pick all ${items.length}`}
            </span>
          }
          checked={allPicked}
          onCheckedChange={(on) =>
            onPick(
              items.map((item) => item.spanId),
              on,
            )
          }
        />
        <Button
          size="sm"
          onClick={onCompare}
          disabled={picked.size === 0 || refusal !== null || compareDisabled}
        >
          <GitCompareArrows className="size-3.5" aria-hidden />
          Compare {picked.size > 0 ? picked.size : ""}
        </Button>
      </div>
      {refusal ? (
        <p role="alert" className="px-2 text-xs text-danger">
          {refusal} {picked.size} picked; clear {picked.size - MAX_COMPARE_ITEMS} to compare.
        </p>
      ) : null}
      <ul className="flex max-h-80 flex-col overflow-y-auto">
        {items.map((item) => (
          <li
            key={item.spanId}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 transition-[background-color] duration-120 hover:bg-hover",
              item.spanId === openSpanId && "bg-selected hover:bg-selected",
            )}
          >
            <Checkbox
              aria-label={`Pick ${itemLabel(item.input, item.spanId)} for Compare`}
              checked={picked.has(item.spanId)}
              onCheckedChange={(on) => onPick([item.spanId], on)}
            />
            <button
              type="button"
              onClick={() => onOpen(item)}
              className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <span className="truncate text-ui text-fg">{itemLabel(item.input, item.spanId)}</span>
              <time
                dateTime={item.startedAt}
                title={formatStamp(item.startedAt)}
                className="shrink-0 text-xs text-fg-subtle tabular-nums"
              >
                {relativeTime(item.startedAt, now)}
              </time>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
