"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Menu, MenuContent, MenuGroup, MenuItem, MenuTrigger } from "@ratel/design-system/menu";
import { ChevronDown, Search } from "lucide-react";
import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";
import { MatchSettings } from "@/components/console/playground/MatchSettings";
import { MAX_QUERY_CHARS } from "@/lib/synthesis/playground/contract";
import type { SuggestedPrompt } from "@/lib/synthesis/playground/prompts";
import type { RankOptions } from "@/lib/synthesis/playground/types";

/** Real asks shown as one-click chips before the first search. */
const CHIPS = 3;

/**
 * The ask, and the real asks to borrow one from.
 *
 * One field and one button, like any search; Enter searches (Shift+Enter makes
 * a new line). Before the first search the real asks sit under the field as
 * chips, because clicking one is the fastest way to understand the page. After
 * it they fold into one "Real asks" menu, so the results get the screen.
 */
export function SearchForm({
  query,
  onQueryChange,
  onSearch,
  suggestions,
  onPickSuggestion,
  pending,
  options,
  onOptionsChange,
  embeddingsEnabled,
  inputRef,
  compact,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: (query: string) => void;
  suggestions: readonly SuggestedPrompt[];
  onPickSuggestion: (suggestion: SuggestedPrompt) => void;
  pending: boolean;
  options: RankOptions;
  onOptionsChange: (next: RankOptions) => void;
  embeddingsEnabled: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Results are on screen: the asks fold into a menu. */
  compact: boolean;
}) {
  const canSearch = query.trim() !== "" && !pending;
  const frequent = suggestions.filter((suggestion) => suggestion.source === "frequent");
  const chips = (frequent.length > 0 ? frequent : suggestions).slice(0, CHIPS);
  const chipTexts = new Set(chips.map((chip) => chip.text));
  const menuItems = compact
    ? suggestions
    : suggestions.filter((suggestion) => !chipTexts.has(suggestion.text));

  useAutoHeight(inputRef, query);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSearch) onSearch(query);
  }

  return (
    <form
      role="search"
      aria-label="Test a search"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSearch) onSearch(query);
      }}
    >
      <div className="rounded-lg border border-line-strong bg-raised transition-[border-color] duration-120 hover:border-line-active focus-within:border-fg-subtle focus-within:hover:border-fg-subtle">
        <label htmlFor="test-search-ask" className="sr-only">
          What would someone ask your agent?
        </label>
        <div className="flex items-start gap-2.5 px-3 pt-3">
          <Search aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
          <textarea
            id="test-search-ask"
            ref={inputRef}
            rows={1}
            value={query}
            maxLength={MAX_QUERY_CHARS}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="What would someone ask your agent?"
            autoComplete="off"
            spellCheck={false}
            className="max-h-40 min-h-6 w-full resize-none bg-transparent text-sm leading-6 text-fg outline-none placeholder:text-fg-faint focus-visible:outline-none max-md:text-base"
          />
        </div>
        <div className="flex items-center gap-1 px-2 pt-2 pb-2">
          <MatchSettings
            options={options}
            onChange={onOptionsChange}
            embeddingsEnabled={embeddingsEnabled}
          />
          {compact && menuItems.length > 0 ? (
            <AsksMenu
              label="Real asks"
              items={menuItems}
              pending={pending}
              onPick={onPickSuggestion}
            />
          ) : null}
          <Button
            type="submit"
            variant="primary"
            className="ml-auto"
            disabled={query.trim() === ""}
            loading={pending}
          >
            {pending ? "Searching…" : "Search"}
          </Button>
        </div>
      </div>

      {!compact && chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-fg-subtle">Try</span>
          {chips.map((chip) => (
            <button
              key={chip.text}
              type="button"
              disabled={pending}
              onClick={() => onPickSuggestion(chip)}
              className="inline-flex h-7 max-w-72 items-center rounded-md border border-line bg-app px-2 text-ui text-fg-muted outline-none transition-colors duration-120 hover:border-line-strong hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
            >
              <span className="min-w-0 truncate">{chip.text}</span>
            </button>
          ))}
          {menuItems.length > 0 ? (
            <AsksMenu label="More" items={menuItems} pending={pending} onPick={onPickSuggestion} />
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

/** Every real ask, grouped by why it is worth testing, with its count. */
function AsksMenu({
  label,
  items,
  pending,
  onPick,
}: {
  label: string;
  items: readonly SuggestedPrompt[];
  pending: boolean;
  onPick: (suggestion: SuggestedPrompt) => void;
}) {
  const frequent = items.filter((item) => item.source === "frequent");
  const flagged = items.filter((item) => item.source === "flagged");
  return (
    <Menu>
      <MenuTrigger
        disabled={pending}
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-fg-muted")}
      >
        {label}
        <ChevronDown aria-hidden strokeWidth={1.5} className="size-3.5 text-fg-subtle" />
      </MenuTrigger>
      <MenuContent className="w-96 max-w-[calc(100vw-2rem)]">
        {frequent.length > 0 ? (
          <MenuGroup label="Asked most often">
            {frequent.map((item) => (
              <AskItem key={item.text} item={item} meta={`${item.count}×`} onPick={onPick} />
            ))}
          </MenuGroup>
        ) : null}
        {flagged.length > 0 ? (
          <MenuGroup label="Ranked differently in an experiment">
            {flagged.map((item) => (
              <AskItem
                key={item.text}
                item={item}
                meta={`${item.mismatches ?? 0} differed`}
                onPick={onPick}
              />
            ))}
          </MenuGroup>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

function AskItem({
  item,
  meta,
  onPick,
}: {
  item: SuggestedPrompt;
  meta: string;
  onPick: (suggestion: SuggestedPrompt) => void;
}) {
  return (
    <MenuItem onClick={() => onPick(item)}>
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{item.text}</span>
        <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{meta}</span>
      </span>
    </MenuItem>
  );
}

/** Grows the field with its text, up to its max height, so a long ask is never hidden. */
function useAutoHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  const last = useRef<string | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || last.current === value) return;
    last.current = value;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [ref, value]);
}
