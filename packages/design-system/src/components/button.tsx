"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import type { VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { buttonVariants } from "./button-variants";
import { Spinner } from "./spinner";
import { Tooltip } from "./tooltip";

export type ButtonProps = BaseButton.Props &
  VariantProps<typeof buttonVariants> & {
    /** Keeps the label and adds a spinner while an action is pending. */
    loading?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <BaseButton
      data-slot="button"
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      // A button that becomes pending after a press keeps focus (Base UI, Loading states).
      focusableWhenDisabled={loading}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {loading ? <Spinner /> : null}
      {children}
    </BaseButton>
  );
}

export type IconButtonProps = Omit<ButtonProps, "children" | "size"> & {
  /** Accessible name and tooltip text. Icon-only buttons always have both. */
  label: string;
  icon: ReactNode;
  size?: "icon" | "icon-sm";
  /** Shortcut shown in the tooltip, e.g. "[" or "⌘K". */
  shortcut?: string;
};

export function IconButton({
  label,
  icon,
  size = "icon",
  variant = "ghost",
  shortcut,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <Button aria-label={label} size={size} variant={variant} {...props}>
        {icon}
      </Button>
    </Tooltip>
  );
}
