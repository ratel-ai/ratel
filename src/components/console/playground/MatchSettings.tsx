"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@ratel/design-system/popover";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { Check, ChevronDown } from "lucide-react";
import { EMBEDDINGS_REGION_SHORT } from "@/components/console/embeddings/RegionNotice";
import { MixSlider } from "@/components/console/playground/MixSlider";
import type { RankMode, RankOptions } from "@/lib/synthesis/playground/types";
import { modeHint, modeLabel } from "@/lib/synthesis/playground/view";

const MODES: readonly RankMode[] = ["bm25", "embeddings", "hybrid"];
const TOP_OPTIONS = ["3", "5", "10", "25"] as const;

/**
 * How a search is matched and how many results it shows, behind one quiet
 * button. Most people never change either: keyword match is how the agent
 * searches, so it is the default, and the button reads as a summary of what
 * the next search will do rather than as a control panel to learn first.
 */
export function MatchSettings({
  options,
  onChange,
  embeddingsEnabled,
  embeddingsRegionNotice = false,
}: {
  options: RankOptions;
  onChange: (next: RankOptions) => void;
  embeddingsEnabled: boolean;
  /** RC-601, `cloud-embeddings-region-notice`: the semantic modes say where they run. */
  embeddingsRegionNotice?: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-fg-muted")}
        aria-label={`Matching: ${modeLabel(options.mode)}, top ${options.topKTools}. Change`}
      >
        {modeLabel(options.mode)}
        <span aria-hidden className="text-fg-faint">
          ·
        </span>
        <span className="tabular-nums">Top {options.topKTools}</span>
        <ChevronDown aria-hidden strokeWidth={1.5} className="size-3.5 text-fg-subtle" />
      </PopoverTrigger>
      <PopoverContent title="How to match" className="w-80">
        <div role="radiogroup" aria-label="How to match" className="-mx-1 flex flex-col gap-0.5">
          {MODES.map((mode) => {
            const selected = options.mode === mode;
            const unavailable = mode !== "bm25" && !embeddingsEnabled;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={unavailable}
                onClick={() => onChange({ ...options, mode })}
                className={cn(
                  "flex items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-120",
                  "hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
                  selected && "bg-selected hover:bg-selected",
                )}
              >
                <Check
                  aria-hidden
                  strokeWidth={1.5}
                  className={cn("mt-0.5 size-3.5 shrink-0", selected ? "text-fg" : "invisible")}
                />
                <span className="min-w-0">
                  <span className="block text-ui font-medium text-fg">{modeLabel(mode)}</span>
                  <span className="block text-xs text-fg-subtle">
                    {unavailable
                      ? "Not set up here: it needs an embedding provider."
                      : embeddingsRegionNotice && mode !== "bm25"
                        ? `${modeHint(mode)} ${EMBEDDINGS_REGION_SHORT}`
                        : modeHint(mode)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {options.mode === "hybrid" ? (
          <div className="mt-3 border-t border-line pt-3">
            <MixSlider
              embeddingWeight={options.embeddingWeight}
              onChange={(embeddingWeight) => onChange({ ...options, embeddingWeight })}
            />
          </div>
        ) : null}

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
          <span className="text-xs font-medium text-fg-muted">Results per list</span>
          <SegmentedControl
            label="Results per list"
            options={TOP_OPTIONS.map((value) => ({ value, label: value }))}
            value={String(options.topKTools) as (typeof TOP_OPTIONS)[number]}
            onValueChange={(value) => {
              // One number for both lists: separate budgets are an engine
              // detail nobody testing a description wants to think about.
              const top = Number(value);
              onChange({ ...options, topKSkills: top, topKTools: top });
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
