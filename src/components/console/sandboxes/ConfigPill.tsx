"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@ratel/design-system/popover";
import { ChevronDown, RotateCcw } from "lucide-react";
import {
  BASELINE_PILL,
  configPillText,
  diffWindow,
  type ParamChange,
} from "@/lib/views/sandboxes/playground-state";

/**
 * The config pill of the next run (spec §3.7): "baseline = production config"
 * with no edits and the production hash, else the changed params. It opens the
 * diff against the code defaults: the default and the edited value of each.
 */
export function ConfigPill({
  diff,
  configHash,
  productionHash,
  onResetAll,
}: {
  diff: readonly ParamChange[];
  configHash: string | null;
  productionHash: string | null;
  onResetAll: () => void;
}) {
  const text = configPillText({ changed: diff.map((d) => d.name), configHash, productionHash });
  const baseline = text === BASELINE_PILL;
  return (
    <Popover>
      <PopoverTrigger
        className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "max-w-80 gap-2")}
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            baseline ? "bg-success" : diff.length > 0 ? "bg-warning" : "bg-fg-faint",
          )}
        />
        <span className="truncate">{text}</span>
        <ChevronDown className="size-3.5 text-fg-subtle" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        title="Changes from the code"
        align="end"
        className="w-[28rem] max-w-[calc(100vw-2rem)]"
      >
        {diff.length === 0 ? (
          <p className="text-ui text-fg-muted">
            {baseline
              ? "The next run uses the code defaults, the same config production runs with."
              : productionHash
                ? "The next run uses the code defaults. Production ran with another config in the last 30 days."
                : "The next run uses the code defaults. No production run of this sandbox in the last 30 days."}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex max-h-80 flex-col gap-3 overflow-y-auto">
              {diff.map((change) => {
                const shown = diffWindow(change.from, change.to);
                return (
                  <li key={change.name} className="flex flex-col gap-1">
                    <span className="font-mono text-xs font-medium text-fg">{change.name}</span>
                    <DiffValue label="Code" text={shown.from} />
                    <DiffValue label="Edited" text={shown.to} edited />
                  </li>
                );
              })}
            </ul>
            <Button variant="ghost" size="sm" onClick={onResetAll} className="self-start">
              <RotateCcw className="size-3.5" aria-hidden />
              Reset all to code
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function DiffValue({
  label,
  text,
  edited = false,
}: {
  label: string;
  text: string;
  edited?: boolean;
}) {
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 text-xs">
      <span className="text-fg-subtle">{label}</span>
      <span
        className={cn(
          "line-clamp-3 font-mono break-words whitespace-pre-wrap",
          edited ? "text-fg" : "text-fg-muted line-through decoration-fg-faint",
        )}
      >
        {text}
      </span>
    </div>
  );
}
