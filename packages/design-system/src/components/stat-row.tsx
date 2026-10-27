import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { PeekLink } from "./panel";

export type StatDelta = {
  /** Already formatted and signed: "+12%", "-3 ms". */
  value: string;
  direction: "up" | "down" | "flat";
  /** Whether this direction is good for the reader; null keeps it neutral. */
  good: boolean | null;
  /** What the delta compares against: "vs previous 7 days". */
  label?: string;
};

export type StatProps = {
  label: string;
  /** Already formatted, abbreviated for stats ("12.4K", "$3.20"). */
  value: ReactNode;
  delta?: StatDelta;
  /** A quiet line under the value: a range, a unit, a denominator. */
  hint?: ReactNode;
  /** A small trend under the number (a Sparkline). */
  trend?: ReactNode;
  /** Makes the stat open its breakdown. */
  href?: string;
  /** Opens the breakdown in a Panel on this page (`?peek=<id>`) instead of navigating. */
  peek?: string;
};

/** 2 to 5 key numbers in one row (DESIGN.md, Numbers). */
export function StatRow({ stats, className }: { stats: readonly StatProps[]; className?: string }) {
  const columns =
    stats.length >= 5
      ? "lg:grid-cols-5"
      : stats.length === 4
        ? "lg:grid-cols-4"
        : stats.length === 3
          ? "lg:grid-cols-3"
          : "lg:grid-cols-2";
  return (
    <dl
      className={cn(
        // 1 px hairlines between cells at any column count: the gaps show the line color.
        "grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line",
        // An odd count leaves a hole on two columns; the last stat takes the row.
        "max-lg:[&>*:last-child:nth-child(odd)]:col-span-2",
        columns,
        className,
      )}
    >
      {stats.map((stat) => (
        <Stat key={stat.label} {...stat} />
      ))}
    </dl>
  );
}

const STRETCHED_LINK =
  "outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-focus focus-visible:after:ring-inset";

export function Stat({ label, value, delta, hint, trend, href, peek }: StatProps) {
  return (
    <div
      className={cn(
        "relative flex flex-col bg-app p-4",
        (href || peek) && "transition-colors duration-120 hover:bg-hover",
      )}
    >
      <dt className="text-xs font-medium text-fg-subtle">
        {/* The link stretches over the whole cell, so the stat is one target
            while the dt/dd structure stays valid. */}
        {href ? (
          <Link href={href} className={STRETCHED_LINK}>
            {label}
          </Link>
        ) : peek ? (
          <PeekLink peek={peek} className={STRETCHED_LINK}>
            {label}
          </PeekLink>
        ) : (
          label
        )}
      </dt>
      {/* min-w-0: a value given as a truncating element (a name) ends in an ellipsis instead of spilling out of the cell. */}
      <dd className="mt-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 text-2xl font-semibold tracking-tight text-fg tabular-nums">
          {value}
        </span>
        {delta ? <Delta {...delta} /> : null}
      </dd>
      {hint ? <dd className="mt-0.5 text-xs text-fg-subtle">{hint}</dd> : null}
      {trend ? <dd className="mt-3">{trend}</dd> : null}
    </div>
  );
}

function Delta({ value, direction, good, label }: StatDelta) {
  const Icon =
    direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : ArrowRight;
  const tone =
    good === null || direction === "flat"
      ? "text-fg-subtle"
      : good
        ? "text-success"
        : "text-danger";
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 text-xs font-medium tabular-nums", tone)}
      title={label}
    >
      <Icon className="size-3" aria-hidden />
      {value}
      {label ? <span className="sr-only"> {label}</span> : null}
    </span>
  );
}
