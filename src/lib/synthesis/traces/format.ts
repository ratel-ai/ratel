import { fmtCost, fmtCount } from "@/lib/platform/format";

const SPAN_KIND_LABELS: Readonly<Record<number, string>> = {
  0: "Unspecified",
  1: "Internal",
  2: "Server",
  3: "Client",
  4: "Producer",
  5: "Consumer",
};
const SPAN_STATUS_LABELS: Readonly<Record<number, string>> = {
  0: "Unset",
  1: "OK",
  2: "Error",
};

export type TraceStatusCode = 0 | 1 | 2;

export function formatTimestamp(value: Date | string, style: "full" | "compact" = "full"): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const iso = date.toISOString();
  if (style === "compact") return `${iso.slice(5, 10)} ${iso.slice(11, 19)}`;
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)} UTC`;
}

export function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1) return `${decimal(value, 3)}ms`;
  // Round before picking each unit bucket so a remainder that rounds up to the
  // next unit (999.6ms, 59.99s, 5m 59.99s) carries instead of printing 1000ms,
  // 60s, or 5m 60s.
  if (value < 1_000) {
    const digits = value < 10 ? 2 : value < 100 ? 1 : 0;
    const rounded = Number(value.toFixed(digits));
    if (rounded < 1_000) return `${decimal(rounded, digits)}ms`;
    value = rounded;
  }

  let seconds = value / 1_000;
  if (seconds < 60) {
    const digits = seconds < 10 ? 2 : 1;
    const rounded = Number(seconds.toFixed(digits));
    if (rounded < 60) return `${decimal(rounded, digits)}s`;
    seconds = rounded;
  }

  let wholeMinutes = Math.floor(seconds / 60);
  let remainingSeconds = Number((seconds - wholeMinutes * 60).toFixed(1));
  if (remainingSeconds === 60) {
    wholeMinutes += 1;
    remainingSeconds = 0;
  }
  if (wholeMinutes < 60) {
    return remainingSeconds === 0
      ? `${wholeMinutes}m`
      : `${wholeMinutes}m ${decimal(remainingSeconds, 1)}s`;
  }

  const hours = Math.floor(wholeMinutes / 60);
  const minutes = wholeMinutes - hours * 60;
  const parts = [`${hours}h`];
  if (minutes > 0) parts.push(`${minutes}m`);
  if (remainingSeconds > 0) {
    parts.push(`${decimal(remainingSeconds, 1)}s`);
  }
  return parts.join(" ");
}

export function formatTokens(value: number | null | undefined): string {
  return formatCount(value);
}

export function formatCount(
  value: number | null | undefined,
  singular?: string,
  plural = singular ? `${singular}s` : undefined,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const formatted = fmtCount(value);
  if (!singular) return formatted;
  return `${formatted} ${value === 1 ? singular : plural}`;
}

export function formatCostUsd(value: number | string | null | undefined): string {
  if (value == null || value === "") return "—";
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? fmtCost(amount) : "—";
}

export function formatSpanKind(kind: number): string {
  return SPAN_KIND_LABELS[kind] ?? `Unknown (${kind})`;
}

export function formatSpanStatus(statusCode: number): string {
  return SPAN_STATUS_LABELS[statusCode] ?? SPAN_STATUS_LABELS[0];
}

export function traceStatusCode(rootStatusCode: number, errorCount = 0): TraceStatusCode {
  if (errorCount > 0 || rootStatusCode === 2) return 2;
  return rootStatusCode === 1 ? 1 : 0;
}

export function formatAttributeValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(stableJsonValue(value)) ?? String(value);
  } catch {
    return String(value);
  }
}

function decimal(value: number, maximumDigits: number): string {
  const fixed = value.toFixed(maximumDigits);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, stableJsonValue(item)]),
    );
  }
  return value;
}
