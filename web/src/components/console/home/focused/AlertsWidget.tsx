import { BellOff, BellRing, ChevronRight, CircleCheck } from "lucide-react";
import Link from "next/link";
import { EmptyAction, WidgetEmpty } from "@/components/console/home/focused/WidgetEmpty";
import type { FocusedAlerts } from "@/lib/views/home/focused-load";

/** The alert rules that alert now, newest change first. Each row opens its alert. */
export function AlertsWidget({ alerts }: { alerts: FocusedAlerts }) {
  const { items, href, newHref, rules } = alerts;
  if (items.length === 0)
    return rules?.total === 0 ? (
      <WidgetEmpty
        name="alerts-none"
        shape="alerts"
        title="No alerts yet"
        description="An alert tells you when a number crosses its threshold."
        action={<EmptyAction href={newHref}>Create alert</EmptyAction>}
      />
    ) : (
      <WidgetEmpty {...quiet(rules)} action={<EmptyAction href={href}>Open Alerts</EmptyAction>} />
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

/** Rules exist, as far as is known, and none fires. Paused and without data are not "all is well". */
function quiet(rules: FocusedAlerts["rules"]) {
  if (rules && rules.on === 0)
    return {
      name: "alerts-paused",
      icon: BellOff,
      title: "All alerts are paused",
      description: "A paused alert checks nothing. Turn one on to see it here when it fires.",
    };
  if (rules && rules.noData === rules.on)
    return {
      name: "alerts-no-data",
      shape: "alerts" as const,
      title: "No data to check yet",
      description: "Alerts are on, but their numbers have no data. Send traces to start them.",
    };
  return {
    name: "alerts-quiet",
    icon: CircleCheck,
    title: "No alert fires now",
    description: "An alert rule that crosses its threshold shows up here.",
  };
}
