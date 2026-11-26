import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { EmptyState } from "@ratel/design-system/states";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { TRACES_DOCS } from "@/lib/console/docs-links";
import type { TracesSeen } from "@/lib/views/home/focused-load";
import type { OverviewWindow } from "@/lib/views/home/overview-model";

/**
 * A widget with nothing to draw: a still picture of what it draws, in gray, or its icon, then why
 * it is empty and what to do. Never a skeleton, which says that it loads. In a short widget the
 * picture makes room for the words.
 */

/** What decides how a person gets data into an empty widget. */
export interface EmptyWindow {
  root: string;
  window: OverviewWindow;
  tracesSeen: TracesSeen | null;
}

export function WidgetEmpty({
  name,
  icon: Icon,
  figure,
  title,
  description,
  action,
  note,
  padded = true,
}: {
  /** For the tests and the screenshots: which state this is. */
  name: string;
  icon?: LucideIcon;
  /** In place of the icon. It is decoration: the words say the same. */
  figure?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  /** A quiet line under the action. */
  note?: ReactNode;
  /** False in a card that has its own padding. */
  padded?: boolean;
}) {
  return (
    <div
      data-widget-empty={name}
      className={cn(
        "flex min-h-0 flex-1 flex-col items-center justify-center-safe overflow-y-auto",
        padded && "p-4",
      )}
    >
      {figure ? (
        <div
          aria-hidden
          className="mb-3 flex min-h-0 w-full shrink basis-28 justify-center overflow-hidden max-lg:min-h-28"
        >
          {figure}
        </div>
      ) : Icon ? (
        // Whole or not at all: an icon that does not fit under the strut wraps out of the box.
        <div
          aria-hidden
          className="flex min-h-0 w-5 shrink basis-8 flex-col flex-wrap content-start overflow-hidden"
        >
          <span className="h-px w-5" />
          <Icon className="size-5 shrink-0 text-fg-subtle" strokeWidth={1.5} />
        </div>
      ) : null}
      <EmptyState
        title={title}
        description={description}
        action={action}
        // In the narrowest widget the action breaks its line too.
        className="w-full shrink-0 px-0 py-0 [&_a]:h-auto [&_a]:min-h-7 [&_a]:max-w-full [&_a]:whitespace-normal"
      />
      {note ? <div className="mt-3 shrink-0 text-center text-xs text-fg-subtle">{note}</div> : null}
    </div>
  );
}

/** Where the traces are outside the window, a longer window; else how to send them. */
export function TracesAction({ root, window, tracesSeen }: EmptyWindow) {
  return tracesSeen === "before" && window === 7 ? (
    <EmptyAction href={`${root}?range=30d`}>Show 30 days</EmptyAction>
  ) : (
    <Link
      href={TRACES_DOCS}
      target="_blank"
      rel="noreferrer"
      className={buttonVariants({ variant: "secondary", size: "sm" })}
    >
      Set up tracing
    </Link>
  );
}

export function EmptyAction({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className={buttonVariants({ variant: "secondary", size: "sm" })}>
      {children}
    </Link>
  );
}

export function EmptyNoteLink({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      className="rounded-sm text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
    >
      {children}
    </Link>
  );
}
