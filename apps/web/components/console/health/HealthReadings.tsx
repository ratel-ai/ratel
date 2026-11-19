import { cn } from "@ratel/design-system/cn";
import { ChevronDown } from "lucide-react";
import { HealthBand } from "@/components/console/health/HealthBand";
import type { HealthTile } from "@/lib/readings/trace-signals/view";
import { tileDelta, tileFigure } from "@/lib/views/health/tiles";

export interface HealthReadingsProps {
  /** The band's tiles, in band order. A null value reads as a dash. */
  tiles: readonly HealthTile[];
  /**
   * Whether "Show trends" opens the full band. Off while collecting, when the
   * band would only repeat the dashes.
   */
  expandable?: boolean;
}

/**
 * The band's figures as one quiet line: label, figure and change, side by side.
 * The figures are context for the problems below, not the page's headline, so
 * a newcomer reads what went wrong first. "Show trends" opens the full band
 * (ranges, sub lines, sparklines) in place. A native `<details>` with the app's
 * `.disclosure` animation, so it works without script and keeps the band in
 * the server markup.
 */
export function HealthReadings({ tiles, expandable = true }: HealthReadingsProps) {
  const line = (
    <>
      <span className="eyebrow text-warm-muted/70">Readings</span>
      {tiles.map((tile) => (
        <Reading key={tile.key} tile={tile} />
      ))}
    </>
  );
  const lineClass = "flex flex-wrap items-center gap-x-5 gap-y-1.5 px-4 py-2.5";
  if (!expandable) {
    return (
      <section
        data-health-readings="true"
        aria-label="Readings"
        className="card-enter rounded-xl border border-forest-300/70 bg-forest-600/25"
      >
        <div className={lineClass}>{line}</div>
      </section>
    );
  }
  return (
    <details
      data-health-readings="true"
      className="disclosure group card-enter rounded-xl border border-forest-300/70 bg-forest-600/25"
    >
      <summary
        className={cn(lineClass, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}
      >
        {line}
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-warm-muted transition-colors group-hover:text-cream">
          <span className="group-open:hidden">Show trends</span>
          <span className="hidden group-open:inline">Hide trends</span>
          <ChevronDown
            className="size-3.5 transition-transform group-open:rotate-180"
            aria-hidden
          />
        </span>
      </summary>
      <div className="px-4 pb-4">
        <HealthBand tiles={tiles} />
      </div>
    </details>
  );
}

function Reading({ tile }: { tile: HealthTile }) {
  const figure = tileFigure(tile);
  const delta = tileDelta(tile);
  return (
    <span
      data-health-reading={tile.key}
      className="inline-flex items-baseline gap-1.5 whitespace-nowrap"
    >
      <span className="text-xs text-warm-muted">{tile.label}</span>
      <span
        className={cn(
          "font-mono text-xs font-medium tabular-nums",
          figure.ready ? "text-cream-dim" : "text-warm-muted/60",
        )}
      >
        {figure.value}
      </span>
      {/* Its own element, so the figure and the unit never run together ("9.4per 100 turns"). Long units drop on a phone. */}
      {figure.unit && (
        <span className="hidden font-mono text-xs text-warm-muted/70 sm:inline">{figure.unit}</span>
      )}
      {delta && (
        <span
          title={delta.description}
          data-reading-delta={delta.tone}
          className={cn(
            "font-mono text-[11px] tabular-nums",
            delta.direction === "flat"
              ? "text-warm-muted"
              : delta.tone === "good"
                ? "text-green"
                : "text-coral",
          )}
        >
          {delta.text}
          <span className="sr-only">, {delta.description.toLowerCase()}</span>
        </span>
      )}
    </span>
  );
}
