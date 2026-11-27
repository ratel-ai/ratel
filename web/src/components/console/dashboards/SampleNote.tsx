import type { TraceSample } from "@/lib/synthesis/metrics/steps";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";

/** Says what a result was read from, when that is not every trace. */
export function SampleNote({
  sample: { matched, read },
  more,
}: {
  sample: TraceSample;
  /** What else the widget left out. */
  more?: string;
}) {
  const notes = [
    matched > read
      ? `Sampled: the newest ${formatInteger(read)} of ${formatInteger(matched)} traces.`
      : null,
    more,
  ].filter(Boolean);
  if (notes.length === 0) return null;
  return <p className="shrink-0 pt-2 text-xs text-fg-subtle">{notes.join(" ")}</p>;
}
