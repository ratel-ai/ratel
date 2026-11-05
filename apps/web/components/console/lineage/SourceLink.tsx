import { cn } from "@ratel/design-system/cn";
import {
  Activity,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  FlaskConical,
  Gauge,
  Hammer,
  ListChecks,
  type LucideIcon,
  MessageSquareText,
  Rocket,
} from "lucide-react";
import Link from "next/link";
import { hrefFor, shortId } from "@/lib/views/lineage/refs";
import { KIND_NOUNS, type LineageRef, STAGE_LABELS } from "@/lib/views/lineage/types";

/**
 * Where an object came from, one step back on the spine (RC-45): "From trace
 * 4f2a91d…a9c07e", "From insight Wrong tool keeps showing up". A pin with the
 * kind's mark that opens the source; ids in mono, cut in the middle. Renders
 * in server and client trees alike (no hooks).
 */

/** One mark per lineage kind, the noun's own where the product has one (`NOUN_ICONS`). */
export const LINEAGE_KIND_ICONS: Readonly<Record<string, LucideIcon>> = {
  trace: Activity,
  metric: Gauge,
  insight: CircleAlert,
  intent: MessageSquareText,
  task: ListChecks,
  fix: Hammer,
  experiment: FlaskConical,
  eval: ClipboardCheck,
  shipment: Rocket,
};

const PIN =
  "inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-line bg-raised px-1.5 text-xs text-fg-muted";
const PIN_LINK =
  "outline-none transition-colors duration-120 hover:border-line-strong hover:text-fg focus-visible:ring-2 focus-visible:ring-focus";

/** The ref as a pin: its mark, its noun, and its label (else its id, in mono). */
export function LineagePin({
  lineage,
  projectId,
  current = false,
}: {
  lineage: LineageRef;
  projectId: string;
  current?: boolean;
}) {
  const Icon = LINEAGE_KIND_ICONS[lineage.kind] ?? CircleAlert;
  const href = current ? null : hrefFor(lineage, projectId);
  const body = (
    <>
      <Icon aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0 text-fg-subtle" />
      <span className="shrink-0 text-fg-subtle">{KIND_NOUNS[lineage.kind] ?? lineage.kind}</span>
      {lineage.label ? (
        <span className="min-w-0 truncate text-fg">{lineage.label}</span>
      ) : (
        <span className="min-w-0 truncate font-mono text-fg" title={lineage.id}>
          {shortId(lineage.id)}
        </span>
      )}
    </>
  );
  return href ? (
    <Link href={href} className={cn(PIN, PIN_LINK)} data-lineage-kind={lineage.kind}>
      {body}
    </Link>
  ) : (
    <span
      className={PIN}
      data-lineage-kind={lineage.kind}
      aria-current={current ? "page" : undefined}
    >
      {body}
    </span>
  );
}

/**
 * "From <source>". With no source: `empty` when the page wants to say so
 * ("No insight linked yet"), else nothing.
 */
export function SourceLink({
  source,
  projectId,
  empty,
  className,
}: {
  source: LineageRef | null;
  projectId: string;
  empty?: string;
  className?: string;
}) {
  if (!source && !empty) return null;
  return (
    <p
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-fg-subtle",
        className,
      )}
      data-lineage-source={source ? source.kind : "none"}
    >
      {source ? (
        <>
          <span className="shrink-0">From</span>
          <LineagePin lineage={source} projectId={projectId} />
        </>
      ) : (
        <span>{empty}</span>
      )}
    </p>
  );
}

/**
 * The whole way back, oldest first, as a breadcrumb: trace › insight › fix ›
 * shipment. The last item is the object itself and does not link.
 */
export function LineageTrail({
  chain,
  projectId,
  className,
}: {
  chain: readonly LineageRef[];
  projectId: string;
  className?: string;
}) {
  if (chain.length < 2) return null;
  return (
    <nav aria-label="Where this came from" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 flex-wrap items-center gap-1">
        {chain.map((ref, index) => (
          <li key={`${ref.kind}:${ref.id}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? (
              <ChevronRight
                aria-hidden
                strokeWidth={1.5}
                className="size-3.5 shrink-0 text-fg-faint"
              />
            ) : null}
            <LineagePin lineage={ref} projectId={projectId} current={index === chain.length - 1} />
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The same walk as a vertical list, for a Panel (RC-71, a shipment's trail on
 * Ship): one row per step, oldest first, its stage beside it and a rule
 * joining them. Every step opens its page; the last is the object itself.
 */
export function LineageSteps({
  chain,
  projectId,
  className,
}: {
  chain: readonly LineageRef[];
  projectId: string;
  className?: string;
}) {
  if (chain.length === 0) return null;
  return (
    <nav aria-label="Where this came from" className={cn("min-w-0", className)}>
      <ol className="flex flex-col">
        {chain.map((ref, index) => {
          const last = index === chain.length - 1;
          return (
            <li
              key={`${ref.kind}:${ref.id}`}
              className="relative flex min-w-0 items-center gap-3 pb-3 last:pb-0"
              data-trail-step={ref.kind}
            >
              {last ? null : (
                <span
                  aria-hidden
                  className="absolute top-4 bottom-0 left-1 w-px -translate-x-1/2 bg-line"
                />
              )}
              <span
                aria-hidden
                className={cn(
                  "relative size-2 shrink-0 rounded-full",
                  last ? "bg-accent-mark" : "bg-fg-faint",
                )}
              />
              <span className="w-16 shrink-0 text-xs text-fg-subtle">
                {STAGE_LABELS[ref.stage]}
              </span>
              <LineagePin lineage={ref} projectId={projectId} current={last} />
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
