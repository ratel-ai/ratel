"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Menu, MenuContent, MenuGroup, MenuItem, MenuTrigger } from "@ratel/design-system/menu";
import { ChevronDown, TriangleAlert } from "lucide-react";
import type { SuggestedPrompt } from "@/lib/synthesis/playground/prompts";

const GROUP = "font-mono text-[10px] uppercase tracking-[0.09em] text-warm-muted";
const ITEM =
  "h-auto cursor-pointer rounded-lg py-1.5 text-xs text-cream-dim data-highlighted:bg-forest/60 data-highlighted:text-cream";

/** Real prompts behind one button, with room to say what each one is. */
export function SuggestionMenu({
  suggestions,
  disabled,
  onPick,
}: {
  suggestions: readonly SuggestedPrompt[];
  disabled: boolean;
  /** Receives the whole suggestion: a flagged one carries its disagreement. */
  onPick: (suggestion: SuggestedPrompt) => void;
}) {
  const flagged = suggestions.filter((s) => s.source === "flagged");
  const frequent = suggestions.filter((s) => s.source === "frequent");

  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        render={
          <Button
            variant="outline"
            className="h-8 rounded-lg border-forest-300 px-2.5 text-xs font-normal text-cream-dim hover:bg-forest/50 hover:text-cream data-[popup-open]:bg-forest/50 data-[popup-open]:text-cream"
          >
            Try a real prompt
            <ChevronDown aria-hidden strokeWidth={1.5} className="size-4" />
          </Button>
        }
      />
      <MenuContent className="max-h-80 w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border-forest-300 bg-base-deep shadow-xl">
        {flagged.length > 0 ? (
          <MenuGroup label="Arms disagreed on these" labelClassName={GROUP}>
            {flagged.map((suggestion) => (
              <MenuItem
                key={suggestion.text}
                className={ITEM}
                icon={<TriangleAlert aria-hidden className="size-3.5 text-coral" />}
                onClick={() => onPick(suggestion)}
              >
                <Line text={suggestion.text} meta={`${suggestion.mismatches} differed`} flagged />
              </MenuItem>
            ))}
          </MenuGroup>
        ) : null}
        {frequent.length > 0 ? (
          <MenuGroup label="Asked most often" labelClassName={GROUP}>
            {frequent.map((suggestion) => (
              <MenuItem key={suggestion.text} className={ITEM} onClick={() => onPick(suggestion)}>
                <Line text={suggestion.text} meta={`${suggestion.count}×`} />
              </MenuItem>
            ))}
          </MenuGroup>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

function Line({ text, meta, flagged = false }: { text: string; meta: string; flagged?: boolean }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <span
        className={cn(
          "shrink-0 font-mono text-[10px] tabular-nums",
          flagged ? "text-coral" : "text-warm-muted",
        )}
      >
        {meta}
      </span>
    </span>
  );
}
