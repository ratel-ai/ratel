import { cn } from "@ratel/design-system/cn";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import type { EarlyProgress } from "@/lib/readings/trace-signals/signals/early-reading";

/**
 * "Still calculating" without a paragraph (RC-225): a live dot, one word and
 * how far the early reading has got. The counts behind the percent are a
 * hover away. Without a percent (the count failed) it is the word alone.
 */
export function Calculating({
  progress,
  className,
}: {
  progress: EarlyProgress | null | undefined;
  className?: string;
}) {
  const title = progress
    ? `Read ${progress.read.toLocaleString("en-US")} of ${progress.total.toLocaleString("en-US")} runs so far`
    : "Still reading your runs";
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-md bg-info-subtle px-2 text-ui font-medium text-info",
        className,
      )}
      title={title}
      data-health-calculating={progress?.percent ?? ""}
    >
      <span aria-hidden className="live-dot size-1.5 rounded-full bg-info" />
      Calculating
      {progress ? <span className="tabular-nums">{progress.percent}%</span> : null}
      <span className="sr-only">. {title}.</span>
    </span>
  );
}

/** The early reading's progress as pixels, with what it counts. */
export function ReadProgress({ progress }: { progress: EarlyProgress }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
      <DotMeter
        value={progress.percent / 100}
        cells={30}
        tone="neutral"
        label={`${progress.percent}% of your runs read`}
      />
      <span className="tabular-nums">
        {progress.read.toLocaleString("en-US")} of {progress.total.toLocaleString("en-US")} runs
        read
      </span>
    </span>
  );
}
