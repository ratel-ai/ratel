"use client";

import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "../cn";
import { FLOATING_SURFACE } from "./popover";

export type SelectOption = { value: string; label: string };

export type SelectProps = {
  options: readonly SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Submitted with the surrounding form under this name. */
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
};

export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  placeholder = "Select…",
  disabled,
  id,
  className,
  ...aria
}: SelectProps) {
  return (
    <BaseSelect.Root
      items={options}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange?.(next);
      }}
      name={name}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        id={id}
        aria-label={aria["aria-label"]}
        className={cn(
          "inline-flex h-8 min-w-36 items-center justify-between gap-2 rounded-md border border-line-strong bg-app px-2.5 text-ui text-fg outline-none hover:border-line-active focus-visible:ring-2 focus-visible:ring-focus/40 data-disabled:opacity-50",
          className,
        )}
      >
        <BaseSelect.Value
          placeholder={placeholder}
          className="truncate data-placeholder:text-fg-faint"
        />
        <BaseSelect.Icon className="text-fg-subtle">
          <ChevronsUpDown className="size-3.5" aria-hidden />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} className="z-popover">
          <BaseSelect.Popup className={cn(FLOATING_SURFACE, "min-w-(--anchor-width) p-1")}>
            <BaseSelect.List className="max-h-(--available-height) overflow-y-auto">
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  className="flex h-8 cursor-default items-center gap-2 rounded-md pr-2 pl-7 text-ui text-fg outline-none select-none focus-visible:outline-none data-highlighted:bg-hover"
                >
                  <BaseSelect.ItemIndicator className="absolute left-3 text-fg">
                    <Check className="size-3.5" aria-hidden />
                  </BaseSelect.ItemIndicator>
                  <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
