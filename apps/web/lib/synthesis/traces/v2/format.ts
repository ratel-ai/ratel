/**
 * Number and time formatting for the v2 Traces views (DESIGN.md, Numbers and
 * Time): units after a non-breaking space, large values abbreviated in stats
 * and exact in tables, money with two decimals, and every timestamp in UTC.
 *
 * Built by hand rather than with Intl date formatting so the server render and
 * the browser's hydration produce the same characters.
 */

export const NBSP = "\u00a0";

/** Shown where a value does not exist (no runs, no duration). Never an em dash. */
export const MISSING = "–";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "0 ms", "12 ms", "1.2 s", "48 s", "2 min 5 s", "1 h 5 min". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return MISSING;
  if (ms === 0) return `0${NBSP}ms`;
  if (ms < 1) return `${trimZeros(ms.toFixed(2))}${NBSP}ms`;
  if (ms < 10) return `${trimZeros(ms.toFixed(1))}${NBSP}ms`;
  if (ms < 999.5) return `${Math.round(ms)}${NBSP}ms`;
  const seconds = ms / 1000;
  if (seconds < 9.95) return `${trimZeros(seconds.toFixed(1))}${NBSP}s`;
  if (seconds < 59.5) return `${Math.round(seconds)}${NBSP}s`;
  const totalSeconds = Math.round(seconds);
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const rest = totalSeconds % 60;
    return rest === 0 ? `${minutes}${NBSP}min` : `${minutes}${NBSP}min ${rest}${NBSP}s`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}${NBSP}h` : `${hours}${NBSP}h ${minutes}${NBSP}min`;
}

/** Exact, for tables: "12,431". */
export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return Math.round(value).toLocaleString("en-US");
}

/** Abbreviated, for stats: "1,284", "12.4K", "3.1M". Abbreviations attach. */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  if (Math.abs(value) < 10_000) return formatInteger(value);
  const units = [
    { size: 1e3, suffix: "K" },
    { size: 1e6, suffix: "M" },
    { size: 1e9, suffix: "B" },
  ] as const;
  let label = formatInteger(value);
  for (const [index, unit] of units.entries()) {
    const scaled = Math.round((value / unit.size) * 10) / 10;
    label = `${trimZeros(scaled.toFixed(1))}${unit.suffix}`;
    // 999,960 rounds to "1000K"; it belongs to the next unit up.
    if (Math.abs(scaled) < 1000 || index === units.length - 1) break;
  }
  return label;
}

/** Money with two decimals, never mixed: "$0.00", "<$0.01", "$3.20". */
export function formatMoney(usd: number | string | null | undefined): string {
  const value = typeof usd === "string" ? Number(usd) : usd;
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.005) return value > 0 ? "<$0.01" : "-<$0.01";
  const formatted = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `-$${formatted}` : `$${formatted}`;
}

/** A 0 to 1 rate as a percentage: "0%", "<0.1%", "3.4%", "12%". */
export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return MISSING;
  const percent = rate * 100;
  if (percent === 0) return "0%";
  if (percent > 0 && percent < 0.1) return "<0.1%";
  if (percent < 10) return `${trimZeros(percent.toFixed(1))}%`;
  return `${Math.round(percent)}%`;
}

/** "Oct 9" for a UTC day ("2026-10-09"). */
export function formatDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return `${MONTHS[month - 1]} ${date}`;
}

/**
 * "Oct 9" or "Oct 9 to Oct 11" for an inclusive range of UTC days. Given the
 * current day, a range outside the current year says its year.
 */
export function formatDayRange(from: string, to: string, today?: string): string {
  const year = today?.slice(0, 4);
  const withYear = (day: string) =>
    year && day.slice(0, 4) !== year ? `${formatDay(day)}, ${day.slice(0, 4)}` : formatDay(day);
  return from === to ? withYear(from) : `${withYear(from)} to ${withYear(to)}`;
}

/** "12:00" or, with seconds, "12:00:35" in UTC. */
export function formatClock(value: string | Date, withSeconds = false): string {
  const iso = toIso(value);
  if (!iso) return MISSING;
  return withSeconds ? iso.slice(11, 19) : iso.slice(11, 16);
}

/** "Oct 9, 2026, 12:00:35 UTC": absolute time for detail views and tooltips. */
export function formatTimestamp(value: string | Date): string {
  const iso = toIso(value);
  if (!iso) return MISSING;
  return `${formatDay(iso.slice(0, 10))}, ${iso.slice(0, 4)}, ${iso.slice(11, 19)}${NBSP}UTC`;
}

/**
 * Relative time for lists ("3 min ago"), measured against the request's
 * `now` so the server render and hydration agree. Older than a week reads as
 * a date.
 */
export function formatRelativeTime(value: string | Date, now: string | Date): string {
  const at = toMs(value);
  const reference = toMs(now);
  if (at === null || reference === null) return MISSING;
  const elapsed = reference - at;
  if (elapsed < 45_000) return "just now";
  if (elapsed < HOUR_MS) return `${Math.max(1, Math.round(elapsed / MINUTE_MS))}${NBSP}min ago`;
  if (elapsed < DAY_MS) return `${Math.round(elapsed / HOUR_MS)}${NBSP}h ago`;
  const days = Math.round(elapsed / DAY_MS);
  if (days <= 7) return days === 1 ? "yesterday" : `${days}${NBSP}days ago`;
  const iso = new Date(at).toISOString();
  const sameYear = iso.slice(0, 4) === new Date(reference).toISOString().slice(0, 4);
  return sameYear
    ? formatDay(iso.slice(0, 10))
    : `${formatDay(iso.slice(0, 10))}, ${iso.slice(0, 4)}`;
}

/** Middle-truncated id for display: "8f3a91c0…4be2". The full id stays copyable. */
export function shortId(id: string, head = 8, tail = 4): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

function trimZeros(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

function toMs(value: string | Date): number | null {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function toIso(value: string | Date): string | null {
  const ms = toMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}
