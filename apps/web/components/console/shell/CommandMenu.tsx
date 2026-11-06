"use client";

import { Dialog } from "@base-ui/react/dialog";
import { cn } from "@ratel/design-system/cn";
import { Kbd } from "@ratel/design-system/kbd";
import { CornerDownLeft, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useId, useMemo, useState } from "react";
import type { CommandEntry } from "@/lib/console/navigation";
import { searchCommands } from "@/lib/console/scope/command-search";

/** ⌘K: every page and project, searched by name. */
export function CommandMenu({
  open,
  onOpenChange,
  entries,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: readonly CommandEntry[];
}) {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const results = useMemo(() => searchCommands(entries, query).slice(0, 40), [entries, query]);
  const active = Math.min(activeIndex, Math.max(0, results.length - 1));

  function reset() {
    setQuery("");
    setActiveIndex(0);
  }

  function choose(entry: CommandEntry) {
    onOpenChange(false);
    reset();
    router.push(entry.href);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      const entry = results[active];
      if (entry) {
        event.preventDefault();
        choose(entry);
      }
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-dialog bg-scrim transition-opacity duration-160 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none" />
        <Dialog.Popup className="fixed top-[14vh] left-1/2 z-dialog flex w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-overlay text-fg shadow-dialog outline-none focus-visible:outline-none transition-[scale,opacity] duration-160 ease-enter data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none">
          <Dialog.Title className="sr-only">Search pages and projects</Dialog.Title>
          <div className="flex h-12 items-center gap-2.5 border-b border-line px-4">
            <Search className="size-4 shrink-0 text-fg-subtle" aria-hidden />
            <input
              // biome-ignore lint/a11y/noAutofocus: the dialog exists to type into
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
              aria-label="Search pages and projects"
              placeholder="Search pages and projects…"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActiveIndex(0);
              }}
              onKeyDown={onKeyDown}
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint focus-visible:outline-none max-md:text-base"
            />
            <Kbd>Esc</Kbd>
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label="Results"
            className="max-h-[min(24rem,60vh)] overflow-y-auto p-1.5"
          >
            {results.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-fg-muted">
                No page or project matches “{query}”.
              </p>
            ) : null}
            {results.map((entry, index) => {
              const heading =
                index === 0 || results[index - 1]?.group !== entry.group ? entry.group : null;
              return (
                <div key={entry.id} role="presentation">
                  {heading ? (
                    <div
                      role="presentation"
                      className="px-2.5 pt-2.5 pb-1 text-xs font-medium text-fg-subtle"
                    >
                      {heading}
                    </div>
                  ) : null}
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input drives the keyboard through aria-activedescendant */}
                  <div
                    id={`${listId}-${index}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === active}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => choose(entry)}
                    className={cn(
                      "flex h-9 cursor-pointer items-center gap-2 rounded-md px-2.5 text-ui text-fg-muted",
                      index === active && "bg-hover text-fg",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    {index === active ? (
                      <CornerDownLeft className="size-3.5 text-fg-subtle" aria-hidden />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-xs text-fg-subtle">
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to move
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>↵</Kbd> to open
            </span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
