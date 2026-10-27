// biome-ignore-all lint/a11y/noLabelWithoutControl: the label wraps the Base UI control, which renders the input.
"use client";

import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Check, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";

/** A checkbox with its label as one generous hit target. */
export function Checkbox({
  label,
  checked,
  defaultChecked,
  indeterminate,
  onCheckedChange,
  disabled,
  name,
  className,
  tabIndex,
  "aria-label": ariaLabel,
}: {
  label?: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  className?: string;
  /** -1 keeps it out of the tab order, for a row that toggles it from the keyboard itself. */
  tabIndex?: number;
  "aria-label"?: string;
}) {
  const box = (
    <BaseCheckbox.Root
      checked={checked}
      defaultChecked={defaultChecked}
      indeterminate={indeterminate}
      onCheckedChange={(next) => onCheckedChange?.(next)}
      disabled={disabled}
      name={name}
      // Only when set: Base UI lets even an undefined prop replace its own tab stop.
      {...(tabIndex === undefined ? {} : { tabIndex })}
      aria-label={label ? undefined : ariaLabel}
      className="flex size-4 shrink-0 items-center justify-center rounded border border-line-active bg-app text-accent-fg outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app data-checked:border-accent data-checked:bg-accent data-indeterminate:border-accent data-indeterminate:bg-accent data-disabled:opacity-50"
    >
      <BaseCheckbox.Indicator className="flex data-unchecked:hidden">
        {indeterminate ? (
          <Minus className="size-3" aria-hidden />
        ) : (
          <Check className="size-3" aria-hidden />
        )}
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
  if (!label) return box;
  return (
    <label
      className={cn(
        "inline-flex min-h-6 cursor-pointer items-center gap-2 text-ui text-fg",
        className,
      )}
    >
      {box}
      {label}
    </label>
  );
}

export function Switch({
  label,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  name,
  className,
}: {
  label: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "inline-flex min-h-6 cursor-pointer items-center gap-2 text-ui text-fg",
        className,
      )}
    >
      <BaseSwitch.Root
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={(next) => onCheckedChange?.(next)}
        disabled={disabled}
        name={name}
        className="relative flex h-5 w-8 shrink-0 rounded-full border border-line-strong bg-selected p-0.5 outline-none transition-colors duration-120 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app data-checked:border-accent data-checked:bg-accent data-disabled:opacity-50"
      >
        <BaseSwitch.Thumb className="size-3.5 rounded-full bg-fg shadow-sm transition-[translate] duration-120 ease-enter data-checked:translate-x-3 motion-reduce:transition-none" />
      </BaseSwitch.Root>
      {label}
    </label>
  );
}
