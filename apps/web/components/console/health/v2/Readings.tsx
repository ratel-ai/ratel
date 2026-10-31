import { DotSpark } from "@ratel/design-system/dot-matrix";
import { StatRow } from "@ratel/design-system/stat-row";
import { ReadingsPanel } from "@/components/console/health/v2/ReadingsPanel";
import type { ReadingView } from "@/components/console/health/v2/reading-views";

/**
 * The readings as one StatRow (DESIGN.md, Numbers): each value with its
 * change on the window before, the sentence it is counted from, and seven
 * days of it as pixels. A reading opens its numbers in a Panel
 * (`?peek=reading:<key>`).
 */
export function Readings({
  readings,
  interactive = true,
}: {
  readings: readonly ReadingView[];
  /** Off while there is no reading yet: a dash has nothing to open. */
  interactive?: boolean;
}) {
  if (readings.length === 0) return null;
  return (
    <section aria-label="Readings" data-health-readings={readings.length}>
      <StatRow
        stats={readings.map((reading) => ({
          label: reading.label,
          value: reading.value,
          ...(reading.delta ? { delta: reading.delta } : {}),
          ...(reading.hint ? { hint: reading.hint } : {}),
          ...(reading.trend
            ? {
                trend: (
                  <DotSpark
                    values={reading.trend}
                    label={reading.trendLabel ?? "The last 7 days"}
                  />
                ),
              }
            : {}),
          ...(interactive ? { peek: reading.peek } : {}),
        }))}
      />
      {interactive ? <ReadingsPanel readings={readings} /> : null}
    </section>
  );
}
