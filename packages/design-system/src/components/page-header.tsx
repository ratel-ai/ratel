import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { cn } from "../cn";

export type Crumb = { label: string; href: string };

export type PageHeaderProps = {
  /** The page's one `h1`. */
  title: ReactNode;
  /** Parent pages for nested views ("Traces / Run 8f3a"). */
  crumbs?: readonly Crumb[];
  /** At most one sentence. Teach with the content, not here. */
  description?: ReactNode;
  /** Right side: the time window, then secondary actions, then the one primary action. */
  actions?: ReactNode;
  /** A `TabNav` for pages with sections. */
  tabs?: ReactNode;
  className?: string;
};

/**
 * Every page starts here (DESIGN.md, Layout): a 52 px bar with the title on
 * the left and actions on the right, an optional sentence, and tabs below. No
 * eyebrow, no intro paragraph.
 */
export function PageHeader({
  title,
  crumbs,
  description,
  actions,
  tabs,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn("border-b border-line px-6 lg:px-8", className)}>
      <div className="flex min-h-13 flex-wrap items-center gap-x-4 gap-y-2 py-2">
        {/* The basis keeps the title readable: past it, the actions wrap below. */}
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
          {crumbs?.map((crumb) => (
            <Fragment key={crumb.href}>
              <Link
                href={crumb.href}
                className="shrink-0 rounded-md text-xl font-semibold tracking-tight text-fg-subtle outline-none hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-focus"
              >
                {crumb.label}
              </Link>
              <span aria-hidden className="text-xl text-fg-faint">
                /
              </span>
            </Fragment>
          ))}
          <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight text-fg">{title}</h1>
        </div>
        {actions ? (
          <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {description ? (
        <p className="-mt-1 max-w-3xl pb-3 text-sm text-fg-muted">{description}</p>
      ) : null}
      {tabs ? <div className="pb-2">{tabs}</div> : null}
    </header>
  );
}

/** The padded body under a PageHeader. `wide` for tables, maps and Traces. */
export function PageBody({
  children,
  wide = false,
  className,
}: {
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col gap-8 px-6 py-6 lg:px-8", !wide && "max-w-[75rem]", className)}
    >
      {children}
    </div>
  );
}

/**
 * The root of every v2 page. Marks the page as owning its edges, so the shell
 * drops the padding it keeps for v1 screens, and stacks header and body.
 */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-page="v2" className={cn("flex min-h-full flex-col", className)}>
      {children}
    </div>
  );
}
