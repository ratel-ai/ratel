"use client";

import { cn } from "@ratel/design-system/cn";
import type { ReactNode } from "react";

export type ChoiceOption<T extends string> = {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  /** A choice that is shown and cannot be taken, with its mark ("Coming soon"). */
  disabled?: boolean;
  mark?: ReactNode;
};

/** One choice of a few, as radio rows with a line of help each. Arrow keys move, as for radios. */
export function Choice<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  error,
}: {
  legend: ReactNode;
  name: string;
  value: T;
  options: ReadonlyArray<ChoiceOption<T>>;
  onChange: (value: T) => void;
  error?: string | null;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-xs font-medium text-fg-muted">{legend}</legend>
      <div className="flex flex-col gap-1">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex items-start gap-2.5 rounded-md border px-3 py-2 text-ui",
              option.value === value ? "border-line-active bg-selected" : "border-line",
              option.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-hover",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
              className="mt-0.5 size-3.5 accent-[var(--ds-accent)]"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-2 text-fg">
                {option.label}
                {option.mark}
              </span>
              {option.description ? (
                <span className="text-xs text-fg-subtle">{option.description}</span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </fieldset>
  );
}
