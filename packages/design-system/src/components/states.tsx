import type { LucideIcon } from "lucide-react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { DotEmblem } from "./dot-matrix";

/**
 * No data yet, nothing matches, or not set up. Sits inside the area that would
 * hold the data: an icon, one line, one sentence, one action (DESIGN.md, Empty
 * states). No illustrations outside onboarding.
 */
export function EmptyState({
  icon: Icon,
  emblem = false,
  title,
  description,
  action,
  secondary,
  className,
}: {
  icon?: LucideIcon;
  /** The brand's resting dot mark instead of an icon: first-run and "nothing here yet" moments. */
  emblem?: boolean;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** A docs link or a quieter second action. */
  secondary?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      {emblem ? <DotEmblem className="mb-4" /> : null}
      {!emblem && Icon ? (
        <Icon className="mb-3 size-5 text-fg-subtle" strokeWidth={1.5} aria-hidden />
      ) : null}
      <p className="text-sm font-semibold text-fg">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-fg-muted">{description}</p> : null}
      {action || secondary ? (
        <div className="mt-4 flex items-center gap-3">
          {action}
          {secondary}
        </div>
      ) : null}
    </div>
  );
}

/** Loading that mirrors the final layout, so nothing shifts when data lands. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-md bg-hover motion-reduce:animate-none", className)}
    />
  );
}

const CALLOUT_TONE = {
  info: { icon: Info, className: "border-line bg-raised", iconClass: "text-info" },
  success: { icon: CircleCheck, className: "border-line bg-raised", iconClass: "text-success" },
  warning: {
    icon: TriangleAlert,
    className: "border-warning/30 bg-warning-subtle",
    iconClass: "text-warning",
  },
  danger: {
    icon: CircleAlert,
    className: "border-danger/30 bg-danger-subtle",
    iconClass: "text-danger",
  },
} as const;

/**
 * One important notice per page at most: what is going on and what to do. A
 * failed section shows one in its place while the rest of the page still works.
 */
export function Callout({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof CALLOUT_TONE;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, className: toneClass, iconClass } = CALLOUT_TONE[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "note"}
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-4 py-3",
        toneClass,
        className,
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", iconClass)} aria-hidden />
      {/* Wide enough to read before the action moves under it on narrow screens. */}
      <div className="min-w-0 flex-1 basis-56 text-sm">
        {title ? <p className="font-medium text-fg">{title}</p> : null}
        {children ? <div className={cn("text-fg-muted", title && "mt-0.5")}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 max-sm:ml-7">{action}</div> : null}
    </div>
  );
}
