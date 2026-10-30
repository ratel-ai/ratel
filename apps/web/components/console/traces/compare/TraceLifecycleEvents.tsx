import { cn } from "@ratel/design-system/cn";
import { presentationFor } from "@/lib/synthesis/traces/event-presentation";
import { formatAttributeValue, formatTimestamp } from "@/lib/synthesis/traces/format";
import type { TraceLifecycleEvent } from "@/lib/synthesis/traces/queries";

interface SalientAttribute {
  key: string;
  label: string;
  value: string;
}

const EVENT_ORDER = [
  "ratel.experiment.results",
  "ratel.experiment.comparison",
  "ratel.experiment.skip",
  "ratel.experiment.fallback",
  "ratel.experiment.drop",
  "ratel.experiment.outcome",
] as const;
const IDENTITY_ATTRIBUTE_KEYS = new Set([
  "ratel.experiment.id",
  "ratel.experiment.arm",
  "ratel.experiment.role",
  "ratel.experiment.selection_id",
  "ratel.experiment.result_attrs",
]);
const ATTRIBUTE_PRIORITY: Readonly<Record<string, readonly string[]>> = {
  "ratel.experiment.results": ["ratel.experiment.result_count", "ratel.experiment.result_ids"],
  "ratel.experiment.comparison": [
    "ratel.experiment.agreement.top1",
    "ratel.experiment.agreement.exact_order",
    "ratel.experiment.agreement.jaccard_at_k",
    "ratel.experiment.agreement.k",
  ],
  "ratel.experiment.skip": ["ratel.experiment.skip.reason"],
  "ratel.experiment.fallback": [
    "ratel.experiment.fallback.effective_arm",
    "ratel.experiment.fallback.reason",
  ],
  "ratel.experiment.drop": ["ratel.experiment.drop.reason"],
};

export function TraceLifecycleEvents({ events }: { events: readonly TraceLifecycleEvent[] }) {
  return (
    <section aria-labelledby="trace-lifecycle-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">Decision timeline</div>
          <h2
            id="trace-lifecycle-title"
            className="mt-1 font-display text-lg font-semibold tracking-tight text-cream"
          >
            Experiment lifecycle
          </h2>
        </div>
        <p className="font-mono text-[10px] uppercase tracking-wide text-warm-muted">
          {formatEventCount(events.length)} attached to this trace
        </p>
      </div>

      {events.length === 0 ? (
        <div className="mt-3 rounded-2xl border border-dashed border-forest-300 bg-forest-600/20 px-5 py-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted">
            No arm lifecycle events attached
          </p>
          <p className="mt-2 text-xs leading-relaxed text-cream-dim">
            This trace has no results, comparison, skip, fallback, drop, or outcome records in
            retained lifecycle logs.
          </p>
        </div>
      ) : (
        <ol className="card-enter mt-3 overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/35">
          {events.map((event, index) => (
            <LifecycleEventRow key={event.id} event={event} continued={index < events.length - 1} />
          ))}
        </ol>
      )}
    </section>
  );
}

export function TraceLifecycleComparison({
  leftEvents,
  rightEvents,
}: {
  leftEvents: readonly TraceLifecycleEvent[];
  rightEvents: readonly TraceLifecycleEvent[];
}) {
  const leftCounts = eventCounts(leftEvents);
  const rightCounts = eventCounts(rightEvents);

  return (
    <section
      aria-labelledby="trace-lifecycle-comparison-title"
      className="overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/35"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-forest-300 bg-base-deep/30 px-4 py-2.5">
        <span className="h-px w-5 bg-coral/80" aria-hidden />
        <h2 id="trace-lifecycle-comparison-title" className="eyebrow">
          Experiment lifecycle
        </h2>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-warm-muted/65">
          arm events by type
        </span>
      </header>

      <div className="grid grid-cols-[minmax(8rem,1fr)_minmax(6rem,0.55fr)_minmax(6rem,0.55fr)] text-xs">
        <ComparisonHeading label="Event" />
        <ComparisonHeading label="Trace A" detail={formatEventCount(leftEvents.length)} bordered />
        <ComparisonHeading label="Trace B" detail={formatEventCount(rightEvents.length)} bordered />
        {EVENT_ORDER.map((eventName) => {
          const presentation = presentationFor(eventName);
          const left = leftCounts.get(eventName) ?? 0;
          const right = rightCounts.get(eventName) ?? 0;
          const changed = left !== right;
          return (
            <div key={eventName} className="contents">
              <div className="flex items-center gap-2 border-t border-forest-300/45 px-4 py-2.5 text-cream-dim">
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", presentation.markerClass)}
                  aria-hidden
                />
                {presentation.label}
              </div>
              <ComparisonCount value={left} changed={changed} />
              <ComparisonCount value={right} changed={changed} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LifecycleEventRow({
  event,
  continued,
}: {
  event: TraceLifecycleEvent;
  continued: boolean;
}) {
  const presentation = presentationFor(event.eventName);
  const attributes = salientAttributes(event);

  return (
    <li className="grid grid-cols-[2.5rem_minmax(0,1fr)] border-b border-forest-300/45 last:border-0">
      <div className="relative flex justify-center bg-base-deep/20 pt-5">
        <span
          className={cn(
            "relative z-10 size-2.5 rounded-sm ring-4 ring-base-deep/70",
            presentation.markerClass,
          )}
          aria-hidden
        />
        {continued && <span className="absolute bottom-0 top-7 w-px bg-forest-300" aria-hidden />}
      </div>

      <div className="min-w-0 px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-md border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em]",
                  presentation.badgeClass,
                )}
              >
                {presentation.label}
              </span>
              {event.experimentArm && (
                <span className="truncate font-mono text-xs text-cream">{event.experimentArm}</span>
              )}
              {event.experimentRole && (
                <span className="rounded-md border border-indigo-300/20 bg-indigo-300/[0.055] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-indigo-300">
                  {event.experimentRole}
                </span>
              )}
            </div>
            <p className="mt-1 text-[11px] text-warm-muted">
              {presentation.description}
              {event.experimentName ? ` · ${event.experimentName}` : ""}
            </p>
          </div>
          <time
            dateTime={event.occurredAt.toISOString()}
            className="shrink-0 font-mono text-[10px] tabular-nums text-warm-muted/75"
          >
            {formatTimestamp(event.occurredAt)}
          </time>
        </div>

        {attributes.length > 0 && (
          <dl className="mt-3 flex flex-wrap gap-1.5">
            {attributes.map((attribute) => (
              <div
                key={attribute.key}
                className="flex min-w-0 items-baseline gap-1.5 rounded-md border border-forest-300 bg-base-deep/35 px-2 py-1 font-mono text-[9px]"
                title={`${attribute.label}: ${attribute.value}`}
              >
                <dt className="shrink-0 text-warm-muted">{attribute.label}</dt>
                <dd className="max-w-64 truncate text-cream-dim">{attribute.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </li>
  );
}

function ComparisonHeading({
  label,
  detail,
  bordered = false,
}: {
  label: string;
  detail?: string;
  bordered?: boolean;
}) {
  return (
    <div
      className={cn(
        "px-4 py-3 font-mono text-[10px] uppercase tracking-wide text-warm-muted",
        bordered && "border-l border-forest-300/55",
      )}
    >
      {label}
      {detail && (
        <span className="mt-0.5 block normal-case tracking-normal text-warm-muted/65">
          {detail}
        </span>
      )}
    </div>
  );
}

function ComparisonCount({ value, changed }: { value: number; changed: boolean }) {
  return (
    <div
      className={cn(
        "border-l border-t border-forest-300/45 px-4 py-2.5 font-mono tabular-nums text-cream-dim",
        changed && "bg-indigo-300/[0.065] text-cream",
      )}
    >
      <span className="flex items-center gap-2">
        {changed && <span className="size-1.5 shrink-0 rounded-full bg-indigo-300" aria-hidden />}
        {value.toLocaleString("en-US")}
      </span>
    </div>
  );
}

function eventCounts(events: readonly TraceLifecycleEvent[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.eventName, (counts.get(event.eventName) ?? 0) + 1);
  }
  return counts;
}

function salientAttributes(event: TraceLifecycleEvent): SalientAttribute[] {
  const priority = ATTRIBUTE_PRIORITY[event.eventName] ?? [];
  const priorityIndex = new Map(priority.map((key, index) => [key, index]));

  return Object.entries(event.experimentAttrs)
    .filter(([key, value]) => !IDENTITY_ATTRIBUTE_KEYS.has(key) && value !== null && value !== "")
    .sort(([left], [right]) => {
      const leftPriority = priorityIndex.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = priorityIndex.get(right) ?? Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority || left.localeCompare(right);
    })
    .slice(0, 4)
    .map(([key, value]) => ({
      key,
      label: attributeLabel(key),
      value: attributeValue(key, value),
    }));
}

function attributeLabel(key: string): string {
  return key.replace("ratel.experiment.", "").replaceAll("_", " ").replaceAll(".", " · ");
}

function attributeValue(key: string, value: unknown): string {
  if (
    typeof value === "boolean" &&
    (key.endsWith("agreement.top1") || key.endsWith("agreement.exact_order"))
  ) {
    return value ? "match" : "different";
  }
  if (typeof value === "number") {
    return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
  }
  return formatAttributeValue(value);
}

function formatEventCount(value: number): string {
  return `${value.toLocaleString("en-US")} event${value === 1 ? "" : "s"}`;
}
