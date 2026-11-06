import { cva } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../cn";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";

const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "border border-line text-fg-muted",
        success: "bg-success-subtle text-success",
        warning: "bg-warning-subtle text-warning",
        danger: "bg-danger-subtle text-danger",
        info: "bg-info-subtle text-info",
        accent: "bg-accent-subtle text-accent-mark",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

/** Short metadata ("Managed", "3 suggestions"). At most two per row. */
export function Badge({
  tone,
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return <span className={cn(badgeVariants({ tone }), className)}>{children}</span>;
}

const DOT: Record<Exclude<Tone, "accent">, string> = {
  neutral: "bg-fg-faint",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

/**
 * Status as a dot plus its word. The word is required: status never relies on
 * color alone (DESIGN.md, Color).
 */
export function StatusDot({
  tone,
  label,
  className,
}: {
  tone: Exclude<Tone, "accent">;
  label: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-ui text-fg-muted", className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
      {label}
    </span>
  );
}
