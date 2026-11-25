/** Items a long list shows at first, and adds with each "See more". */
export const SEE_MORE_STEP = 10;

/** The first `shown` items in the batches they came in, so each can animate in (pure). */
export function batches<T>(items: readonly T[], shown: number, step = SEE_MORE_STEP): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < Math.min(shown, items.length); at += step)
    out.push(items.slice(at, Math.min(at + step, shown)));
  return out;
}

/** How many items the next "See more" adds; 0 when every item shows. */
export const nextCount = (total: number, shown: number, step = SEE_MORE_STEP): number =>
  Math.max(0, Math.min(step, total - shown));
