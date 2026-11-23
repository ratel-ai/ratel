"use client";

import { Badge } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { Tooltip } from "@ratel/design-system/tooltip";
import { formatRelativeTime, formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import { visibleTools } from "@/lib/synthesis/traces/v2/runs";

/** Long enough that a cell will likely truncate it, so the full value gets a tooltip. */
const TRUNCATION_HINT = 56;

/** Relative in lists, absolute (UTC) in the tooltip (DESIGN.md, Time). */
export function RelativeTime({
  value,
  now,
  className,
}: {
  value: string;
  now: string;
  className?: string;
}) {
  return (
    <Tooltip content={formatTimestamp(value)}>
      <time
        dateTime={value}
        className={cn("whitespace-nowrap text-fg-muted tabular-nums", className)}
      >
        {formatRelativeTime(value, now)}
      </time>
    </Tooltip>
  );
}

/** One line that truncates; the full text shows in a tooltip when it may not fit. */
export function TruncatedText({ text, className }: { text: string; className?: string }) {
  const span = <span className={cn("block min-w-0 truncate", className)}>{text}</span>;
  return text.length > TRUNCATION_HINT ? (
    <Tooltip content={<span className="block max-w-96 whitespace-normal">{text}</span>}>
      {span}
    </Tooltip>
  ) : (
    span
  );
}

/** Up to three tools as badges, then a count. */
export function ToolBadges({ tools, max = 3 }: { tools: readonly string[]; max?: number }) {
  const { shown, more } = visibleTools(tools, max);
  if (shown.length === 0) return <span className="sr-only">No tools</span>;
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {shown.map((tool) => (
        <Badge key={tool} className="max-w-32 min-w-0">
          <span className="truncate">{tool}</span>
        </Badge>
      ))}
      {more > 0 ? (
        <Tooltip content={tools.slice(max).join(", ")}>
          <span className="shrink-0 text-xs text-fg-subtle tabular-nums">+{more}</span>
        </Tooltip>
      ) : null}
    </span>
  );
}
