"use client";

import { Popover } from "@base-ui/react/popover";
import { cn } from "@ratel/design-system/cn";
import { ChevronDown } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { signalTone } from "@/components/console/health/card-model";
import {
  chipFiguresUseful,
  FILTER_SEARCH_THRESHOLD,
  filterLayout,
  memberLabel,
  type ProblemGroup,
} from "@/components/console/health/problem-groups";
import { clampFigures } from "@/lib/readings/trace-signals/claims";
import type { SignalView } from "@/lib/readings/trace-signals/view";

/**
 * The tool filter inside an open problem row, built to stay one calm line
 * however many tools share the problem: "All", the few tools with the most
 * impact as chips, and "+N more" for the rest in a small scrollable list
 * (with a filter box once the list is long). A tool chosen from the list shows
 * as one more active chip. At phone width the line scrolls sideways inside the
 * card rather than wrapping.
 */

/** A figure's colour, kept quiet: the chip is a filter, not an alarm. */
const TONE_TEXT = {
  coral: "text-coral/80",
  amber: "text-ctx-tools/80",
  muted: "text-warm-muted",
} as const;

function figureOf(member: SignalView): string {
  return clampFigures(member.figure.display);
}

export function ToolFilter({
  group,
  selectedId,
  onSelect,
}: {
  group: ProblemGroup;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { inline, activeExtra, rest } = filterLayout(group, selectedId);
  const showFigures = chipFiguresUseful(group);
  const hiddenCount = rest.length - (activeExtra ? 1 : 0);

  return (
    <div
      role="group"
      aria-label="Show tools"
      data-tool-filter="true"
      className="-mx-1 flex flex-nowrap items-center gap-1.5 overflow-x-auto px-1 py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <FilterChip pressed={selectedId === null} onClick={() => onSelect(null)} data-tool-chip="all">
        <span className="font-medium">All</span>
        <span className="tabular-nums text-warm-muted">{group.members.length}</span>
      </FilterChip>
      {[...inline, ...(activeExtra ? [activeExtra] : [])].map((member) => (
        <FilterChip
          key={member.id}
          pressed={selectedId === member.id}
          onClick={() => onSelect(member.id)}
          data-tool-chip={member.id}
          // With figures off the chips, a hover still tells the number.
          title={showFigures ? undefined : `${memberLabel(member)} · ${figureOf(member)}`}
        >
          <span className="font-mono text-[12px]">{memberLabel(member)}</span>
          {showFigures && (
            <span className={cn("tabular-nums", TONE_TEXT[signalTone(member.severity, false)])}>
              {figureOf(member)}
            </span>
          )}
        </FilterChip>
      ))}
      {hiddenCount > 0 && (
        <MoreTools
          rest={rest}
          selectedId={selectedId}
          hiddenCount={hiddenCount}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

function FilterChip({
  pressed,
  onClick,
  title,
  children,
  ...data
}: {
  pressed: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
  "data-tool-chip": string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      title={title}
      {...data}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] leading-5 outline-none transition-colors",
        "focus-visible:rounded-full! focus-visible:outline-offset-[-2px]!",
        pressed
          ? "bg-forest text-cream ring-1 ring-warm-muted/40"
          : "bg-base-deep/60 text-cream-dim hover:bg-forest/60 hover:text-cream",
      )}
    >
      {children}
    </button>
  );
}

/**
 * "+N more": the tools past the chips, in a small popover. Each line shows the
 * tool's figure; a filter box appears once the list is long. Arrow keys move
 * through the list, Enter picks, Esc closes and returns focus to the button.
 */
function MoreTools({
  rest,
  selectedId,
  hiddenCount,
  onSelect,
}: {
  rest: readonly SignalView[];
  selectedId: string | null;
  hiddenCount: number;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchable = rest.length > FILTER_SEARCH_THRESHOLD;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? rest.filter((member) => memberLabel(member).toLowerCase().includes(needle))
    : rest;

  const focusItem = (step: 1 | -1 | "first") => {
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = step === "first" ? 0 : Math.min(items.length - 1, Math.max(0, at + step));
    items[next]?.focus();
  };

  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(event.key === "ArrowDown" ? 1 : -1);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Popover.Trigger
        data-tool-more={hiddenCount}
        className="group inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] leading-5 text-cream-dim outline-none transition-colors hover:bg-forest/60 hover:text-cream focus-visible:rounded-full! focus-visible:outline-offset-[-2px]! data-[popup-open]:bg-forest data-[popup-open]:text-cream"
      >
        +{hiddenCount} more
        <ChevronDown
          className="size-3.5 text-warm-muted transition-transform duration-200 group-data-[popup-open]:rotate-180"
          aria-hidden
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={6}
          className="z-50 outline-none"
        >
          <Popover.Popup
            data-tool-more-popup="true"
            // Straight into the list: the filter box when there is one, else the first tool.
            initialFocus={() =>
              inputRef.current ??
              listRef.current?.querySelector<HTMLButtonElement>("button") ??
              true
            }
            className="w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-forest-300 bg-base-deep/97 shadow-[0_24px_70px_-20px_rgba(0,0,0,0.9)] outline-none backdrop-blur-xl transition-[opacity,transform] duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
          >
            {searchable && (
              <div className="border-b border-forest-300/70 p-1.5">
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      focusItem("first");
                    }
                  }}
                  placeholder={`Find one of ${rest.length} tools`}
                  aria-label="Find a tool"
                  aria-controls={listId}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 w-full rounded-lg border border-forest-300 bg-base-deep/70 px-2.5 font-mono text-xs text-cream placeholder:font-sans placeholder:text-warm-muted/60 focus:border-coral focus:outline-none"
                />
              </div>
            )}
            <ul
              ref={listRef}
              id={listId}
              aria-label="More tools"
              onKeyDown={onListKey}
              className="max-h-72 overflow-y-auto p-1"
            >
              {shown.map((member) => (
                <li key={member.id}>
                  <button
                    type="button"
                    aria-pressed={selectedId === member.id}
                    data-tool-option={member.id}
                    onClick={() => {
                      onSelect(member.id);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={cn(
                      "flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors",
                      "hover:bg-forest focus-visible:bg-forest focus-visible:rounded-lg! focus-visible:outline-offset-[-2px]!",
                      selectedId === member.id ? "bg-forest text-cream" : "text-cream-dim",
                    )}
                  >
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs"
                      title={memberLabel(member)}
                    >
                      {memberLabel(member)}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-mono text-[11px] tabular-nums",
                        TONE_TEXT[signalTone(member.severity, false)],
                      )}
                    >
                      {figureOf(member)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {shown.length === 0 && (
              <p className="px-3 py-3 text-center text-[12px] text-warm-muted">No tool matches.</p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
