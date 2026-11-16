"use client";

import { Slider } from "@base-ui/react/slider";
import {
  clampHybridShare,
  HYBRID_MAX_SHARE,
  HYBRID_MIN_SHARE,
} from "@/lib/synthesis/playground/scoring";

/**
 * The hybrid mix as one control: the filled part of the track is the share
 * given to words, the rest to meaning, and both are named beside their
 * number so no colour has to be decoded.
 *
 * The value is the keyword share, so dragging right grows the filled part
 * under the cursor. The travel stops short of both ends: a hybrid search always
 * mixes something, and the pure cases are their own options.
 */
export function MixSlider({
  embeddingWeight,
  onChange,
}: {
  embeddingWeight: number;
  onChange: (weight: number) => void;
}) {
  const words = clampHybridShare(Math.round((1 - embeddingWeight) * 100));
  return (
    <Slider.Root
      value={words}
      min={HYBRID_MIN_SHARE}
      max={HYBRID_MAX_SHARE}
      step={5}
      onValueChange={(value) => {
        const next = Array.isArray(value) ? value[0] : value;
        onChange((100 - next) / 100);
      }}
      aria-label="Mix of matching by words and by meaning"
      className="flex w-full flex-col gap-1.5"
    >
      <div className="flex items-baseline justify-between text-xs text-fg-muted">
        <span>
          Words <span className="tabular-nums text-fg">{words}%</span>
        </span>
        <span>
          Meaning <span className="tabular-nums text-fg">{100 - words}%</span>
        </span>
      </div>
      <Slider.Control className="flex h-4 w-full items-center">
        <Slider.Track className="h-1 w-full rounded-full bg-line-strong select-none">
          <Slider.Indicator className="rounded-full bg-fg-muted" />
          <Slider.Thumb className="size-3.5 rounded-full border border-line-active bg-fg outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay" />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
