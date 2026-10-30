"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Input, Textarea } from "@ratel/design-system/input";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { Play } from "lucide-react";
import type { KeyboardEvent } from "react";
import { MAX_QUERY_CHARS } from "@/lib/synthesis/playground/contract";
import type { SuggestedPrompt } from "@/lib/synthesis/playground/prompts";
import type { RankMode, RankOptions } from "@/lib/synthesis/playground/types";
import { modeHint, modeLabel } from "@/lib/synthesis/playground/view";
import { FIELD } from "./field";
import { MixSlider } from "./MixSlider";
import { SuggestionMenu } from "./SuggestionMenu";

const MODES: RankMode[] = ["bm25", "embeddings", "hybrid"];

/** The prompt and its two settings. */
export function PromptPanel({
  query,
  onQueryChange,
  suggestions,
  options,
  onOptionsChange,
  onRun,
  onPickSuggestion,
  pending,
  embeddingsEnabled,
  editCount,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  suggestions: readonly SuggestedPrompt[];
  options: RankOptions;
  onOptionsChange: (next: RankOptions) => void;
  onRun: (query: string) => void;
  /** A picked suggestion, which may carry the disagreement it came from. */
  onPickSuggestion: (suggestion: SuggestedPrompt) => void;
  pending: boolean;
  embeddingsEnabled: boolean;
  editCount: number;
}) {
  const canRun = query.trim().length > 0 && !pending;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canRun) {
      event.preventDefault();
      onRun(query);
    }
  }

  return (
    <section
      aria-labelledby="playground-prompt-title"
      className="card-enter rounded-2xl border border-forest-300 bg-forest-600/40 p-3"
    >
      <h2 id="playground-prompt-title" className="sr-only">
        Prompt
      </h2>

      <Textarea
        rows={2}
        value={query}
        maxLength={MAX_QUERY_CHARS}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        aria-label="Prompt to test against the catalog"
        placeholder="What is the agent trying to do? e.g. review this PR before I merge it"
        className={cn(FIELD, "min-h-0 resize-none text-[0.95rem]")}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="inverse"
          className="rounded-lg text-sm has-data-[icon=inline-start]:pl-2 active:translate-y-px"
          onClick={() => onRun(query)}
          disabled={!canRun}
          aria-keyshortcuts="Meta+Enter"
        >
          <Play data-icon="inline-start" aria-hidden />
          {pending ? "Testing…" : "Test prompt"}
          {!pending && editCount > 0 && (
            <span
              className="ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-coral/25 px-1 font-mono text-[10px] tabular-nums text-coral"
              title={`Your ${editCount} unsaved edit${editCount === 1 ? "" : "s"} will be ranked beside your saved catalog`}
            >
              {editCount}
            </span>
          )}
        </Button>

        {suggestions.length > 0 && (
          <SuggestionMenu suggestions={suggestions} disabled={pending} onPick={onPickSuggestion} />
        )}

        <div className="ml-auto flex items-center gap-2">
          <SegmentedControl
            variant="inverse"
            label="Matching method"
            value={options.mode}
            onValueChange={(mode) => onOptionsChange({ ...options, mode })}
            options={MODES.map((mode) => {
              const unavailable = mode !== "bm25" && !embeddingsEnabled;
              return {
                value: mode,
                label: modeLabel(mode),
                disabled: unavailable,
                title: unavailable
                  ? "No embedding provider is configured here. Set OPENAI_API_KEY."
                  : modeHint(mode),
              };
            })}
          />

          <div
            className={cn(
              "overflow-hidden transition-[max-width,opacity] duration-200 ease-out motion-reduce:transition-none",
              options.mode === "hybrid" ? "max-w-52 opacity-100" : "max-w-0 opacity-0",
            )}
            aria-hidden={options.mode !== "hybrid"}
          >
            <MixSlider
              embeddingWeight={options.embeddingWeight}
              onChange={(embeddingWeight) => onOptionsChange({ ...options, embeddingWeight })}
            />
          </div>

          <div
            className="flex shrink-0 items-center gap-1.5"
            title="How many results each list shows"
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.09em] text-warm-muted">
              Top
            </span>
            <Input
              aria-label="Results per list"
              type="number"
              min={1}
              max={25}
              value={options.topKSkills}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isInteger(next) && next >= 1 && next <= 25) {
                  onOptionsChange({
                    ...options,
                    topKSkills: next,
                    topKTools: next,
                  });
                }
              }}
              className="h-7 w-12 border-forest-300 bg-base-deep/40 px-1 text-center text-[11px] tabular-nums text-cream hover:border-forest-300 focus-visible:border-coral focus-visible:ring-0"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
