import { cn } from "@ratel/design-system/cn";
import { Bot, type LucideIcon, Zap } from "lucide-react";
import { Trend, TrendChip } from "@/components/console/health/primitives/Sparkline";
import type { HealthTile, HealthTileKey, SignalTier } from "@/lib/readings/trace-signals/view";
import {
  sparkDomain,
  tierGlyphLabel,
  tileDelta,
  tileFigure,
  tileIntervalText,
  trendText,
} from "@/lib/views/health/tiles";

export interface HealthBandProps {
  /** Four tiles in band order (three for OpenTelemetry without model calls). A null value renders a dash. */
  tiles: readonly HealthTile[];
}

/**
 * Each reading gets one quiet identity hue, for the LED by its label and the
 * sparkline under it, as on the dashboard vitals. Green, coral and amber are left
 * out on purpose: on this page they mean "working" and "worth a look", and a tile
 * is only good or bad through its delta chip, never through its identity.
 */
const ACCENT: Record<HealthTileKey, string> = {
  top_5: "var(--color-ctx-memory)",
  first_try: "var(--color-ctx-memory)",
  detours: "var(--color-indigo-300)",
  junk: "var(--color-teal)",
  wasted_calls: "var(--color-cream-dim)",
  // The OpenTelemetry band reuses the same quiet hues, slot for slot.
  completed: "var(--color-ctx-memory)",
  failed_calls: "var(--color-indigo-300)",
  round_trips: "var(--color-teal)",
  // SDK runs linked to OpenTelemetry model calls take the two freed slots' hues.
  cost_per_run: "var(--color-indigo-300)",
  model_calls: "var(--color-teal)",
};

/** Tiles rise in left to right, as the vitals band does. */
const TILE_DELAY_MS = 120;
const TILE_STAGGER_MS = 110;

/** The band's sparkline: shorter than the vitals' 44px, but inked stronger. */
const TREND_HEIGHT = 36;

/**
 * The health band: four instrument tiles (first try, detours, junk in lists,
 * wasted calls per 100 turns), shown when a reader opens "Show trends" on the
 * readings line (`HealthReadings`). Each tile is compact: the
 * figure is the hero with its delta chip beside it, the likely range and a
 * plain sub line sit quietly under it, and a daily sparkline runs along the
 * bottom edge with a haloed dot on the latest day and a faint dotted guide at
 * its level. Missing days stay gaps. The first paint carries the final
 * numbers: tiles rise in, figures never count up.
 */
export function HealthBand({ tiles }: HealthBandProps) {
  // Three tiles (an OpenTelemetry project without model calls) fill one row
  // on a wide screen, and the odd one spans the second row on a phone, so the
  // band never ends on an empty slot.
  const three = tiles.length === 3;
  return (
    <section
      aria-label="Health band"
      data-health-band="true"
      className={cn("grid grid-cols-2 gap-3", three ? "lg:grid-cols-3" : "lg:grid-cols-4")}
    >
      {tiles.map((tile, index) => (
        <HealthTileCard
          key={tile.key}
          tile={tile}
          index={index}
          className={three && index === 2 ? "col-span-2 lg:col-span-1" : undefined}
        />
      ))}
    </section>
  );
}

function HealthTileCard({
  tile,
  index,
  className,
}: {
  tile: HealthTile;
  index: number;
  className?: string;
}) {
  const accent = ACCENT[tile.key];
  const figure = tileFigure(tile);
  const interval = tileIntervalText(tile);
  const domain = figure.ready ? sparkDomain(tile.series, tile.unit) : null;
  const trend = figure.ready ? trendText(tile) : null;
  return (
    <div
      data-health-tile={tile.key}
      className={cn(
        "card-enter group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-forest-300 bg-forest-600/60 px-3 pt-2.5 transition-colors hover:bg-forest/40 sm:px-3.5 sm:pt-3",
        className,
      )}
      style={{ animationDelay: `${TILE_DELAY_MS + index * TILE_STAGGER_MS}ms` }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: accent }}
          aria-hidden
        />
        <p className="eyebrow min-w-0 truncate">{tile.label}</p>
        <TierGlyph tier={tile.tier} />
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span
            className={cn(
              "font-display text-[2rem] font-semibold leading-none tracking-tight tabular-nums sm:text-[2.25rem]",
              figure.ready ? "text-cream" : "text-warm-muted/60",
            )}
          >
            {figure.value}
          </span>
          {figure.unit && (
            <span className="whitespace-nowrap font-mono text-[11px] text-warm-muted">
              {figure.unit}
            </span>
          )}
        </p>
        <TileDeltaChip tile={tile} />
      </div>

      {interval && (
        <p
          className="mt-1 font-mono text-[10px] leading-4 tabular-nums text-warm-muted/75"
          data-tile-interval="true"
        >
          <span className="text-warm-muted/50">likely </span>
          {interval}
        </p>
      )}
      <p className="mt-1 text-[11px] leading-4 text-warm-muted">{tile.sub}</p>
      {trend && <p className="sr-only">{trend}</p>}

      <div className="-mx-3 mt-auto pt-2 sm:-mx-3.5">
        {domain ? (
          <Trend
            data={tile.series.map((point) => point.value)}
            accent={accent}
            domain={domain}
            height={TREND_HEIGHT}
            endDot
            strong
            lastGuide
          />
        ) : (
          <Trend data={[]} accent={accent} height={TREND_HEIGHT} />
        )}
      </div>
    </div>
  );
}

/**
 * The change against the previous window, sized to read at a glance beside the
 * figure. Green or coral says better or worse, the arrow says which way it
 * moved, and screen readers hear both in words. A change that rounds to zero
 * stays a muted chip; no previous window, no chip.
 */
function TileDeltaChip({ tile }: { tile: HealthTile }) {
  const delta = tileDelta(tile);
  if (!delta) return null;
  if (delta.direction === "flat") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-forest-300/35 px-2 py-1 font-mono text-xs leading-none tabular-nums text-warm-muted"
        title={delta.description}
      >
        <span aria-hidden>→ </span>
        {delta.text}
        <span className="sr-only">, {delta.description.toLowerCase()}</span>
      </span>
    );
  }
  return (
    <span className="shrink-0" data-tile-delta={delta.tone}>
      <TrendChip
        up={delta.direction === "up"}
        good={delta.tone === "good"}
        label={delta.text}
        title={delta.description}
        size="md"
      >
        <span className="sr-only">, {delta.description.toLowerCase()}</span>
      </TrendChip>
    </span>
  );
}

const TIER_GLYPH: Partial<Record<SignalTier, { Icon: LucideIcon; tone: string }>> = {
  classifier: { Icon: Zap, tone: "text-ctx-memory" },
  judge: { Icon: Bot, tone: "text-indigo-300" },
};

/**
 * Who decided a figure, when it was not counted: a bolt for the classifier tier,
 * the match-quality bot for a model verdict. Counted figures carry no glyph.
 */
function TierGlyph({ tier }: { tier: SignalTier }) {
  const label = tierGlyphLabel(tier);
  const glyph = TIER_GLYPH[tier];
  if (!label || !glyph) return null;
  const { Icon, tone } = glyph;
  return (
    <span role="img" aria-label={label} title={label} className={cn("inline-flex shrink-0", tone)}>
      <Icon className="size-3" aria-hidden />
    </span>
  );
}
