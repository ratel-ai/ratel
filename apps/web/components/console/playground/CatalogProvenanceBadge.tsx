import { cn } from "@ratel/design-system/cn";
import { Cloud, Eye, Plug } from "lucide-react";
import { CATALOG_PROVENANCE, type CatalogProvenance } from "@/lib/ingest/catalogs/vocabulary";
import { Tooltip } from "./BenchTooltip";

export type { CatalogProvenance };

/** Provenance reads as an icon, not a sentence. */
const PROVENANCE_ICON: Record<CatalogProvenance, typeof Cloud> = {
  cloud: Cloud,
  managed: Plug,
  observed: Eye,
};

const PROVENANCE_CLASS: Record<CatalogProvenance, string> = {
  cloud: "border-coral/30 bg-coral/[0.07] text-coral",
  managed: "border-green/30 bg-green/10 text-green",
  observed: "border-forest-300 bg-base-deep/45 text-warm-muted",
};

export function CatalogProvenanceBadge({
  provenance,
  showLabel = false,
}: {
  provenance: CatalogProvenance;
  /** Spell the short label out beside the icon (legends, detail headers). */
  showLabel?: boolean;
}) {
  const meta = CATALOG_PROVENANCE[provenance];
  const Icon = PROVENANCE_ICON[provenance];
  return (
    <Tooltip content={meta.description}>
      <span
        data-catalog-provenance={provenance}
        aria-label={meta.description}
        role="img"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the tooltip.
        tabIndex={0}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border outline-none",
          "focus-visible:ring-2 focus-visible:ring-coral/50",
          showLabel ? "px-2 py-0.5" : "size-5 justify-center",
          PROVENANCE_CLASS[provenance],
        )}
      >
        <Icon className="size-3" strokeWidth={1.8} aria-hidden />
        {showLabel && (
          <span className="font-mono text-[9px] uppercase tracking-[0.08em]">{meta.label}</span>
        )}
      </span>
    </Tooltip>
  );
}
