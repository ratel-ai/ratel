"use client";

import { Button } from "@ratel/design-system/button";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Grow } from "@/components/console/sentiment/reveal";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { batches, nextCount, SEE_MORE_STEP } from "@/lib/views/traces/see-more";

/**
 * A list of which ten show, with "See more" (and how many are left) for ten more: the added rows grow
 * and fade in (200 ms). Give it a `key` per list, so another list starts at
 * its first ten.
 */
export function SeeMoreList<T>({
  items,
  itemKey,
  children,
  ...rest
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  children: (item: T) => ReactNode;
} & Record<`data-${string}`, string>) {
  const [shown, setShown] = useState(SEE_MORE_STEP);
  const more = nextCount(items.length, shown);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col border-t border-line" {...rest}>
        {batches(items, shown).map((batch, index) => (
          <Batch key={itemKey(batch[0] as T)} animate={index > 0}>
            {batch.map((item) => (
              <li key={itemKey(item)}>{children(item)}</li>
            ))}
          </Batch>
        ))}
      </ul>
      {more > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          data-see-more=""
          onClick={() => setShown((count) => count + SEE_MORE_STEP)}
        >
          See more
          <span className="text-fg-subtle tabular-nums">{formatCount(items.length - shown)}</span>
          <ChevronDown aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

/** One batch of rows; a later one grows from no height to its own as it appears. */
function Batch({ animate, children }: { animate: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!animate);
  useEffect(() => {
    if (open) return;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return (
    <li className="list-none">
      <Grow shown={open}>
        <ul>{children}</ul>
      </Grow>
    </li>
  );
}
