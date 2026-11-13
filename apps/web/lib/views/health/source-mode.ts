import type { SourceMode, TurnSourceMix } from "@/lib/readings/trace-signals/view";

/**
 * Where a project's turns come from, read from a run's turn counts by source:
 * `otel` when every turn came from OpenTelemetry, `mixed` when some came from
 * the Ratel SDK too, `sdk` otherwise (including no turns at all, so a new
 * project keeps the page it has always had).
 */
export function sourceModeOf(mix: TurnSourceMix | null | undefined): SourceMode {
  if (!mix) return "sdk";
  const runtime = Math.max(0, mix.declared) + Math.max(0, mix.inferred);
  const otlp = Math.max(0, mix.otlp);
  if (otlp > 0 && runtime > 0) return "mixed";
  return otlp > 0 ? "otel" : "sdk";
}

/** A mix with any turns in it, else the fallback (a run stored with an empty mix). */
export function mixOrFallback(
  mix: TurnSourceMix | null | undefined,
  fallback: TurnSourceMix,
): TurnSourceMix {
  if (!mix) return fallback;
  return mix.declared + mix.inferred + mix.otlp > 0 ? mix : fallback;
}

/** The header's source badge; null for the SDK page, which needs none. */
export function sourceBadgeText(mode: SourceMode): string | null {
  switch (mode) {
    case "otel":
      return "From OpenTelemetry";
    case "mixed":
      return "SDK + OpenTelemetry";
    default:
      return null;
  }
}
