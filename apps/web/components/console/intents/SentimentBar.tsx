import { cn } from "@ratel/design-system/cn";
import type { TopicView } from "@/lib/views/intents/topics-view";

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** How a topic's turns read, in the order a reader scans them: good, plain, bad. */
const SEGMENTS = [
  { key: "positive", label: "Positive", className: "bg-success" },
  { key: "neutral", label: "Neutral", className: "bg-fg-faint" },
  { key: "negative", label: "Negative", className: "bg-danger" },
] as const;

/**
 * Sentiment as one small stacked bar (positive, neutral, negative) with the
 * negative share beside it, so color never carries it alone (the legend in
 * the info mark says the number is the negative share; `words` spells it out
 * where there is none). "Not measured" when none of the intent's asks carried
 * the person's own words.
 */
export function SentimentBar({
  sentiment,
  words = false,
  bare = false,
  className,
}: {
  sentiment: TopicView["sentiment"];
  words?: boolean;
  /** The bar alone, under a number that already says the negative share. */
  bare?: boolean;
  className?: string;
}) {
  if (!sentiment || sentiment.measured === 0)
    return <span className={cn("text-xs text-fg-faint", className)}>Not measured</span>;
  const summary = SEGMENTS.map(
    (segment) => `${sentiment[segment.key]} ${segment.label.toLowerCase()}`,
  ).join(", ");
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        role="img"
        aria-label={`Sentiment: ${summary}`}
        className="flex h-1.5 w-16 shrink-0 gap-px overflow-hidden rounded-[2px]"
      >
        {SEGMENTS.map((segment) =>
          sentiment[segment.key] > 0 ? (
            <span
              key={segment.key}
              aria-hidden
              className={cn("h-full min-w-[2px]", segment.className)}
              style={{ flexGrow: sentiment[segment.key], flexBasis: 0 }}
            />
          ) : null,
        )}
      </span>
      {bare ? null : (
        <span className="relative text-xs whitespace-nowrap text-fg-muted tabular-nums">
          {pct(sentiment.negativeShare)}
          {words ? " negative" : <span className="sr-only"> negative</span>}
        </span>
      )}
    </span>
  );
}

/** The legend the sentiment bars read by, in the sentiment info mark. */
export function SentimentLegend({ className }: { className?: string }) {
  return (
    <ul
      aria-label="Sentiment colors"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle",
        className,
      )}
    >
      {SEGMENTS.map((segment) => (
        <li key={segment.key} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn("size-2 rounded-[2px]", segment.className)} />
          {segment.label}
        </li>
      ))}
      <li className="basis-full">The number beside a bar is the share that reads negative.</li>
    </ul>
  );
}
