"use client";

import { Button, IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@ratel/design-system/popover";
import { Check, ChevronsUpDown, Pencil, Plus } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import { limitText } from "@/lib/views/scorers/format";
import type { PickerScorer } from "@/lib/views/scorers/picker";
import { ScorerPanel, type ScorerPanelTarget } from "./ScorerPanel";
import { useScorerPicker } from "./ScorerPickerProvider";

/**
 * Pick a scorer, create one or edit one, without leaving the surface. Each option says where the
 * scorer is used. New scorer and Edit open the same Panel; a new scorer is picked after its save.
 * Nothing shows while scorers are off (no `ScorerPickerProvider` data).
 */
export function ScorerPicker({
  value,
  onChange,
  label,
  id,
  filter,
  allLabel,
  taskId,
  trigger,
  className,
  placeholder = "Choose a scorer",
}: {
  /** The chosen scorer; null: none, or every scorer with `allLabel`. */
  value: string | null;
  onChange: (id: string | null, scorer: PickerScorer | null) => void;
  /** Names the trigger when no `Field` labels it. */
  label?: string;
  /** From a `Field`, which labels the trigger. */
  id?: string;
  /** Only the scorers this surface can read, for example pass or fail ones. */
  filter?: (scorer: PickerScorer) => boolean;
  /** An option for null first, for example "All scorers". */
  allLabel?: string;
  /** A new scorer starts with this task. */
  taskId?: string;
  /** In place of the select-like button, for example an "Add scorer" button and its words. */
  trigger?: { render: ReactElement; children: ReactNode };
  className?: string;
  placeholder?: string;
}) {
  const picker = useScorerPicker();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<ScorerPanelTarget | null>(null);
  // A new scorer is picked once the list has it, so `onChange` sees it among the scorers.
  const [created, setCreated] = useState<string | null>(null);
  const all = picker?.data.scorers;
  useEffect(() => {
    const scorer = created ? all?.find(({ id }) => id === created) : undefined;
    if (!scorer) return;
    setCreated(null);
    onChange(scorer.id, scorer);
  }, [created, all, onChange]);
  if (!picker || !all) return null;
  const { count, limit } = picker.data;
  const scorers = filter ? all.filter(filter) : all;
  const chosen = all.find((scorer) => scorer.id === value) ?? null;
  const room = picker.data.unread
    ? { full: true, text: "The scorers could not be read. Reload the page to try again." }
    : limitText(count, limit);
  const { full, text: limitWords } = room;

  function pick(scorer: PickerScorer | null) {
    setOpen(false);
    onChange(scorer?.id ?? null, scorer);
  }
  function openPanel(target: ScorerPanelTarget) {
    setOpen(false);
    setPanel(target);
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id={id}
          aria-label={label}
          render={
            trigger?.render ?? (
              <button
                type="button"
                className={cn(
                  "inline-flex h-8 min-w-36 items-center justify-between gap-2 rounded-md border border-line-strong bg-app px-2.5 text-ui text-fg outline-none hover:border-line-active focus-visible:ring-2 focus-visible:ring-focus/40",
                  className,
                )}
              />
            )
          }
        >
          {trigger ? (
            trigger.children
          ) : (
            <>
              <span className={cn("truncate", !chosen && !allLabel && "text-fg-faint")}>
                {chosen?.name ?? (value === null && allLabel ? allLabel : placeholder)}
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
            </>
          )}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-1">
          <ul aria-label="Scorers" className="flex max-h-72 flex-col overflow-y-auto">
            {allLabel ? (
              <Option name={allLabel} selected={value === null} onPick={() => pick(null)} />
            ) : null}
            {scorers.map((scorer) => (
              <Option
                key={scorer.id}
                name={scorer.name}
                detail={usedIn(scorer.usage.total)}
                selected={scorer.id === value}
                onPick={() => pick(scorer)}
                onEdit={() => openPanel({ scorerId: scorer.id })}
              />
            ))}
            {scorers.length === 0 && !allLabel ? (
              <li className="px-2 py-3 text-ui text-fg-muted">No scorer fits here yet.</li>
            ) : null}
          </ul>
          <div className="mt-1 flex flex-col gap-1 border-t border-line px-1 pt-2 pb-1">
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              disabled={full}
              onClick={() => openPanel({ scorerId: null, taskId })}
            >
              <Plus className="size-3.5" aria-hidden />
              New scorer
            </Button>
            <p className="px-2 text-xs text-fg-subtle">{limitWords}</p>
          </div>
        </PopoverContent>
      </Popover>
      <ScorerPanel
        target={panel}
        onClose={() => setPanel(null)}
        onSaved={(scorer, isNew) => {
          if (isNew) setCreated(scorer.id);
        }}
      />
    </>
  );
}

/** "Used in 1 place", "Used in 3 places". */
export function usedIn(total: number): string {
  return `Used in ${formatInteger(total)} ${total === 1 ? "place" : "places"}`;
}

function Option({
  name,
  detail,
  selected,
  onPick,
  onEdit,
}: {
  name: string;
  detail?: string;
  selected: boolean;
  onPick: () => void;
  onEdit?: () => void;
}) {
  return (
    <li className="flex items-center gap-1 rounded-md hover:bg-hover">
      <button
        type="button"
        aria-pressed={selected}
        onClick={onPick}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-1 pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus/40"
      >
        <span className="flex size-3.5 shrink-0 text-fg">
          {selected ? <Check className="size-3.5" aria-hidden /> : null}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-ui text-fg">{name}</span>
          {detail ? <span className="text-xs text-fg-subtle">{detail}</span> : null}
        </span>
      </button>
      {onEdit ? (
        <IconButton label={`Edit ${name}`} size="icon-sm" icon={<Pencil />} onClick={onEdit} />
      ) : null}
    </li>
  );
}
