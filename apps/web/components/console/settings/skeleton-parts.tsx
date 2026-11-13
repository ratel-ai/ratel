import { cn } from "@ratel/design-system/cn";
import { Skeleton } from "@ratel/design-system/states";
import type { ReactNode } from "react";

/**
 * Pieces for the settings and organization skeletons. Each mirrors the
 * primitive it stands in for (DESIGN.md, Loading: the final layout's rows and
 * columns), so nothing shifts when the data lands.
 */

/**
 * The root of a skeleton. `page` marks a full page (header included) that
 * owns its edges.
 */
export function SkeletonRoot({
  label,
  page = false,
  children,
}: {
  label: string;
  page?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-page={page ? "v2" : undefined}
      role="status"
      aria-busy="true"
      className="flex min-h-full flex-col"
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden className="flex flex-col">
        {children}
      </div>
    </div>
  );
}

/** A PageHeader: the title, optional actions on the right, optional tabs below. */
export function SkeletonHeader({
  action = false,
  description = false,
  tabs = 0,
}: {
  action?: boolean;
  description?: boolean;
  tabs?: number;
}) {
  return (
    <div className="border-b border-line px-6 lg:px-8">
      <div className="flex min-h-13 items-center gap-4 py-2">
        <Skeleton className="h-5 w-32" />
        {action ? <Skeleton className="ml-auto h-8 w-32" /> : null}
      </div>
      {description ? <Skeleton className="-mt-1 mb-3 h-4 w-80 max-w-full" /> : null}
      {tabs > 0 ? (
        <div className="flex gap-1 pb-2">
          {Array.from({ length: tabs }, (_, index) => (
            <Skeleton key={index} className="h-7 w-20" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A PageBody. */
export function SkeletonBody({ wide = false, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-8 px-6 py-6 lg:px-8", !wide && "max-w-[75rem]")}>
      {children}
    </div>
  );
}

/** A Section: its heading, an optional action, then the body. */
export function SkeletonSection({
  action = false,
  children,
}: {
  action?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-7 items-end gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
        {action ? <Skeleton className="h-8 w-36" /> : null}
      </div>
      {children}
    </div>
  );
}

/** A DataTable: the header rule, then rows of 36 px. */
export function SkeletonTable({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="flex flex-col">
      <div className="flex h-9 items-center justify-between gap-6 border-b border-line px-3">
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton key={index} className={cn("h-3", index === 0 ? "w-28" : "w-14")} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="flex h-9 items-center justify-between gap-6 border-b border-line px-3"
        >
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className={cn("h-3", column === 0 ? "w-1/4" : "w-16")} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A StatRow of `count` cells. */
export function SkeletonStats({ count = 3 }: { count?: number }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line",
        count >= 4 ? "lg:grid-cols-4" : "lg:grid-cols-3",
      )}
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex h-24 flex-col gap-2 bg-app p-4">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

/** A form field: the label, then a 32 px control. */
export function SkeletonField({ wide = false }: { wide?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="h-3 w-20" />
      <Skeleton className={cn("h-8", wide ? "w-full" : "w-full max-w-md")} />
    </div>
  );
}

/** A CodeBlock: the bar, then a few lines. */
export function SkeletonCode({ lines = 6 }: { lines?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex h-10 items-center gap-2 border-b border-line px-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="ml-auto h-6 w-28" />
      </div>
      <div className="flex flex-col gap-2 p-3">
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton key={index} className={cn("h-3", index % 3 === 2 ? "w-1/2" : "w-4/5")} />
        ))}
      </div>
    </div>
  );
}
