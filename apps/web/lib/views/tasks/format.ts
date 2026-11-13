import { formatCount, formatSharePercent } from "@/lib/readings/trace-signals/claims";
import {
  formatDuration,
  formatMoney as formatTraceMoney,
  MISSING,
  NBSP,
} from "@/lib/synthesis/traces/v2/format";

/**
 * The few formats the task pages print, on the product's rules (DESIGN.md,
 * Numbers): whole percents as Agent health prints them, counts with
 * grouping, units after a non-breaking space, money with two decimals, and a
 * dash (never an em dash) where a table cell has no value; copy elsewhere
 * says "Not measured".
 */

export { formatCount, formatSharePercent, MISSING, NBSP };

export function formatShare(share: number | null): string {
  return share === null ? MISSING : formatSharePercent(share);
}

/** "180 ms", "1.2 s", "2 min 5 s". */
export function formatMs(ms: number | null): string {
  return formatDuration(ms);
}

/** "$1.24", "$0.03", "<$0.01": two decimals, never three. */
export function formatMoney(usd: number): string {
  return formatTraceMoney(usd);
}

/** Per 100 runs: one decimal below ten, whole numbers from ten. */
export function formatPer100(value: number | null): string {
  if (value === null) return MISSING;
  if (value === 0) return "0";
  if (value < 10) return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return formatCount(value);
}

export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}
