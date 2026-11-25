import { buttonVariants } from "@ratel/design-system/button-variants";
import { EmptyState } from "@ratel/design-system/states";
import { BellRing, ChevronRight, CircleCheck } from "lucide-react";
import Link from "next/link";
import type { FocusedAlerts } from "@/lib/views/home/focused-load";

/** The alert rules that alert now, newest change first. Each row opens its alert. */
export function AlertsWidget({ alerts }: { alerts: FocusedAlerts }) {
  const { items, href } = alerts;
  if (items.length === 0)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyState
          icon={CircleCheck}
          title="No alert fires now"
          description="An alert rule that crosses its threshold shows up here."
          action={
            <Link href={href} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              Open Alerts
            </Link>
          }
          className="py-6"
        />
      </div>
    );
  return (
    <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
      {items.map(({ id, name, value, condition, since, href }) => (
        <li key={id}>
          <Link
            href={href}
            className="group flex min-h-11 items-center gap-3 px-4 py-2 outline-none transition-colors duration-120 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
          >
            <BellRing aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-danger" />
            <span className="sr-only">Alerting: </span>
            <span className="min-w-0 flex-1 text-ui break-words text-fg">{name}</span>
            <span className="flex shrink-0 flex-wrap items-baseline justify-end gap-x-2">
              <span className="text-ui font-medium text-fg tabular-nums">{value}</span>
              <span className="text-xs text-fg-subtle">
                {condition}
                {since ? ` · ${since}` : ""}
              </span>
            </span>
            <ChevronRight
              aria-hidden
              className="size-4 shrink-0 text-fg-subtle group-hover:text-fg"
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}
