"use client";

import { Slider } from "@base-ui/react/slider";
import {
  clampHybridShare,
  HYBRID_MAX_SHARE,
  HYBRID_MIN_SHARE,
} from "@/lib/synthesis/playground/scoring";

/** The BM25/embeddings mix, as ONE control. */
export function MixSlider({
  embeddingWeight,
  onChange,
}: {
  embeddingWeight: number;
  onChange: (weight: number) => void;
}) {
  const bm25 = clampHybridShare(Math.round((1 - embeddingWeight) * 100));
  return (
    <Slider.Root
      value={bm25}
      min={HYBRID_MIN_SHARE}
      max={HYBRID_MAX_SHARE}
      step={5}
      onValueChange={(value) => {
        const next = Array.isArray(value) ? value[0] : value;
        onChange((100 - next) / 100);
      }}
      aria-label="Mix of BM25 and embeddings"
      className="flex w-52 flex-col gap-0.5"
    >
      <div className="flex items-baseline justify-between font-mono text-[10px] leading-none">
        <span className="w-24 shrink-0 text-indigo-300">
          <span className="tabular-nums">{bm25}%</span> BM25
        </span>
        <span className="w-24 shrink-0 text-right text-green">
          <span className="tabular-nums">{100 - bm25}%</span> embeddings
        </span>
      </div>
      <Slider.Control className="flex h-3 w-full items-center">
        <Slider.Track className="h-1.5 w-full rounded-full bg-green/35 select-none">
          <Slider.Indicator className="rounded-full bg-indigo-300/70" />
          <Slider.Thumb className="size-3 rounded-full border border-base-deep bg-cream transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral" />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
