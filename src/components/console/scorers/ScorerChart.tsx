import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import type { DailyRate } from "@/lib/views/scorers/adapters/run-scores";

/** RC-615: one scorer's pass rate per day, one bar a day. Days with nothing scored show no bar. */
export function ScorerChart({
  rates,
  days,
}: {
  rates: readonly DailyRate[];
  days: readonly string[];
}) {
  const byDay = new Map(rates.map((rate) => [rate.day, rate]));
  const scored = days.some((day) => (byDay.get(day)?.n ?? 0) > 0);
  return (
    <Section title="Pass rate" description="Runs that passed, per day, over the last 14 days.">
      {!scored ? (
        <EmptyState
          title="No runs scored yet"
          description="The daily score job and eval runs fill this chart."
        />
      ) : (
        <div
          className="flex h-40 items-end gap-1 border-b border-line"
          role="img"
          aria-label="Pass rate per day"
        >
          {days.map((day) => {
            const rate = byDay.get(day);
            const share = rate && rate.n > 0 ? rate.passed / rate.n : null;
            return (
              <div
                key={day}
                className="flex h-full flex-1 flex-col justify-end"
                title={
                  share === null
                    ? `${day}: not scored`
                    : `${day}: ${rate!.passed} of ${rate!.n} passed`
                }
              >
                {share === null ? null : (
                  <div
                    className="rounded-t-sm"
                    style={{
                      height: `${Math.max(2, share * 100)}%`,
                      background: "var(--ds-chart-1)",
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-1 flex justify-between text-xs text-fg-subtle tabular-nums">
        <span>{days[0]}</span>
        <span>{days.at(-1)}</span>
      </div>
    </Section>
  );
}
