import { formatDuration } from "@/lib/readings/tool-explorer/view";
import { formatTokens } from "@/lib/synthesis/tool-crafter/suggestion-model";
import { formatMoney } from "@/lib/synthesis/traces/v2/format";
import type { FixGain, FixSavings } from "@/lib/views/fixes/types";

export const SAVINGS_PERIODS = {
  day: { days: 1, label: "per day" },
  week: { days: 7, label: "per week" },
  month: { days: 30, label: "per month" },
} as const;
export type SavingsPeriod = keyof typeof SAVINGS_PERIODS;

/** Scale measured totals to the selected period. Unknown windows have no rate. */
export function savingsForPeriod(
  savings: FixSavings,
  windowDays: number | null,
  period: SavingsPeriod,
): FixSavings {
  const scale =
    windowDays !== null && Number.isFinite(windowDays) && windowDays > 0
      ? SAVINGS_PERIODS[period].days / windowDays
      : null;
  const value = (n: number | null) => (n === null || scale === null ? null : n * scale);
  return { tokens: value(savings.tokens), usd: value(savings.usd), ms: value(savings.ms) };
}

export function fixSavingsText(
  gain: FixGain | null,
  period: SavingsPeriod = "month",
): string | null {
  if (!gain) return null;
  const savings = savingsForPeriod(gain, gain.windowDays, period);
  const parts: string[] = [];
  if (savings.tokens !== null) parts.push(`−${formatTokens(savings.tokens)} tokens`);
  if (savings.usd !== null) parts.push(`−${formatMoney(savings.usd)}`);
  if (savings.ms !== null) parts.push(`−${formatDuration(savings.ms)} waiting`);
  return parts.length > 0 ? `${parts.join(" · ")} ${SAVINGS_PERIODS[period].label}` : null;
}
