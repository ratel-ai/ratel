import { type ReactNode, useId } from "react";
import { cn } from "../cn";

/**
 * A titled group on a page. The heading is a sentence-case `h2`; nothing sits
 * above it. `surface` frames the body for groups that need an edge (a table, a
 * code sample); most sections need none.
 */
export function Section({
  title,
  description,
  actions,
  surface = false,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  surface?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-3", className)}>
      <div className="flex min-h-7 flex-wrap items-end gap-x-3 gap-y-2">
        {/* Wide enough to read before the actions move under it on narrow screens. */}
        <div className="min-w-0 flex-1 basis-56">
          <h2 id={id} className="text-sm font-semibold text-fg">
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-ui text-fg-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {surface ? (
        <div className="rounded-lg border border-line bg-raised">{children}</div>
      ) : (
        children
      )}
    </section>
  );
}
