import { StatusDot } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { Tooltip } from "@ratel/design-system/tooltip";
import Link from "next/link";
import type { EvalBadge } from "@/lib/views/eval-gate/types";
import { badgeSentence, METHOD_WORDS, passLine, VERDICT_WORDS } from "@/lib/views/eval-gate/view";

/**
 * A fix's eval gate as one mark: the pass rate before and after on N of the
 * project's runs, its verdict as a dot and a word in the tooltip, and a link
 * to the runs. A fix never simulated says so. No state, no hooks.
 */
export function EvalBadgeValue({
  badge,
  href,
  className,
}: {
  badge: EvalBadge | undefined;
  href: string;
  className?: string;
}) {
  const current = badge ?? { state: "none" as const };
  const sentence = badgeSentence(current);
  const link = cn(
    "inline-flex min-w-0 items-center gap-2 rounded-md whitespace-nowrap outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus",
    className,
  );
  if (current.state === "none") {
    return (
      <Link
        href={href}
        prefetch={false}
        className={cn(link, "text-fg-faint")}
        data-eval-badge="none"
      >
        Not simulated
      </Link>
    );
  }
  if (current.state === "pending") {
    return (
      <Link href={href} prefetch={false} className={link} data-eval-badge="pending">
        <StatusDot tone="info" label="Simulating…" />
      </Link>
    );
  }
  if (current.state === "failed") {
    return (
      <Link href={href} prefetch={false} className={link} data-eval-badge="failed">
        <StatusDot tone="danger" label="Simulation failed" />
      </Link>
    );
  }
  if (current.verdict === "unsupported" || current.verdict === "unreliable") {
    return (
      <Link
        href={href}
        prefetch={false}
        className={cn(link, "text-fg-subtle")}
        data-eval-badge={current.verdict}
      >
        {VERDICT_WORDS[current.verdict].label}
      </Link>
    );
  }
  const words = VERDICT_WORDS[current.verdict];
  return (
    <Tooltip content={sentence}>
      <Link
        href={href}
        prefetch={false}
        className={link}
        data-eval-badge={current.verdict}
        aria-label={sentence}
      >
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[words.tone])} />
        <span className="text-fg tabular-nums">{passLine(current.before, current.after)}</span>
        <span className="text-xs text-fg-subtle tabular-nums">
          {current.runs} {current.runs === 1 ? "run" : "runs"}
          {current.method === "replay" || current.method === "mixed"
            ? ` · ${METHOD_WORDS[current.method]}`
            : ""}
          {current.stale ? " · edited" : ""}
        </span>
      </Link>
    </Tooltip>
  );
}

const DOT = {
  success: "bg-success",
  neutral: "bg-fg-faint",
  danger: "bg-danger",
  warning: "bg-warning",
} as const;
