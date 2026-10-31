import { ChevronRight, Wrench } from "lucide-react";
import { CHAINS_EMPTY, chainWeightText } from "@/components/console/health/journey-copy";
import type { JourneyChain } from "@/lib/readings/trace-signals/flow-journey-insights";

/**
 * "Common chains", read off the journey: runs of calls that repeat across
 * turns, longest shape first. Listed under the journey in "Show all";
 * pointing at one lights it on the map.
 */

/** A marked chip: coral where failed runs stop, amber where the time goes. */
export type ToolChipTone = "failing" | "slow";

const CHIP_TONE: Readonly<Record<ToolChipTone, { box: string; icon: string }>> = {
  failing: { box: "border-coral/60 bg-coral/10 text-cream", icon: "text-coral" },
  slow: { box: "border-ctx-tools/60 bg-ctx-tools/10 text-cream", icon: "text-ctx-tools" },
};

export function ToolChip({
  label,
  tone,
  note,
}: {
  label: string;
  tone?: ToolChipTone | null;
  note?: string | null;
}) {
  const marked = tone ? CHIP_TONE[tone] : null;
  return (
    <span
      title={note ?? undefined}
      data-tool-chip-tone={tone ?? undefined}
      className={`inline-flex max-w-[15rem] items-center gap-1.5 rounded-lg border px-2 py-1 font-mono text-[11px] ${
        marked ? marked.box : "border-forest-300 bg-forest-600 text-cream-dim"
      }`}
    >
      <Wrench
        aria-hidden
        className={`size-3 shrink-0 ${marked ? marked.icon : "text-warm-muted"}`}
      />
      <span className="truncate">{label}</span>
      {note && <span className="sr-only">: {note}</span>}
    </span>
  );
}

export interface CommonChainsProps {
  chains: readonly JourneyChain[];
  /** The chain being pointed at, lit on the journey above. */
  active?: JourneyChain | null;
  onPoint?: (chain: JourneyChain | null) => void;
}

/**
 * Up to six chains of calls, each written out as its tools in order, with how
 * many turns ran it. Pointing at one (or focusing it) lights it on the journey.
 */
export function CommonChains({ chains, active = null, onPoint }: CommonChainsProps) {
  if (chains.length === 0) {
    return (
      <p data-journey-chains="empty" className="text-xs leading-5 text-warm-muted">
        {CHAINS_EMPTY}
      </p>
    );
  }
  return (
    <ol data-journey-chains="true" className="grid gap-1 sm:grid-cols-2">
      {chains.map((chain) => {
        const key = chain.tools.join(">");
        const on = active?.tools.join(">") === key;
        return (
          <li key={key}>
            <button
              type="button"
              data-journey-chain={key}
              aria-pressed={on}
              aria-label={`${chain.labels.join(", then ")}: ${chainWeightText(chain)}`}
              onPointerEnter={() => onPoint?.(chain)}
              onPointerLeave={() => onPoint?.(null)}
              onFocus={() => onPoint?.(chain)}
              onBlur={() => onPoint?.(null)}
              className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-coral ${
                on ? "bg-forest-300/40" : "hover:bg-forest-300/25"
              }`}
            >
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {chain.labels.map((label, i) => (
                  <span key={i} className="inline-flex items-center gap-1">
                    {i > 0 && <ChevronRight aria-hidden className="size-3 text-warm-muted/70" />}
                    <ToolChip label={label} />
                  </span>
                ))}
              </span>
              <span className="ml-auto text-right font-mono text-[11px] tabular-nums text-warm-muted">
                {chainWeightText(chain)}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
